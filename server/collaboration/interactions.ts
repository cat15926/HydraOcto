import { randomUUID } from 'node:crypto';
import type { CollaborationResponse, InteractionQuestion, NativeInteractionRequest, RuntimeInteraction } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';
import { ArtifactService, stringField } from './artifacts.js';

export class InteractionService {
  constructor(readonly artifacts: ArtifactService) {}
  private get port() { return this.artifacts.port; }
  list(conversationId?: string) { return this.artifacts.rows<RuntimeInteraction>('cc_runtime_interactions', conversationId); }
  get(id: string) { return this.artifacts.get<RuntimeInteraction>('cc_runtime_interactions', id); }
  private save(i: RuntimeInteraction) { i.revision++; this.artifacts.save('cc_runtime_interactions', i, 'interaction.changed'); }
  private active(i: RuntimeInteraction): boolean {
    try {
      const run = this.port.invocation(i.invocationId), o = this.artifacts.origin(i.conversationId, run.id, undefined, true);
      return o.actor.kind === 'agent' && o.actor.sourceId === i.sourceId && o.actor.sourceRevision === i.sourceRevision && o.actor.cancelRevision === i.cancelRevision && o.inputRevision === i.inputRevision && (!i.nativeSessionId || run.nativeSessionId === i.nativeSessionId) && (!i.nativeTurnId || run.nativeTurnId === i.nativeTurnId);
    } catch { return false; }
  }
  sweep() {
    this.port.tx(() => {
      for (const i of this.list()) if (i.state === 'pending' || (i.state === 'answered' && i.delivery === 'not_sent')) {
        if (!this.active(i)) { i.state = 'cancelled'; i.reason = '准确执行或来源已失效。'; this.save(i); }
        else if (Date.parse(i.expiresAt) <= Date.now()) { i.state = 'expired'; i.reason = '问题已超时。'; this.save(i); }
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
      if (Buffer.byteLength(JSON.stringify(request)) > 20000) throw new AppError(400, '交互参数过大。');
      const r = this.artifacts.get<CollaborationResponse>('cc_responses', run.responseId);
      const secretQuestion = transport === 'codex' && Array.isArray(request.payload.questions) && request.payload.questions.some(q => q && typeof q === 'object' && (q as Record<string, unknown>).isSecret === true);
      const interaction: RuntimeInteraction = { ...request, id: randomUUID(), conversationId: run.conversationId, invocationId, memberId: run.memberId, sourceId: o.actor.sourceId, sourceRevision: o.actor.sourceRevision, inputRevision: r.inputRevision, cancelRevision: o.actor.cancelRevision, payloadDigest, revision: 0, state: request.kind === 'question' ? 'pending' : 'unsupported', transport, createdAt: now(), expiresAt: new Date(Date.now() + 120000).toISOString(), delivery: 'not_sent', ...(request.kind !== 'question' ? { reason: '当前只读承载不授予原生命令、文件或外部工具权限。' } : {}) };
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
        if (input.decline === true) i.state = 'declined';
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
  resolved(invocationId: string, providerRequestId: string) {
    this.port.tx(() => { for (const i of this.list().filter(i => i.transport === 'codex' && i.invocationId === invocationId && i.providerRequestId === providerRequestId && (i.state === 'pending' || (i.state === 'answered' && i.delivery === 'not_sent')))) { i.state = 'cancelled'; i.reason = '原生承载已关闭此请求。'; this.save(i); } });
  }
  async wait(invocationId: string, request: NativeInteractionRequest, transport: RuntimeInteraction['transport'], signal: AbortSignal) {
    const created = this.create(invocationId, request, transport);
    for (;;) {
      this.sweep(); let i = this.get(created.id);
      if (signal.aborted && i.state === 'pending') { this.port.tx(() => { i.state = 'cancelled'; i.reason = '当前执行已停止。'; this.save(i); }); }
      i = this.get(created.id);
      if (i.state !== 'pending') {
        // A replay cannot deliver a previously returned answer to another native callback.
        if (i.delivery !== 'not_sent') return { state: 'cancelled' as const };
        this.port.tx(() => { i.delivery = 'returned_to_adapter'; this.save(i); });
        return { state: i.state, ...(i.state === 'answered' ? { answers: i.answers } : {}) };
      }
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 100); signal.addEventListener('abort', done, { once: true }); });
    }
  }
  tool(invocationId: string, args: Record<string, unknown>, callId: string, signal: AbortSignal) {
    if (Object.keys(args).some(k => k !== 'questions')) throw new AppError(400, '提问只接受 questions，身份由执行绑定。');
    return this.wait(invocationId, { providerRequestId: callId, kind: 'question', operation: 'user_question', questions: args.questions as InteractionQuestion[], payload: args }, 'platform', signal);
  }
}
