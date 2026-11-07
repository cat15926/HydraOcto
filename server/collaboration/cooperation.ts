import { randomUUID } from 'node:crypto';
import type { AppendObservation, CollaborationInvocation, Consumption, Conversation, Delivery, InputExposure, InputHandoff, MentionGroup, QueueState, SourceWork } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';
import { stringField } from './artifacts.js';
import type { CollaborationStore } from './store.js';

const conflict = (message: string): never => { throw new AppError(409, message, 'cooperation_conflict'); };
export function compareSources(a: SourceWork, b: SourceWork): number {
  return Number(a.position === undefined) - Number(b.position === undefined) || (a.position ?? 0) - (b.position ?? 0) || Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || (a.enqueuedAt ?? a.createdAt).localeCompare(b.enqueuedAt ?? b.createdAt) || a.id.localeCompare(b.id);
}
/** Ephemeral cancellation fences, safe preflight backoff and group collectors; durable facts stay in SQLite. */
export class CooperationService {
  private fences = new Map<string, QueueState['suppressions'][number]>();
  private backoffs = new Map<string, QueueState['backoffs'][number]>();
  private collectors = new Map<string, Map<string, NonNullable<MentionGroup['results']>[number]>>();
  constructor(readonly store: CollaborationStore, readonly clock: () => number = Date.now) {}
  private get data() { return this.store.artifacts; }
  private get port() { return this.data.port; }
  private source(id: string) { return this.data.get<SourceWork>('cc_sources', id); }
  private delivery(id: string) { return this.data.get<Delivery>('cc_deliveries', id); }
  private saveDelivery(d: Delivery) { this.store.db.prepare('UPDATE cc_deliveries SET status=?,response_id=?,value=? WHERE id=?').run(d.status, d.responseId ?? null, JSON.stringify(d), d.id); }
  private putSource(s: SourceWork) { this.store.db.prepare('UPDATE cc_sources SET value=? WHERE id=?').run(JSON.stringify(s), s.id); }
  revision(cid: string): number { return (this.store.db.prepare('SELECT revision FROM cc_queue_versions WHERE conversation_id=?').get(cid) as { revision: number } | undefined)?.revision ?? 0; }
  changed(cid: string) { this.store.db.prepare('INSERT INTO cc_queue_versions VALUES(?,1) ON CONFLICT(conversation_id) DO UPDATE SET revision=revision+1').run(cid); }
  sources(cid: string) { return this.data.rows<SourceWork>('cc_sources', cid).sort(compareSources); }
  suppressed(cid: string, member: string): boolean { const f = this.fences.get(`${cid}:${member}`); if (f && Date.parse(f.until) <= this.clock()) this.fences.delete(`${cid}:${member}`); return this.fences.has(`${cid}:${member}`); }
  delayed(sourceId: string): boolean { return Date.parse(this.backoffs.get(sourceId)?.until ?? '') > this.clock(); }
  defer(i: CollaborationInvocation) {
    const sourceId = this.store.contract(i.id).primarySourceId ?? this.store.response(i.responseId).inputSourceIds[0]!;
    const attempts = (this.backoffs.get(sourceId)?.attempts ?? 0) + 1;
    this.backoffs.set(sourceId, { sourceId, invocationId: i.id, attempts, until: new Date(this.clock() + Math.min(3_600_000, 10000 * 2 ** Math.min(attempts - 1, 12))).toISOString(), reason: '模型发送前的身份探测暂时失败；保留同一 prepared 执行。' });
    this.port.tx(() => this.port.event(i.conversationId, 'queue.backoff', { invocationId: i.id, ...this.backoffs.get(sourceId) }));
  }
  canLaunch(i: CollaborationInvocation) { const sourceId = this.store.contract(i.id).primarySourceId ?? this.store.response(i.responseId).inputSourceIds[0]!; return !this.delayed(sourceId) && !this.suppressed(i.conversationId, i.memberId); }
  launched(i: CollaborationInvocation) { const sourceId = this.store.contract(i.id).primarySourceId ?? this.store.response(i.responseId).inputSourceIds[0]!; if (this.backoffs.get(sourceId)?.invocationId === i.id) this.backoffs.delete(sourceId); }
  newUserInput(cid: string, targets: string[]) { for (const t of targets) this.fences.delete(`${cid}:${t}`); }
  cancelAll(cid: string, requestId: string) {
    return this.port.tx(() => {
      const out = this.port.command(`cancel-all:${cid}:${stringField(requestId, '请求标识')}`, { cid }, () => {
        this.data.get<Conversation>('cc_conversations', cid);
        const ids = this.store.invocations(cid).filter(i => ['prepared', 'running', 'cancel_requested'].includes(i.status)).map(i => i.id);
        for (const id of ids) this.store.cancel(id);
        this.port.event(cid, 'conversation.cancel_all', { invocationIds: ids, ttlMs: 60000 }); return { invocationIds: ids };
      });
      if (!out.replayed) for (const id of out.result.invocationIds) { const i = this.store.invocation(id); this.fences.set(`${cid}:${i.memberId}`, { memberId: i.memberId, invocationId: i.id, cancelRevision: i.cancelRevision ?? 0, until: new Date(this.clock() + 60000).toISOString() }); }
      return { ...out.result, replayed: out.replayed };
    });
  }
  queue(cid: string): QueueState {
    const pending = new Set(this.data.rows<Delivery>('cc_deliveries').filter(d => ['pending', 'held'].includes(d.status)).map(d => d.sourceId));
    for (const member of this.data.get<Conversation>('cc_conversations', cid).memberIds) this.suppressed(cid, member);
    const sources = this.sources(cid).filter(s => !s.withdrawnAt && (s.bindingState === 'unresolved' || pending.has(s.id)));
    return { revision: this.revision(cid), sources, backoffs: [...this.backoffs.values()].filter(b => this.source(b.sourceId).conversationId === cid), suppressions: [...this.fences.entries()].filter(([key]) => key.startsWith(cid + ':')).map(([, f]) => f) };
  }
  reorder(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const out = this.port.command(`queue-order:${cid}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const current = this.queue(cid);
        if (current.revision !== input.expectedRevision) conflict('队列已变化，请刷新后重排。');
        if (!Array.isArray(input.sourceIds) || input.sourceIds.length !== current.sources.length || new Set(input.sourceIds).size !== input.sourceIds.length || input.sourceIds.some(id => !current.sources.some(s => s.id === id))) throw new AppError(400, '重排必须包含当前全部待投递来源且不重复。');
        input.sourceIds.forEach((id, index) => { const s = this.source(String(id)); s.position = index; s.orderRevision = (s.orderRevision ?? 0) + 1; this.putSource(s); });
        this.changed(cid); this.port.event(cid, 'queue.reordered', { sourceIds: input.sourceIds, revision: this.revision(cid) }); return { revision: this.revision(cid) };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  withdraw(sourceId: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const out = this.port.command(`source-withdraw:${sourceId}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const s = this.source(sourceId);
        if (s.revision !== input.expectedRevision || s.withdrawnAt) conflict('来源已变化或已经撤回。');
        s.withdrawnAt = now(); this.putSource(s);
        for (const d of this.data.rows<Delivery>('cc_deliveries').filter(d => d.sourceId === s.id && ['pending', 'held'].includes(d.status))) { d.status = 'withdrawn'; d.revision++; this.saveDelivery(d); }
        this.changed(s.conversationId); this.port.event(s.conversationId, 'source.withdrawn', { sourceId }); return { source: s };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  priority(sourceId: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const out = this.port.command(`source-priority:${sourceId}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const s = this.source(sourceId);
        if (this.revision(s.conversationId) !== input.expectedRevision || !this.queue(s.conversationId).sources.some(x => x.id === s.id) || !['normal', 'urgent'].includes(String(input.priority))) conflict('排位版本或来源状态变化。');
        s.priority = input.priority as SourceWork['priority']; delete s.position; s.orderRevision = (s.orderRevision ?? 0) + 1; this.putSource(s); this.changed(s.conversationId); this.port.event(s.conversationId, 'queue.priority_changed', { sourceId, priority: s.priority }); return { source: s };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  resolveUnbound(s: SourceWork): boolean {
    if (s.bindingState !== 'unresolved' || s.kind !== 'user' || s.withdrawnAt) return false;
    const c = this.data.get<Conversation>('cc_conversations', s.conversationId);
    try {
      const route = this.store.previewRoute(s.conversationId, s.routingContent ?? s.content); s.requestedTargets = route.targets; s.bindingState = 'bound'; s.revision++;
      for (const memberId of route.targets) { const d: Delivery = { id: randomUUID(), sourceId: s.id, memberId, status: 'pending', revision: 1 }; this.store.db.prepare('INSERT INTO cc_deliveries VALUES(?,?,?,?,?,?)').run(d.id, s.id, memberId, null, d.status, JSON.stringify(d)); }
      route.id = randomUUID(); route.sourceId = s.id; s.routingDecisionId = route.id; this.store.db.prepare('INSERT INTO cc_routing VALUES(?,?,?)').run(route.id, s.id, JSON.stringify(route));
      this.putSource(s); this.changed(c.id); this.newUserInput(c.id, route.targets); this.port.event(c.id, 'source.targets_resolved', { sourceId: s.id, targets: route.targets }); return true;
    } catch (e) { if (e instanceof AppError && e.code === 'no_routable_member') return false; throw e; }
  }
  canConsume(i: CollaborationInvocation, s: SourceWork): boolean {
    if (this.store.visibility.primary(i.id).actionRef || s.actionRef || s.crossRef || !this.store.visibility.sameScope(i.id, s) || s.conversationId !== i.conversationId || s.bindingState !== 'bound' || s.withdrawnAt || s.taskRef || s.reviewRef || s.groupId || this.delayed(s.id) || this.suppressed(i.conversationId, i.memberId)) return false;
    if (['visibility-memory-v1', 'cross-action-v1'].includes(this.store.contract(i.id).toolPolicyVersion) && this.store.visibility.admissionReason(s)) return false;
    const d = this.data.rows<Delivery>('cc_deliveries').find(d => d.sourceId === s.id && d.memberId === i.memberId);
    return d?.status === 'pending' && !d.handoffId && (!d.continuation || d.continuation.fallback === true);
  }
  pending(invocationId: string) {
    const i = this.store.invocation(invocationId); this.actor(i);
    const out: SourceWork[] = [];
    for (const s of this.sources(i.conversationId)) { if (s.bindingState === 'unresolved' && !s.withdrawnAt) break; if (this.canConsume(i, s)) out.push(s); }
    return out;
  }
  actor(i: CollaborationInvocation) { this.store.visibility.assertTool(i.id, 'conversation_read'); this.port.tasks.actor(i.id, true); if (!['cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(this.store.contract(i.id).toolPolicyVersion ?? '') || i.acceptance !== 'accepted') conflict('当前执行未获得协作输入工具权限。'); }
  read(invocationId: string, input: Record<string, unknown>, callId: string) {
    return this.port.tx(() => {
      const i = this.store.invocation(invocationId); this.actor(i);
      if (this.handoffs(i.conversationId).some(h => h.invocationId === i.id && ['sent', 'unknown'].includes(h.state))) conflict('准确追加回执仍在处理中，请稍后读取。');
      const out = this.port.command(`conversation-read:${invocationId}:${callId}`, input, () => {
        if (Object.keys(input).some(k => k !== 'sourceIds') || !Array.isArray(input.sourceIds) || input.sourceIds.length < 1 || input.sourceIds.length > 8 || new Set(input.sourceIds).size !== input.sourceIds.length) throw new AppError(400, '需要 1–8 个不同来源。');
        const available = this.pending(i.id), selected = new Set(input.sourceIds);
        const sources = available.filter(s => selected.has(s.id));
        if (sources.length !== selected.size) conflict('来源不属于本成员的合法待办，或状态已变化。');
        if (sources.reduce((n, s) => n + Buffer.byteLength(s.content), 0) > 64000) throw new AppError(422, '完整来源超过本次读取上限，未消费任何来源。');
        this.store.consumeInputs(i.id, sources, 'tool'); return { sources, inputRevision: this.store.response(i.responseId).inputRevision };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  reconcileDeliveries() {
    for (const receipt of this.data.rows<Consumption>('cc_consumptions')) {
      const d = this.delivery(receipt.deliveryId); if (!['pending', 'held'].includes(d.status)) continue;
      const r = this.store.response(receipt.responseId), i = this.store.invocation(r.invocationId), s = this.source(receipt.sourceId);
      if (d.sourceId !== s.id || d.memberId !== receipt.memberId || r.memberId !== receipt.memberId || i.responseId !== r.id || r.conversationId !== s.conversationId || !r.inputSourceIds.includes(s.id) || (d.responseId && d.responseId !== r.id)) conflict('现存消费与投递关联不一致，不能重新派发。');
      d.status = 'consumed'; d.responseId = r.id; d.revision++; this.saveDelivery(d); this.changed(s.conversationId); this.port.event(s.conversationId, 'delivery.reconciled', { deliveryId: d.id, responseId: r.id });
    }
  }
  groups(cid?: string) { return this.data.rows<MentionGroup>('cc_mention_groups', cid).map(g => ({ ...g, ...(g.state === 'collecting' && this.collectors.has(g.id) ? { results: [...this.collectors.get(g.id)!.values()], missing: g.targets.filter(t => !this.collectors.get(g.id)!.has(t)) } : {}) })); }
  createGroup(cid: string, input: Record<string, unknown>, invocationId?: string) {
    return this.port.tx(() => {
      if (invocationId) { this.store.visibility.assertTool(invocationId, 'multi_mention'); this.actor(this.store.invocation(invocationId)); }
      const out = this.port.command(`multi-mention:${cid}:${stringField(input.requestId, '请求标识')}`, { input, invocationId }, () => {
        const i = invocationId ? this.store.invocation(invocationId) : undefined;
        if (i && (i.conversationId !== cid || this.groups(cid).some(g => g.state === 'collecting' && g.targets.includes(i.memberId)))) conflict('正在参与多人征询的成员不能再次创建征询组。');
        if (!Array.isArray(input.targets) || input.targets.length < 2 || input.targets.length > 8 || new Set(input.targets).size !== input.targets.length || input.targets.includes(i?.memberId)) throw new AppError(400, '征询需要 2–8 名不同的其他成员。');
        const targets = input.targets.map(t => stringField(t, '目标成员')); for (const t of targets) this.data.target(cid, t);
        if (this.groups(cid).filter(g => g.state === 'collecting').length >= 20) conflict('本会话活动征询组达到上限。');
        const question = stringField(input.question, '问题', 10000), context = input.context === undefined ? '' : String(input.context);
        if (context.length > 10000) throw new AppError(400, '上下文过长。');
        const ttl = input.timeoutMs ?? 120000; if (!Number.isSafeInteger(ttl) || Number(ttl) < 1000 || Number(ttl) > 600000) throw new AppError(400, '征询期限须为 1–600 秒。');
        const g: MentionGroup = { id: randomUUID(), conversationId: cid, sourceId: '', targets, question, context, state: 'collecting', createdAt: now(), deadline: new Date(this.clock() + Number(ttl)).toISOString(), revision: 1, ...(i ? { callerInvocationId: i.id, callbackTo: i.memberId } : {}) };
        const source = this.store.admitSource({ conversationId: cid, kind: 'multi_mention', content: `多人征询 ${g.id}\n${question}\n${context}\n请直接回答当前问题。汇总不会唤回发起者；不得嵌套创建 multi_mention。`, requestedTargets: targets, depth: i ? this.source(this.store.response(i.responseId).inputSourceIds[0]!).depth + 1 : 0, groupId: g.id, ...(i ? { parentInvocationId: i.id, authorMemberId: i.memberId } : {}) });
        if (source.depth > 8) conflict('征询达到协作深度上限。');
        g.sourceId = source.id; this.data.save('cc_mention_groups', g, 'group.created'); return { group: g };
      }); if (!out.replayed) this.collectors.set(out.result.group.id, new Map()); return { ...out.result, replayed: out.replayed };
    });
  }
  groupTick() {
    this.port.tx(() => { for (const g of this.data.rows<MentionGroup>('cc_mention_groups')) {
      if (g.state !== 'collecting') continue;
      const collector = this.collectors.get(g.id);
      if (!collector) { g.state = 'lost'; g.missing = g.targets; }
      else if (Date.parse(g.deadline) <= this.clock()) { g.state = 'timeout'; g.results = [...collector.values()]; g.missing = g.targets.filter(t => !collector.has(t)); }
      else {
        for (const i of this.store.invocations(g.conversationId)) {
          const r = this.store.response(i.responseId); if (!r.inputSourceIds.includes(g.sourceId) || !g.targets.includes(i.memberId) || collector.has(i.memberId) || !['succeeded', 'failed'].includes(i.status) || (i.cancelRevision ?? 0) > 0) continue;
          collector.set(i.memberId, { memberId: i.memberId, responseId: r.id, status: i.status as 'succeeded' | 'failed', content: r.content || 'dispatch-error: 目标执行未提供正文。' });
        }
        if (collector.size !== g.targets.length) continue;
        g.state = 'done'; g.results = g.targets.map(t => collector.get(t)!); g.missing = [];
        this.store.systemMessage(g.conversationId, `多人征询结果：${g.question}\n${g.results.map(r => `[${r.memberId} · ${r.status}]\n${r.content}`).join('\n\n')}`);
      }
      g.finishedAt = now(); g.revision++; this.data.save('cc_mention_groups', g, `group.${g.state}`); this.collectors.delete(g.id);
    } });
  }
  cancelGroup(id: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const out = this.port.command(`group-cancel:${id}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const g = this.data.get<MentionGroup>('cc_mention_groups', id); if (g.state !== 'collecting' || g.revision !== input.expectedRevision) conflict('征询组状态已变化。');
        g.state = 'cancelled'; g.finishedAt = now(); g.revision++; this.data.save('cc_mention_groups', g, 'group.cancelled');
        this.withdraw(g.sourceId, { requestId: `group:${g.id}`, expectedRevision: this.source(g.sourceId).revision });
        const ids = this.store.invocations(g.conversationId).filter(i => this.store.response(i.responseId).inputSourceIds.includes(g.sourceId) && ['prepared', 'running'].includes(i.status)).map(i => i.id); for (const id of ids) this.store.cancel(id);
        return { group: g, invocationIds: ids };
      }); this.collectors.delete(id); return { ...out.result, replayed: out.replayed };
    });
  }
  handoffs(cid?: string) { return this.data.rows<InputHandoff>('cc_input_handoffs', cid); }
  exposures(cid?: string) { return this.data.rows<InputExposure>('cc_input_exposures', cid); }
  detail(cid: string) { return { queue: this.queue(cid), groups: this.groups(cid), inputExposures: this.exposures(cid), inputHandoffs: this.handoffs(cid) }; }
  bindContinuation(s: SourceWork, deliveryMode?: 'next_turn' | 'continue_current') {
    if (deliveryMode === 'next_turn' || s.excerptRefs?.length || s.requestedTargets.length !== 1) return;
    for (const d of this.data.rows<Delivery>('cc_deliveries').filter(d => d.sourceId === s.id)) {
      const i = this.store.invocations(s.conversationId).find(i => i.memberId === d.memberId && ['prepared', 'running'].includes(i.status));
      if (!i || !this.store.visibility.sameScope(i.id, s) || !['cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(this.store.contract(i.id).toolPolicyVersion ?? '')) continue;
      d.continuation = { invocationId: i.id, responseId: i.responseId, cancelRevision: i.cancelRevision ?? 0, ...(i.member.carrier !== 'codex-app-server' ? { fallback: true, reason: '当前承载不支持活动追加，保留下一轮投递。' } : {}) };
      this.saveDelivery(d);
    }
  }
  prepareAppend(ready: Set<string>): InputHandoff | undefined {
    return this.port.tx(() => {
      for (const c of this.store.list()) {
        const held = new Set<string>();
        for (const s of this.sources(c.id)) {
          if (s.withdrawnAt) continue; if (s.bindingState === 'unresolved') break;
          const pending = this.data.rows<Delivery>('cc_deliveries').filter(d => d.sourceId === s.id && d.status === 'pending');
          for (const d of pending) {
            const ref = d.continuation; if (!ref || ref.fallback || held.has(d.memberId) || this.suppressed(c.id, d.memberId) || this.delayed(s.id)) continue;
            const i = this.store.invocation(ref.invocationId);
            if (!this.store.members().some(m => m.id === d.memberId && m.enabled) || !c.memberIds.includes(d.memberId)) continue;
            if (i.responseId !== ref.responseId || (i.cancelRevision ?? 0) !== ref.cancelRevision || !['prepared', 'running'].includes(i.status)) { ref.fallback = true; ref.reason = '原运行已结束或取消，尚未发送的输入保留排队。'; this.saveDelivery(d); continue; }
            if (!ready.has(i.id) || !i.nativeSessionId || !i.nativeTurnId || this.handoffs().some(h => h.invocationId === i.id && ['sent', 'unknown'].includes(h.state))) continue;
            const h: InputHandoff = { id: randomUUID(), conversationId: c.id, sourceId: s.id, sourceRevision: s.revision, sourceDigest: digest(s.content), deliveryId: d.id, deliveryRevision: d.revision + 1, memberId: d.memberId, invocationId: i.id, responseId: i.responseId, inputRevision: this.store.response(i.responseId).inputRevision, cancelRevision: i.cancelRevision ?? 0, nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId, nativeDeliveryId: randomUUID(), content: s.content, state: 'sent', requiresCompletion: false, revision: 1, createdAt: now(), updatedAt: now() };
            d.handoffId = h.id; d.status = 'held'; d.revision++; d.holdReason = '追加已绑定准确执行，等待承载回执。'; this.saveDelivery(d); this.data.save('cc_input_handoffs', h, 'input.append_sent'); this.changed(c.id); return h;
          }
          for (const d of pending) held.add(d.memberId);
        }
      }
    });
  }
  appendResult(id: string, observation: AppendObservation) {
    return this.port.tx(() => {
      const h = this.data.get<InputHandoff>('cc_input_handoffs', id);
      if (observation.nativeSessionId !== h.nativeSessionId || observation.nativeTurnId !== h.nativeTurnId || observation.nativeDeliveryId !== h.nativeDeliveryId) conflict('追加回执身份与原发送不匹配。');
      if (h.state === 'read' || (h.state === 'accepted' && observation.state !== 'read') || h.state === 'not_accepted') return h;
      h.evidence = [...(h.evidence ?? []), observation].slice(-32);
      const i = this.store.invocation(h.invocationId), r = this.store.response(h.responseId), s = this.source(h.sourceId), d = this.delivery(h.deliveryId);
      const bindingValid = (i.cancelRevision ?? 0) === h.cancelRevision && i.responseId === h.responseId && i.nativeSessionId === h.nativeSessionId && i.nativeTurnId === h.nativeTurnId && s.revision === h.sourceRevision && digest(s.content) === h.sourceDigest && !s.withdrawnAt && d.handoffId === h.id && d.revision === h.deliveryRevision && r.inputRevision === h.inputRevision;
      const valid = bindingValid && i.status === 'running' && this.store.members().some(m => m.id === h.memberId && m.enabled) && this.data.get<Conversation>('cc_conversations', h.conversationId).memberIds.includes(h.memberId);
      if (h.state === 'accepted' && observation.state === 'read') {
        // Acceptance already advanced delivery/input once; a later read must validate that
        // post-consumption binding, rather than bypassing cancellation or source drift.
        const acceptedBinding = i.status === 'running' && (i.cancelRevision ?? 0) === h.cancelRevision && i.responseId === h.responseId && i.nativeSessionId === h.nativeSessionId && i.nativeTurnId === h.nativeTurnId
          && s.revision === h.sourceRevision && digest(s.content) === h.sourceDigest && !s.withdrawnAt
          && d.handoffId === h.id && d.status === 'consumed' && d.responseId === h.responseId && d.revision === h.deliveryRevision + 1 && r.inputRevision === h.inputRevision + 1
          && this.store.members().some(m => m.id === h.memberId && m.enabled) && this.data.get<Conversation>('cc_conversations', h.conversationId).memberIds.includes(h.memberId);
        if (acceptedBinding) { h.state = 'read'; h.reason = observation.reason; }
        else h.reason = '迟到读取观察仅保留审计；取消、来源或输入绑定已变化，原接受事实不升级。';
      }
      else if (!valid && !(bindingValid && observation.state === 'not_accepted')) { h.state = 'unknown'; h.reason = '准确执行、取消、来源或输入版本变化；回执仅保留审计，不重发。'; }
      else if (observation.state === 'accepted' || observation.state === 'read') {
        this.store.consumeInputs(i.id, [s], 'append', h.id); h.state = observation.state; h.reason = observation.reason;
      } else if (observation.state === 'not_accepted') { h.state = 'not_accepted'; h.reason = observation.reason; d.status = 'pending'; d.revision++; delete d.holdReason; delete d.handoffId; if (d.continuation) { d.continuation.fallback = true; d.continuation.reason = observation.reason; } this.saveDelivery(d); }
      else { h.state = 'unknown'; h.reason = observation.reason; }
      h.updatedAt = now(); h.revision++; this.data.save('cc_input_handoffs', h, 'input.append_observed'); this.changed(h.conversationId); return h;
    });
  }
  recover() {
    this.port.tx(() => { for (const h of this.handoffs().filter(h => h.state === 'sent')) { h.state = 'unknown'; h.reason = '服务重启，原发送结果未确认，禁止重发。'; h.revision++; this.data.save('cc_input_handoffs', h, 'input.append_unknown'); } this.reconcileDeliveries(); });
    this.groupTick();
  }
}
