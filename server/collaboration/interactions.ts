import { randomUUID } from 'node:crypto';
import type { CollaborationResponse, InteractionQuestion, NativeInteractionRequest, RuntimeInteraction } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';
import { validNativeCommand } from './native-command-approval.js';
import { nativePermissionAlternative } from './native-permission-target.js';
import { discoverableProjectPath } from './project-file-read.js';
import { ArtifactService, stringField } from './artifacts.js';

export class InteractionService {
  constructor(readonly artifacts: ArtifactService, private readonly nativeFilePermission?: (id:string) => boolean, private readonly gitPermission?: (id:string)=>boolean) {}
  private get port() { return this.artifacts.port; }
  list(conversationId?: string) { return this.artifacts.rows<RuntimeInteraction>('cc_runtime_interactions', conversationId); }
  get(id: string) { return this.artifacts.get<RuntimeInteraction>('cc_runtime_interactions', id); }
  private save(i: RuntimeInteraction) { i.revision++; this.artifacts.save('cc_runtime_interactions', i, 'interaction.changed'); }
  private active(i: RuntimeInteraction): boolean {
    try {
      const run = this.port.invocation(i.invocationId), o = this.artifacts.origin(i.conversationId, run.id, undefined, true);
      if (i.gitDelivery && !this.gitPermission?.(i.invocationId)) return false;
      if ((i.fileChange || i.nativeCommand) && !this.nativeFilePermission?.(i.invocationId)) return false;
      return o.actor.kind === 'agent' && o.actor.sourceId === i.sourceId && o.actor.sourceRevision === i.sourceRevision && o.actor.cancelRevision === i.cancelRevision && o.inputRevision === i.inputRevision && (!i.nativeSessionId || run.nativeSessionId === i.nativeSessionId) && (!i.nativeTurnId || run.nativeTurnId === i.nativeTurnId);
    } catch { return false; }
  }
  sweep() {
    this.port.tx(() => {
      for (const i of this.list()) if (i.state === 'pending' || (i.state === 'answered' && i.delivery === 'not_sent')) {
        if (!this.active(i)) { i.state = 'cancelled'; i.reason = '准确执行或来源已失效。'; this.save(i); }
        else if (Date.parse(i.expiresAt) <= Date.now()) { i.state = 'expired'; i.reason = i.fileChange || i.nativeCommand ? '本次操作审批已超时。' : '问题已超时。'; this.save(i); }
      }
    });
  }
  create(invocationId: string, request: NativeInteractionRequest, transport: RuntimeInteraction['transport']) {
    return this.port.tx(() => {
      const run = this.port.invocation(invocationId), o = this.artifacts.origin(run.conversationId, run.id, undefined, true);
      if (o.actor.kind !== 'agent') throw new AppError(409, '缺少准确执行身份。');
      stringField(request.providerRequestId, '承载请求标识');
      const payloadDigest = digest(request), existing = this.list().find(i => i.invocationId === invocationId && i.transport === transport && i.providerRequestId === request.providerRequestId);
      if (existing) { if (existing.payloadDigest !== payloadDigest) throw new AppError(409, '同一交互请求的参数发生变化。'); return existing; }
      if (request.kind === 'question') {
        const qs = request.questions;
        if (!Array.isArray(qs) || qs.length < 1 || qs.length > 3 || new Set(qs.map(q => q.id)).size !== qs.length) throw new AppError(400, '需要 1–3 个不同标识的问题。');
        for (const q of qs) { stringField(q.id, '问题标识', 100); if (['__proto__', 'constructor', 'prototype'].includes(q.id)) throw new AppError(400, '问题标识无效。'); stringField(q.question, '问题', 2000); if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 6 || q.options.some(x => typeof x !== 'string' || !x.trim() || x.length > 500))) throw new AppError(400, '选项无效。'); }
      }
      const git = request.gitDelivery;
      if (git && (transport !== 'project-git' || request.operation !== 'project_git_deliver' || request.kind !== 'approval' ||
          !request.nativeItemId || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/.test(git.remote) ||
          ![git.commit,git.parent,git.local].every(x=>/^[a-f0-9]{40}$/.test(x)) || !git.files.every(discoverableProjectPath))) {
        throw new AppError(400,'无法核对此次 Git 交付。');
      }
      const change = request.fileChange;
      const command = request.nativeCommand;
      const managed = transport === 'project-check' && request.operation === 'project_environment_check' && run.member.carrier === 'codex-app-server' &&
        command?.cwd === '/work' && ['pwd','git --version','node --version'].includes(command.command);
      const native = command && validNativeCommand(command,transport) &&
        run.member.carrier === 'claude-cli' && request.operation === 'can_use_tool/Bash';
      if (command && (change || !request.nativeSessionId || !request.nativeTurnId || !request.nativeItemId || request.kind !== 'approval' || !(managed || native))) {
        throw new AppError(400,'无法核对此次原生命令。');
      }
      if (change && (transport !== (run.member.carrier === 'claude-cli' ? 'claude' : 'codex') || request.kind !== 'approval' || !request.nativeSessionId || !request.nativeItemId || !request.nativeTurnId ||
          !discoverableProjectPath(change.path) || typeof change.preview !== 'string' || Buffer.byteLength(change.preview) > 8000 ||
          !(transport === 'codex' && request.operation === 'item/fileChange/requestApproval' && ['create','patch'].includes(change.action) ||
            transport === 'claude' && request.operation === 'can_use_tool/Write' && change.action === 'write'))) {
        throw new AppError(400,'无法核对此次原生文件操作。');
      }
      const maxBytes = transport === 'project-npm' || transport === 'project-git' ? 384 * 1024 : 20000;
      if (Buffer.byteLength(JSON.stringify(request)) > maxBytes) throw new AppError(400, '交互参数过大。');
      const r = this.artifacts.get<CollaborationResponse>('cc_responses', run.responseId);
      const secretQuestion = transport === 'codex' && Array.isArray(request.payload.questions) && request.payload.questions.some(q => q && typeof q === 'object' && (q as Record<string, unknown>).isSecret === true);
      const interaction: RuntimeInteraction = { ...request, id: randomUUID(), conversationId: run.conversationId, invocationId, memberId: run.memberId, sourceId: o.actor.sourceId, sourceRevision: o.actor.sourceRevision, inputRevision: r.inputRevision, cancelRevision: o.actor.cancelRevision, payloadDigest, revision: 0, state: request.kind === 'question' || change || command || git ? 'pending' : 'unsupported', transport, createdAt: now(), expiresAt: new Date(Date.now() + 120000).toISOString(), delivery: 'not_sent', ...(request.kind !== 'question' && !change && !command && !git ? { reason: request.payload.reasonCode === 'file_unavailable' ? '当前文件或上级目录已变化，无法核对这次修改。请让成员重新读取目标并提出新的文件操作。' : nativePermissionAlternative(request.operation,typeof request.payload.target === 'string' ? request.payload.target : undefined) } : {}) };
      if (!this.active(interaction)) throw new AppError(409, '原生会话或轮次不匹配。');
      if (secretQuestion) { interaction.state = 'unsupported'; interaction.reason = '当前问答不收集原生秘密字段，请在承载官方登录界面完成认证。'; }
      this.save(interaction); return interaction;
    });
  }
  answer(id: string, input: Record<string, unknown>) {
    this.sweep();
    return this.port.tx(() => {
      const out = this.port.command(`interaction-answer:${id}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const i = this.get(id);
        if (i.state !== 'pending' || i.revision !== input.expectedRevision || i.payloadDigest !== input.payloadDigest || !this.active(i)) throw new AppError(409, '交互已失效或参数修订变化。');
        if (i.fileChange || i.nativeCommand || i.gitDelivery) {
          if (Object.keys(input).some(k => !['requestId','payloadDigest','expectedRevision','decision'].includes(k)) ||
              !['allow_once','decline','cancel'].includes(String(input.decision))) throw new AppError(400,'请选择此次操作的处理方式。');
          i.state = input.decision === 'allow_once' ? 'answered' : input.decision === 'decline' ? 'declined' : 'cancelled';
          if (input.decision === 'cancel') { i.cancelledByUser = true; i.reason = '已请求停止本轮执行。'; }
        } else if (input.decline === true) i.state = 'declined';
        else {
          const answers = input.answers;
          if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length !== i.questions!.length) throw new AppError(400, '需要回答本次所有问题。');
          i.answers = {};
          for (const q of i.questions!) i.answers[q.id] = stringField((answers as Record<string, unknown>)[q.id], '答案', 2000);
          i.state = 'answered';
        }
        this.save(i); return { interaction: i };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  canReturn(invocationId:string,id:string,thread:string,turn:string,item:string) {
    const i = this.list().find(i => i.invocationId === invocationId && (i.fileChange || i.nativeCommand) && i.providerRequestId === id);
    return !!i && i.state === 'answered' && i.delivery === 'returned_to_adapter' &&
      i.nativeSessionId === thread && i.nativeTurnId === turn && i.nativeItemId === item &&
      Date.parse(i.expiresAt) > Date.now() && this.active(i);
  }
  revokeReturn(invocationId:string,id:string) {
    this.port.tx(() => {
      const i = this.list().find(i => i.invocationId === invocationId && (i.fileChange || i.nativeCommand) && i.providerRequestId === id);
      if (i?.state === 'answered') {
        i.state = 'cancelled'; i.reason = '文件、原生请求或项目授权已变化，已撤回此次允许。'; this.save(i);
      }
    });
  }
  resolved(invocationId: string, providerRequestId: string) {
    this.port.tx(() => { for (const i of this.list().filter(i => (i.transport === 'codex' || i.transport === 'claude') && i.invocationId === invocationId && i.providerRequestId === providerRequestId && (i.state === 'pending' || (i.state === 'answered' && i.delivery === 'not_sent')))) { i.state = 'cancelled'; i.reason = '原生承载已关闭此请求。'; this.save(i); } });
  }
  async wait(invocationId: string, request: NativeInteractionRequest, transport: RuntimeInteraction['transport'], signal: AbortSignal) {
    const created = this.create(invocationId, request, transport);
    for (;;) {
      this.sweep(); let i = this.get(created.id);
      if (signal.aborted && (i.state === 'pending' || i.state === 'answered' && i.delivery === 'not_sent')) { this.port.tx(() => { i.state = 'cancelled'; i.reason = '当前执行已停止。'; this.save(i); }); }
      i = this.get(created.id);
      if (i.state !== 'pending') {
        // A replay cannot deliver a previously returned answer to another native callback.
        if (i.delivery !== 'not_sent') return { state: 'cancelled' as const };
        this.port.tx(() => { i.delivery = 'returned_to_adapter'; this.save(i); });
        return { state: i.state, ...(i.cancelledByUser ? {cancelledByUser:true as const} : {}), ...(i.state === 'answered' ? { answers: i.answers } : {}) };
      }
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 100); signal.addEventListener('abort', done, { once: true }); });
    }
  }
  tool(invocationId: string, args: Record<string, unknown>, callId: string, signal: AbortSignal) {
    if (Object.keys(args).some(k => k !== 'questions')) throw new AppError(400, '提问只接受 questions，身份由执行绑定。');
    return this.wait(invocationId, { providerRequestId: callId, kind: 'question', operation: 'user_question', questions: args.questions as InteractionQuestion[], payload: args }, 'platform', signal);
  }
}
