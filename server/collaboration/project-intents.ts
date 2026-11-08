import { requestsPullRequest } from './project-pulls.js';
import { randomUUID } from 'node:crypto';
import type { Conversation, Member, ProjectIntent, RoutingDecision, SendMessage, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { verifyWorkspace } from './workbench.js';

interface StoredIntent extends ProjectIntent {
  input: SendMessage;
  routing: RoutingDecision;
  originFence?: { sourceRevision: number; cancelRevision: number; inputRevision: number; cursor: number };
}
type IntentState = 'pending' | 'cancelled' | 'sent';

// This hint may ask for a folder. Only an explicit directory grant authorizes execution.
export function requestsProjectWork(content: string, members: Member[] = []) {
  if (/(?:不要(?:修改|改动|改|写入)|别(?:修改|改动)|仅讨论|只读|只讨论|先别动|\bdo not (?:edit|modify)\b)/i.test(content)) return false;
  let authorRequest = content;
  let discussionText = content;
  const handoff = /(?:完成|修复|测试通过)(?:之)?后[，,\s]*(?:再)?(?:请|让)\s*@?([^，。；：,;:!?！？\n@]{1,64}?)\s*(?:独立)?(?:评审|审查|复核)/iu.exec(content);
  if (handoff) {
    const peer = handoff[1]!.trim().toLowerCase();
    const namedReviewer = ['同伴','另一位成员'].includes(peer) || members.some(m =>
      [m.id, m.name, ...(m.aliases ?? [])].some(name => name.toLowerCase() === peer));
    if (namedReviewer) {
      // Only the author clause can request project access. An explanation requested
      // inside the peer's review is local to that sentence; later instructions still apply.
      authorRequest = content.slice(0, handoff.index);
      const review = content.slice(handoff.index + handoff[0].length);
      const end = review.search(/[。！？!?；;\n]|\.(?=\s|$)/u);
      discussionText = authorRequest + (end < 0 ? '' : review.slice(end));
    }
  }
  if (/(?:如何|怎样|怎么|为什么|解释|介绍|先分析|\b(?:how (?:do|can|would)|explain)\b)/i.test(discussionText)) return false;
  if (requestsPullRequest(authorRequest)) return true;
  if (!/(?:不要|别|无需|暂不)(?:运行|执行)|\b(?:do not|don't) run\b/i.test(authorRequest) &&
      /(?:项目|仓库|工作区|\b(?:project|repo|workspace)\b)/i.test(authorRequest) &&
      /(?:运行|执行|\brun\s+)(?:一下)?\s*[`'"]?(?:(?:node|git)\s+--version|(?:\/bin\/)?pwd)\b/i.test(authorRequest)) return true;
  if (/(?:推送|推到|推至|提交并推|\bgit\s+(?:push|commit)\b|\bpush\s+(?:to|the|my|this)\b)/i.test(authorRequest) &&
      !/(?:不要|无需|别|暂不|勿).{0,12}(?:推送|推到|提交)|\b(?:do not|don.t) (?:push|commit)/i.test(authorRequest)) return true;
  if (/(?:跑(?:一下|一遍|全部|通)?测试|运行.{0,8}(?:测试|命令|脚本)|\brun (?:the |all )?(?:tests?|pytest|npm)\b)/i.test(authorRequest)) return true;
  const modifies = /(?:修复|修好|改掉|改一下|编辑|修改|重构|实现|新增|新建|创建|写入|复制|拷贝|写个|写一个|生成|整理|导出|另存|保存(?:到|至)|补(?:一个|上|充)|\b(?:fix|implement|refactor|edit|update|create|copy|write|export|save|generate)\b)/i;
  const projectObject = /(?:源码|代码|文件|目录|项目|仓库|脚本|程序|函数|组件|用例|测试|缺陷|月报|流水|对账|\b(?:file|directory|folder|repo|repository|source|code|script|function|component|test|bug|report|csv)\b|[\w-]+\.(?:tsx?|jsx?|py|rs|go|java|md|csv|json|ya?ml|txt)\b)/i;
  return modifies.test(authorRequest) && projectObject.test(authorRequest);
}

export class ProjectIntents {
  constructor(private readonly store: CollaborationStore) {}
  private get port() { return this.store.artifacts.port; }

  private read(id: string) {
    const row = this.store.db.prepare('SELECT state,value FROM cc_project_intents WHERE id=?').get(id) as { state: IntentState; value: string } | undefined;
    return row && { state: row.state, intent: JSON.parse(row.value) as StoredIntent };
  }
  private summary({ id, conversationId, content, memberIds, revision, createdAt, origin }: StoredIntent): ProjectIntent {
    return { id, conversationId, content, memberIds, revision, createdAt, ...(origin ? { origin } : {}) };
  }
  pending(cid: string): ProjectIntent[] {
    const rows = this.store.db.prepare("SELECT value FROM cc_project_intents WHERE conversation_id=? AND state='pending' ORDER BY rowid").all(cid) as { value: string }[];
    return rows.map(row => this.summary(JSON.parse(row.value)));
  }
  requirePending(cid: string, id: unknown, revision?: unknown): StoredIntent {
    const row = typeof id === 'string' ? this.read(id) : undefined;
    if (!row || row.intent.conversationId !== cid) throw new AppError(404, '找不到此会话的项目委托。');
    if (row.state !== 'pending' || (revision !== undefined && revision !== row.intent.revision)) throw new AppError(409, '这条委托已经处理或发生变化，请刷新会话。');
    return row.intent;
  }
  private assertAvailable(targets: string[], grant?: WorkspaceGrant) {
    for (const target of targets) {
      const capability = this.store.workbench.projectCapability(target, grant);
      if (!capability.available) throw new AppError(409, capability.reason || '此成员的项目执行能力尚不可用。', 'project_work_unavailable');
    }
  }
  private authorized(c: Conversation, grant: WorkspaceGrant | undefined, targets: string[]) {
    return grant?.mode === 'project-work' && grant.conversationId === c.id && targets.every(t =>
      grant.memberIds?.includes(t) && typeof grant.memberBindings?.[t] === 'string' && grant.memberBindings[t] === this.store.workbench.projectMemberBinding(t));
  }

  private save(intent: StoredIntent) {
    if (this.pending(intent.conversationId).length >= 20) throw new AppError(409, '请先处理会话中等待选择项目的委托。');
    this.store.db.prepare('INSERT INTO cc_project_intents VALUES(?,?,?,?)').run(intent.id, intent.conversationId, 'pending', JSON.stringify(intent));
    this.port.event(intent.conversationId, 'project.intent_waiting', { intentId: intent.id, memberIds: intent.memberIds, origin: intent.origin });
    return { intent: this.summary(intent) };
  }

  propose(invocationId: string, args: Record<string, unknown>, callId: string) {
    return this.port.tx(() => {
      this.store.visibility.assertTool(invocationId, 'project_work_propose');
      const i = this.store.invocation(invocationId), contract = this.store.contract(i.id);
      if (i.status !== 'running' || i.acceptance !== 'accepted' || contract.toolPolicyVersion !== 'cross-action-v1' || !contract.mayProposeProject || contract.projectWork || contract.visibility) {
        throw new AppError(403, '仅已接受的普通公开咨询可以提议项目后续工作。');
      }
      const source = this.store.visibility.primary(i.id), response = this.store.response(i.responseId);
      this.store.visibility.validateInvocation(i.id);
      if (!callId || source.kind !== 'user' || source.visibility || source.withdrawnAt || source.projectConsultation ||
          this.store.detail(i.conversationId).consumptions.some(c => c.responseId === i.responseId && c.sourceId !== source.id)) {
        throw new AppError(409, '提议需要准确、单一且仍可用的公开委托。');
      }
      const step = args.nextStep;
      if (Object.keys(args).length !== 1 || typeof step !== 'string' || !step.trim() || step.length > 2000 || step.trim() === source.content.trim()) {
        throw new AppError(400, '请只描述根据当前进展还需完成的下一步。');
      }
      const nextStep = step.trim();
      // Repeating the same proposal returns its original receipt, including if the user dismissed it.
      return this.port.command('project-followup:' + i.id, { nextStep, sourceRevision: source.revision, inputRevision: response.inputRevision }, () => {
        const origin = { invocationId: i.id, sourceId: source.id, responseId: i.responseId, memberId: i.memberId };
        const routing = { id: randomUUID(), targets: [i.memberId], reason: 'accepted_followup', policyVersion: 'project-followup-v1',
          historyCursor: contract.historyCutoff, configurationRevision: this.store.configurationRevision() };
        const saved = this.save({ id: randomUUID(), conversationId: i.conversationId, revision: 1, content: nextStep, createdAt: now(),
          memberIds: [i.memberId], routing, input: { content: nextStep, requestId: randomUUID(), deliveryMode: 'next_turn' }, origin,
          originFence: { sourceRevision: source.revision, cancelRevision: i.cancelRevision ?? 0, inputRevision: response.inputRevision, cursor: this.store.cursor() } });
        return { intentId: saved.intent.id, origin, awaitingUser: true };
      }).result;
    });
  }

  private checkOrigin(intent: StoredIntent) {
    if (!intent.origin) return;
    const origin = intent.origin, fence = intent.originFence;
    const i = this.store.invocation(origin.invocationId), source = this.store.visibility.primary(i.id), response = this.store.response(i.responseId);
    this.store.visibility.validateInvocation(i.id);
    if (!fence || i.conversationId !== intent.conversationId || i.memberId !== origin.memberId || i.responseId !== origin.responseId ||
        !['succeeded', 'failed'].includes(i.status) || i.teardown !== 'confirmed' || i.acceptance !== 'accepted' ||
        (i.cancelRevision ?? 0) !== fence.cancelRevision || response.inputRevision !== fence.inputRevision ||
        source.id !== origin.sourceId || source.revision !== fence.sourceRevision || source.visibility || source.withdrawnAt ||
        this.store.db.prepare("SELECT 1 FROM cc_events WHERE conversation_id=? AND id>? AND type='workspace.revoked' LIMIT 1").get(intent.conversationId, fence.cursor)) {
      throw new AppError(409, '原执行尚未确认退出，或其来源、权限已经变化。请核对原执行。');
    }
  }

  private followsCompletedWork(c: Conversation, targets: string[]) {
    if (targets.length !== 1 || c.workspaceGrant?.mode !== 'project-work') return false;
    const detail = this.store.detail(c.id);
    const last = detail.messages.findLast(message => message.author === 'user');
    const source = last && detail.sources.find(row => row.id === last.sourceId);
    if (!source?.projectWork || source.withdrawnAt || source.visibility || source.requestedTargets.length !== 1 ||
        source.requestedTargets[0] !== targets[0] || source.projectGrantRevision !== c.workspaceGrant.revision) return false;
    const delivery = detail.deliveries.find(d => d.sourceId === source.id && d.memberId === targets[0]);
    return !!delivery?.responseId && detail.invocations.some(i => i.responseId === delivery.responseId &&
      i.status === 'succeeded' && i.acceptance === 'accepted' && i.teardown === 'confirmed');
  }

  submit(cid: string, input: SendMessage) {
    // N6 may append a public work request only to an active turn with matching project access.
    const conversation = this.store.workbench.conversation(cid);
    const participants = this.store.members().filter(member => conversation.memberIds.includes(member.id) && member.enabled && !member.deletedAt);
    const explicitWork = requestsProjectWork(input.content, participants);
    const continuation = !input.replyTo && !input.attachmentIds?.length &&
      /^(?:@[^@，,。!！\n]{1,60}?[\s，,]+)?(?:请)?(?:继续(?:做|实施|修改|上次的工作)?|接着(?:做|改|上次的工作)|沿用上次(?:的)?约定继续|continue(?: the previous work)?)[。！.!\s]*$/i.test(input.content.trim());
    const publicWork = !input.privateTo && !input.excerptRefs && !input.excerptTargets && !input.resolveWhenIdle &&
      (explicitWork || continuation);
    if (!publicWork) {
      if (this.store.db.prepare('SELECT 1 FROM cc_commands WHERE request_id=?').get('project-submit:' + input.requestId)) throw new AppError(409, '此请求标识已用于另一条项目委托。', 'idempotency_conflict');
      return this.store.send(cid, input);
    }
    return this.port.tx(() => {
      const c = this.store.workbench.conversation(cid);
      // Includes ordinary messages committed by older versions. Never turn a replay into a new intent.
      if (this.store.db.prepare('SELECT 1 FROM cc_commands WHERE request_id=?').get('message:' + input.requestId)) return this.store.send(cid, input);
      const result = this.port.command('project-submit:' + input.requestId, { cid, input }, () => {
        if (c.importedFor || this.store.visibility.validateSend(cid, input)) return this.store.send(cid, input);
        this.store.workbench.compose(cid, input);
        let routing: RoutingDecision;
        try { routing = this.store.previewRoute(cid, input.content); }
        catch (e) { if (e instanceof AppError && e.code === 'no_routable_member') return this.store.send(cid, input); throw e; }
        const targets = routing.targets;
        if (!explicitWork && (!this.followsCompletedWork(c,targets) || !this.authorized(c,c.workspaceGrant,targets))) return this.store.send(cid,input);
        if (!targets.some(t => this.store.members().some(m => m.id === t && (m.carrier === 'claude-cli' || m.carrier === 'codex-app-server')))) return this.store.send(cid, input);
        if (this.authorized(c, c.workspaceGrant, targets) && targets.every(t => this.store.workbench.projectCapability(t, c.workspaceGrant).available)) {
          verifyWorkspace(c.workspaceGrant!);
          return this.store.send(cid, input, { routing, work: true });
        }
        const intent: StoredIntent = { id: randomUUID(), conversationId: cid, revision: 1, content: input.content, createdAt: now(), memberIds: targets, input, routing };
        return this.save(intent);
      });
      if ('intent' in result.result && result.replayed && this.read(result.result.intent.id)?.state === 'cancelled') {
        return { intent: { ...result.result.intent, state: 'cancelled' as const } };
      }
      return result.result;
    });
  }

  continue(cid: string, id: string, revision: number, work: boolean) {
    const intent = this.requirePending(cid, id, revision);
    this.checkOrigin(intent);
    const c = this.store.workbench.conversation(cid);
    if (c.archivedAt || c.deletedAt || c.importedFor || this.store.visibility.validateSend(cid, intent.input)) throw new AppError(409, '此会话的可见范围或状态已变化，请重新提交委托。');
    if (!intent.memberIds.every(t => c.memberIds.includes(t) && this.store.members().some(m => m.id === t && m.enabled && !m.deletedAt))) throw new AppError(409, '原委托目标已不可用，请取消并重新选择成员。');
    if (work) {
      if (!this.authorized(c, c.workspaceGrant, intent.memberIds)) throw new AppError(409, '项目授权未覆盖原委托的全部目标。');
      this.assertAvailable(intent.memberIds, c.workspaceGrant);
      verifyWorkspace(c.workspaceGrant!);
    }
    const delivery = this.store.send(cid, intent.input, { routing: intent.routing, work, origin: intent.origin });
    this.store.db.prepare("UPDATE cc_project_intents SET state='sent' WHERE id=?").run(id);
    this.port.event(cid, 'project.intent_sent', { intentId: id, sourceId: delivery.source.id, work });
    return delivery;
  }

  resolve(cid: string, id: string, action: 'cancel' | 'consult', expected: number, requestId: string) {
    return this.port.tx(() => this.port.command('project-resolution:' + requestId, { cid, id, action, expected }, () => {
      this.requirePending(cid, id, expected);
      if (action === 'consult') return this.continue(cid, id, expected, false);
      this.store.db.prepare("UPDATE cc_project_intents SET state='cancelled' WHERE id=?").run(id);
      this.port.event(cid, 'project.intent_cancelled', { intentId: id });
      return { cancelled: true };
    }));
  }
}
