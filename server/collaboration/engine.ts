import type { CollaborationInvocation, CollaborationRuntime, RuntimeEvent, RecoveryRequest, RuntimeInspection } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import { CollaborationStore } from './store.js';

/** Provider work happens outside SQLite; the exact persisted invocation is always retained. */
export class CollaborationEngine {
  private started = false;
  private stopping = false;
  private draining = false;
  private timer?: ReturnType<typeof setInterval>;
  private executions = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(readonly store: CollaborationStore, readonly runtime: CollaborationRuntime, readonly options: { workspace: string; maxDepth?: number }) {}
  start(): void {
    if (this.started) return;
    this.store.recover(); this.started = true; this.stopping = false;
    this.timer = setInterval(() => this.kick(), 500); this.timer.unref(); this.kick();
  }
  kick(): void {
    if (!this.started || this.stopping || this.draining) return;
    this.draining = true;
    try {
      // Recover the durable human stop intent even if HTTP disconnected before aborting the adapter.
      for (const id of this.store.tasks.pendingStops()) this.cancel(id);
      for (const invocation of this.store.invocations().filter(i => i.status === 'prepared' && !i.dispatchStarted && !i.blockedReason)) this.launch(invocation);
      // A scan admits one source group. Independent groups may run simultaneously.
      for (let count = 0; count < 100 && this.executions.size < 64; count++) {
        const admitted = this.store.admitNext(); if (!admitted) break;
        for (const invocation of admitted.invocations) this.launch(invocation);
      }
    } catch { /* Lease/storage loss does not authorize resending; durable state remains recoverable. */ }
    finally { this.draining = false; }
  }
  private launch(invocation: CollaborationInvocation): void {
    if (this.executions.has(invocation.id)) return;
    const controller = new AbortController();
    // Register before running async provider/callbacks, including synchronous fake runtimes.
    const done = Promise.resolve().then(() => this.execute(invocation, controller)).finally(() => { this.executions.delete(invocation.id); this.kick(); });
    this.executions.set(invocation.id, { controller, done });
  }
  private sanitize(value: string, accountId?: string): string {
    let result = value;
    for (const account of this.store.accounts()) {
      if (accountId && account.id !== accountId) continue;
      const secret = account.apiKeyEnv && process.env[account.apiKeyEnv];
      if (secret) result = result.split(secret).join('[redacted]');
    }
    return result;
  }
  private async execute(invocation: CollaborationInvocation, controller: AbortController): Promise<void> {
    let snapshotSecret = '';
    const redact = (text: string) => this.sanitize(snapshotSecret ? text.split(snapshotSecret).join('[redacted]') : text);
    try {
      this.store.prepareInput(invocation.id);
      const frozen = this.store.contract(invocation.id);
      const identity = frozen.adapterCapabilityVersion === 'native-continuity-v1' && this.runtime.sessionIdentity
        ? await this.runtime.sessionIdentity({ member: frozen.memberSnapshot, account: frozen.accountMetadataSnapshot, cwd: frozen.workspaceScope || this.options.workspace })
        : { supported: false, reason: '承载未提供原生会话身份探测，保留新建行为。' };
      this.store.prepareSession(invocation.id, identity);
      const i = this.store.startInvocation(invocation.id);
      const account = this.store.accountFor(i.id);
      snapshotSecret = (account.apiKeyEnv && process.env[account.apiKeyEnv]) || '';
      const onEvent = (event: RuntimeEvent) => {
        const safe = JSON.parse(redact(JSON.stringify(event))) as RuntimeEvent;
        this.store.recordEvidence(i.id, safe);
      };
      onEvent({ kind: 'prepared', detail: { source: 'platform', responseId: i.responseId } });
      const prompt = this.store.prompt(i.id);
      const input = this.store.input(i.id)!; const contract = this.store.contract(i.id);
      onEvent({ kind: 'exposed', detail: { source: 'platform_prompt', characters: prompt.length, manifestId: input.manifest.id, renderDigest: input.manifest.renderDigest, providerAcceptance: false } });
      const result = await this.runtime.invoke({ invocationId: i.id, conversationId: i.conversationId, member: i.member, account, prompt, toolPolicyVersion: contract.toolPolicyVersion, sessionPlan: i.sessionPlan, nativeSessionId: i.sessionPlan?.nativeSessionId, cwd: contract.workspaceScope || this.options.workspace, signal: controller.signal, onEvent,
        onToolCall: async (name, args, callId) => {
          const current = this.store.invocation(i.id); if (current.status !== 'running' || controller.signal.aborted) throw new AppError(409, 'Invocation no longer accepts callbacks.');
          if (name.startsWith('task_')) { const result = this.store.tasks.tool(i.id, name, JSON.parse(redact(JSON.stringify(args))), callId); this.kick(); return result; }
          if (name !== 'collaboration_request') throw new AppError(400, 'Unsupported collaboration tool.');
          const content = typeof args.content === 'string' ? redact(args.content) : '';
          const admitted = this.store.requestCollaboration(i.id, callId, { targets: args.targets as string[], content }, this.options.maxDepth);
          this.kick(); return admitted;
        },
      });
      if (result.nativeSessionId) onEvent({ kind: 'session', detail: { nativeSessionId: result.nativeSessionId, nativeTurnId: result.nativeTurnId, continuity: result.continuity } });
      this.store.finish(i.id, this.stopping ? 'interrupted' : 'succeeded', this.stopping ? '服务停止，执行结果等待核查。' : redact(result.text), undefined, this.options.maxDepth);
    } catch (error) {
      try {
        const current = this.store.invocation(invocation.id);
        if (!current.dispatchStarted && error instanceof AppError && error.code === 'contract_not_supported') { this.store.blockInvocation(current.id, error.message); return; }
        if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(current.status)) return;
        if (!current.dispatchStarted) {
          this.store.recordEvidence(current.id, { kind: 'not_accepted', detail: { reason: '平台输入准备失败，尚未调用承载。' } });
          this.store.recordEvidence(current.id, { kind: 'transport_settled', detail: { confirmed: true, scope: 'platform_preflight', reason: 'No runtime invocation started.' } });
        }
        const status = this.stopping ? 'interrupted' : current.status === 'cancel_requested' ? 'cancelled' : 'failed';
        this.store.finish(current.id, status, redact(error instanceof Error ? error.message : '运行时执行失败。').slice(0, 3000), undefined, this.options.maxDepth);
      } catch { /* Preserve exact invocation when storage/lease ownership is unavailable. */ }
    }
  }
  async reconcile(invocationId: string, input: RecoveryRequest) {
    const replay = this.store.recoveryReplay(invocationId, input); if (replay) return replay;
    const i = this.store.invocation(invocationId); const account = this.store.accountFor(i.id);
    const unsupported = (reason: string): RuntimeInspection => ({ invocationId, carrier: i.member.carrier, state: 'unsupported', acceptance: 'unknown', teardown: 'unknown', reason, observedAt: new Date().toISOString(), evidence: [] });
    let observation: RuntimeInspection;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      observation = this.runtime.inspect ? await Promise.race([
        this.runtime.inspect({ invocationId, conversationId: i.conversationId, member: i.member, account, nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId, workspaceScope: this.store.contract(i.id).workspaceScope || this.options.workspace }),
        new Promise<RuntimeInspection>(resolve => { timer = setTimeout(() => resolve(unsupported('承载核查超时；接受与退出仍保持未知。')), 5000); timer.unref(); }),
      ]) : unsupported('此承载没有可用的准确核查接口；已保存事实保留，不会自动重发。');
    } catch { observation = unsupported('承载核查暂不可用；未获得新的接受或退出证据。'); }
    finally { if (timer) clearTimeout(timer); }
    const secret = account.apiKeyEnv && process.env[account.apiKeyEnv];
    let serialized = JSON.stringify(observation); if (secret) serialized = serialized.split(secret).join('[redacted]');
    const result = this.store.resolveRecovery(invocationId, input, JSON.parse(this.sanitize(serialized)) as RuntimeInspection); this.kick(); return result;
  }
  cancel(invocationId: string): void { this.store.cancel(invocationId); this.executions.get(invocationId)?.controller.abort(new Error('User requested cancellation.')); this.kick(); }
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true; if (this.timer) clearInterval(this.timer);
    for (const item of this.executions.values()) item.controller.abort(new Error('Service stopping.'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.executions.values()].map(e => e.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
    if (timer) clearTimeout(timer);
    // A non-cooperative adapter is quarantined, never assumed stopped.
    for (const i of this.store.invocations()) if (['running', 'cancel_requested'].includes(i.status)) { try { this.store.finish(i.id, 'interrupted', '服务停止，承载退出状态未知；不会自动重发。'); } catch { /* Preserve for recovery. */ } }
  }
}
