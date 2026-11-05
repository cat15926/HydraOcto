import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CollaborationInvocation, CollaborationResponse, Consumption, Conversation, CreateOrdinaryTask, Delivery, ExecutionContractSnapshot, HandoffOrdinaryTask, Member, OrdinaryTask, ResponsibilityItem, SourceWork, TaskActor, TaskCommandVersion, TaskExecutionRef, TaskHandoff, UpdateOrdinaryTask } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';

const terminal = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const taskStates = ['todo', 'doing', 'blocked', 'done'];
const dispositions = ['frozen', 'degraded', 'abandoned'];
const fail = (message: string, code = 'task_conflict'): never => { throw new AppError(409, message, code); };
const text = (value: unknown, label: string, max: number, empty = false): string => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) throw new AppError(400, `${label}无效。`);
  return value.trim();
};
interface TaskPort {
  db: DatabaseSync;
  tx<T>(fn: () => T): T;
  command<T>(id: string, input: unknown, fn: () => T): { result: T; replayed: boolean };
  invocation(id: string): CollaborationInvocation;
  saveInvocation(i: CollaborationInvocation): void;
  contract(id: string): ExecutionContractSnapshot;
  addSource(input: Pick<SourceWork, 'conversationId' | 'kind' | 'content' | 'requestedTargets' | 'depth'> & Partial<Pick<SourceWork, 'parentInvocationId' | 'authorMemberId' | 'taskRef'>>): SourceWork;
  message(conversationId: string, content: string, sourceId?: string): void;
  event(conversationId: string, type: string, data: Record<string, unknown>): void;
}

/** Task ownership is separate from message routing and member runtime occupancy. All writes share the Store transaction. */
export class OrdinaryTaskService {
  constructor(private readonly port: TaskPort) {}
  private rows<T>(table: string, where = '', args: string[] = []): T[] { return (this.port.db.prepare(`SELECT value FROM ${table} ${where}`).all(...args) as { value: string }[]).map(r => JSON.parse(r.value) as T); }
  private get<T>(table: string, id: string): T { const item = this.rows<T>(table, 'WHERE id=?', [id])[0]; if (!item) throw new AppError(404, '记录不存在。', 'not_found'); return item; }
  list(conversationId: string): OrdinaryTask[] { return this.rows('cc_ordinary_tasks', 'WHERE conversation_id=? ORDER BY rowid', [conversationId]); }
  handoffs(conversationId: string): TaskHandoff[] { return this.rows('cc_task_handoffs', 'WHERE conversation_id=? ORDER BY rowid', [conversationId]); }
  getTask(id: string): OrdinaryTask { return this.get('cc_ordinary_tasks', id); }
  private save(t: OrdinaryTask, type: string, data: Record<string, unknown> = {}) {
    t.revision++; t.updatedAt = now(); this.port.db.prepare('UPDATE cc_ordinary_tasks SET value=? WHERE id=?').run(JSON.stringify(t), t.id);
    this.port.event(t.conversationId, type, { taskId: t.id, revision: t.revision, ownerRevision: t.ownerRevision, ...data });
  }
  private saveHandoff(h: TaskHandoff) { h.revision++; h.updatedAt = now(); this.port.db.prepare('UPDATE cc_task_handoffs SET value=? WHERE id=?').run(JSON.stringify(h), h.id); this.port.event(h.conversationId, `task.handoff.${h.state}`, { taskId: h.taskId, handoffId: h.id, reason: h.reason }); }
  private version(t: OrdinaryTask, v: TaskCommandVersion) {
    text(v.requestId, '请求标识', 200);
    if (!Number.isSafeInteger(v.expectedRevision) || !Number.isSafeInteger(v.expectedOwnerRevision) || t.revision !== v.expectedRevision || t.ownerRevision !== v.expectedOwnerRevision) fail('任务或负责人版本已变化，请刷新后操作。', 'task_version_conflict');
  }
  private target(conversationId: string, memberId: string): void {
    const c = this.get<Conversation>('cc_conversations', conversationId), m = this.get<Member>('cc_members', memberId);
    if (!c.memberIds.includes(memberId) || !m.enabled) fail('目标必须是当前会话中已启用的成员。', 'task_target_unavailable');
  }
  private sourceFor(i: CollaborationInvocation): SourceWork {
    const r = this.get<CollaborationResponse>('cc_responses', i.responseId), c = this.port.contract(i.id);
    const source = r.inputSourceIds.length === 1 ? this.get<SourceWork>('cc_sources', r.inputSourceIds[0]!) : undefined;
    const receipt = this.rows<Consumption>('cc_consumptions', 'WHERE response_id=?', [i.responseId]).find(x => x.memberId === i.memberId && x.sourceId === source?.id);
    const delivery = receipt && this.get<Delivery>('cc_deliveries', receipt.deliveryId);
    if (!source || source.conversationId !== i.conversationId || source.revision !== c.sourceRevision || digest(source.content) !== c.sourceDigest || r.invocationId !== i.id || r.memberId !== i.memberId || r.conversationId !== i.conversationId || delivery?.status !== 'consumed' || delivery.responseId !== i.responseId || delivery.memberId !== i.memberId) fail('任务操作缺少准确且有效的消费来源。', 'task_source_conflict');
    return source!;
  }
  actor(invocationId?: string): TaskActor {
    if (!invocationId) return { kind: 'user' };
    const i = this.port.invocation(invocationId);
    if (i.status !== 'running' || (i.cancelRevision ?? 0) !== 0 || !['readonly-tasks-v1', 'managed-artifacts-v1'].includes(this.port.contract(i.id).toolPolicyVersion)) fail('此执行不具备任务操作权限。', 'stale_task_callback');
    this.target(i.conversationId, i.memberId);
    const s = this.sourceFor(i);
    return { kind: 'agent', invocationId, memberId: i.memberId, sourceId: s.id, sourceRevision: s.revision, cancelRevision: i.cancelRevision ?? 0 };
  }
  private authorize(t: OrdinaryTask, actor: TaskActor, allowClaim = false) {
    if (actor.kind === 'user') return;
    const i = this.port.invocation(actor.invocationId);
    if (t.conversationId !== i.conversationId) fail('任务不属于当前执行会话。', 'task_scope_conflict');
    if (allowClaim && !t.executionRef && (!t.ownerMemberId || t.ownerMemberId === i.memberId) && !this.pending(t) && !t.pendingHandoffId) return;
    const ref = t.executionRef, binding = i.taskBindings?.find(b => b.taskId === t.id);
    if (t.ownerMemberId !== i.memberId || ref?.invocationId !== i.id || ref.responseId !== i.responseId || binding?.ownerRevision !== t.ownerRevision || binding.fence !== ref.fence || ref.sourceId !== actor.sourceId || ref.sourceRevision !== actor.sourceRevision || ref.inputRevision !== this.get<CollaborationResponse>('cc_responses', i.responseId).inputRevision) fail('此回调不是当前任务的准确执行，不能修改负责人或完成状态。', 'task_execution_conflict');
  }
  executionAuthority(taskId: string, actor: TaskActor): void { this.authorize(this.getTask(taskId), actor); }
  private pending(t: OrdinaryTask): boolean { return !!t.currentSourceId && this.rows<Delivery>('cc_deliveries', 'WHERE source_id=?', [t.currentSourceId]).some(d => ['pending', 'held'].includes(d.status)); }
  private delivery(sourceId: string, status: 'held' | 'pending' | 'withdrawn', reason?: string) {
    for (const d of this.rows<Delivery>('cc_deliveries', 'WHERE source_id=?', [sourceId])) {
      if (!['pending', 'held'].includes(d.status)) continue;
      d.status = status; d.revision++; if (reason) d.holdReason = reason; else delete d.holdReason;
      this.port.db.prepare('UPDATE cc_deliveries SET status=?,value=? WHERE id=?').run(status, JSON.stringify(d), d.id);
      this.port.event(this.get<SourceWork>('cc_sources', sourceId).conversationId, `delivery.${status}`, { deliveryId: d.id, sourceId, reason });
    }
  }
  private source(t: OrdinaryTask, target: string, actor: TaskActor, handoff?: TaskHandoff): SourceWork {
    const parent = actor.kind === 'agent' ? this.get<SourceWork>('cc_sources', actor.sourceId) : undefined;
    if ((parent?.depth ?? -1) >= 8) fail('任务交接已达本轮深度限制，请等待用户继续。', 'collaboration_limit');
    const source = this.port.addSource({ conversationId: t.conversationId, kind: handoff ? 'task_handoff' : 'task',
      content: `普通任务 ${t.id}：${t.title}\n${t.description}${handoff ? `\n正式交接说明：${handoff.reason}` : ''}\n请按任务工具读取最新状态。完成需显式 task_update done；普通 A2A 协助不改变负责人。`, requestedTargets: [target], depth: parent ? parent.depth + 1 : 0,
      ...(actor.kind === 'agent' ? { parentInvocationId: actor.invocationId, authorMemberId: actor.memberId } : {}),
      taskRef: { taskId: t.id, ownerRevision: handoff ? t.ownerRevision + 1 : t.ownerRevision, ...(handoff ? { handoffId: handoff.id } : {}) } });
    this.port.message(t.conversationId, `${handoff ? '请求正式转交' : '任务待办'}：${t.title} → ${target}`, source.id); return source;
  }
  private bind(t: OrdinaryTask, i: CollaborationInvocation, source: SourceWork) {
    if (t.executionRef) fail('任务仍有准确执行占用。', 'task_execution_busy');
    const ref: TaskExecutionRef = { invocationId: i.id, responseId: i.responseId, conversationId: i.conversationId, memberId: i.memberId, sourceId: source.id, sourceRevision: source.revision,
      inputRevision: this.get<CollaborationResponse>('cc_responses', i.responseId).inputRevision, fence: randomUUID(), nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId };
    t.executionRef = ref; i.taskBindings = [...(i.taskBindings ?? []).filter(b => b.taskId !== t.id), { taskId: t.id, ownerRevision: t.ownerRevision, fence: ref.fence }]; this.port.saveInvocation(i);
  }
  bindAdmission(source: SourceWork, i: CollaborationInvocation): void {
    if (!source.taskRef) return;
    if (this.admissionReason(source)) fail('任务来源已失效，不能领取。', 'task_source_conflict');
    const t = this.getTask(source.taskRef.taskId); this.bind(t, i, source); this.save(t, 'task.execution_bound', { invocationId: i.id });
  }
  admissionReason(source: SourceWork): string | undefined {
    if (!source.taskRef) return;
    const t = this.getTask(source.taskRef.taskId);
    try { if (t.ownerMemberId) this.target(t.conversationId, t.ownerMemberId); } catch { return '任务负责人已禁用或离开会话。'; }
    if (t.pendingHandoffId) return '正式交接仍在等待旧执行释放。';
    if (t.status === 'done' || t.disposition || t.status === 'blocked' || t.ownerRevision !== source.taskRef.ownerRevision || t.currentSourceId !== source.id || source.requestedTargets.length !== 1 || source.requestedTargets[0] !== t.ownerMemberId || t.executionRef) return '任务状态、负责人版本或执行绑定不允许此投递。';
    if (source.taskRef.handoffId && this.get<TaskHandoff>('cc_task_handoffs', source.taskRef.handoffId).state !== 'applied') return '正式交接尚未应用。';
  }
  create(conversationId: string, input: CreateOrdinaryTask, invocationId?: string) {
    return this.port.tx(() => {
      const actor = this.actor(invocationId); this.get<Conversation>('cc_conversations', conversationId);
      if (actor.kind === 'agent' && this.port.invocation(actor.invocationId).conversationId !== conversationId) fail('任务创建会话不匹配。');
      const title = text(input.title, '标题', 200), description = text(input.description, '描述', 20000, true); text(input.requestId, '请求标识', 200);
      if (input.ownerMemberId != null) text(input.ownerMemberId, '负责人', 100);
      const result = this.port.command(`task-create:${conversationId}:${input.requestId}`, { ...input, actor }, () => {
        const ownerMemberId = input.ownerMemberId || null; if (ownerMemberId) this.target(conversationId, ownerMemberId);
        if (actor.kind === 'agent' && ownerMemberId && ownerMemberId !== actor.memberId) fail('成员创建任务只能领取给自己或保持未分配。');
        if (this.list(conversationId).filter(t => t.status !== 'done' && !t.disposition).length >= 100) fail('本会话未完成任务达到 100 项，请先整理。');
        const t: OrdinaryTask = { id: randomUUID(), conversationId, title, description, ownerMemberId, ownerRevision: ownerMemberId ? 1 : 0, revision: 1, status: 'todo', createdBy: actor, createdAt: now(), updatedAt: now() };
        this.port.db.prepare('INSERT INTO cc_ordinary_tasks VALUES(?,?,?)').run(t.id, conversationId, JSON.stringify(t));
        if (ownerMemberId && actor.kind === 'user') t.currentSourceId = this.source(t, ownerMemberId, actor).id;
        if (ownerMemberId && actor.kind === 'agent') { const i = this.port.invocation(actor.invocationId); this.bind(t, i, this.sourceFor(i)); }
        this.save(t, 'task.created', { ownerMemberId }); return { task: t };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  update(taskId: string, input: UpdateOrdinaryTask, invocationId?: string) {
    return this.port.tx(() => {
      const actor = this.actor(invocationId);
      const result = this.port.command(`task-update:${taskId}:${input.requestId}`, { ...input, actor }, () => {
        const t = this.getTask(taskId); this.version(t, input);
        if ((!input.status && !input.disposition) || (input.status && !taskStates.includes(input.status)) || (input.disposition && !dispositions.includes(input.disposition)) || (input.status && input.disposition)) throw new AppError(400, '选择有效的任务状态或单独终结原因。');
        const reason = text(input.reason ?? '', '原因', 2000, input.status !== 'blocked' && !input.disposition);
        if (actor.kind === 'agent' && (t.disposition || t.status === 'done' || t.pendingHandoffId)) fail('任务已结束或正在交接，此旧执行不能改写。', 'stale_task_callback');
        this.authorize(t, actor, input.status === 'doing');
        if (actor.kind === 'agent' && !t.executionRef) {
          if (!t.ownerMemberId) { t.ownerMemberId = actor.memberId; t.ownerRevision++; }
          const i = this.port.invocation(actor.invocationId); this.bind(t, i, this.sourceFor(i));
        }
        if (input.disposition || input.status === 'done' || input.status === 'blocked' || input.status === 'todo') {
          this.cancelPending(t, '任务状态变化，撤销未应用交接。'); if (t.currentSourceId) this.delivery(t.currentSourceId, 'withdrawn', '任务状态变化。');
        }
        if (input.disposition) t.disposition = { kind: input.disposition, reason, actor, createdAt: now() };
        else { t.status = input.status!; t.statusReason = reason; if (actor.kind === 'user') delete t.disposition; }
        if (actor.kind === 'user' && input.status === 'doing' && t.ownerMemberId && !t.executionRef && !this.pending(t)) {
          this.target(t.conversationId, t.ownerMemberId); t.currentSourceId = this.source(t, t.ownerMemberId, actor).id;
        }
        this.save(t, 'task.updated', { status: t.status, disposition: t.disposition?.kind, actor }); return { task: t };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  handoff(taskId: string, input: HandoffOrdinaryTask, invocationId?: string) {
    return this.port.tx(() => {
      const actor = this.actor(invocationId);
      const result = this.port.command(`task-handoff:${taskId}:${input.requestId}`, { ...input, actor }, () => {
        const t = this.getTask(taskId); this.version(t, input); this.authorize(t, actor); this.target(t.conversationId, input.targetMemberId);
        if (t.status === 'done' || t.disposition || t.pendingHandoffId || t.ownerMemberId === input.targetMemberId) fail('任务已结束、正在交接或目标仍是原负责人。');
        const h: TaskHandoff = { id: randomUUID(), taskId, conversationId: t.conversationId, expectedOwnerRevision: t.ownerRevision, fromMemberId: t.ownerMemberId, toMemberId: input.targetMemberId, actor,
          executionRef: structuredClone(t.executionRef), sourceId: '', sourceRevision: 1, sourceDigest: '', state: 'waiting', reason: text(input.reason, '交接说明', 2000), revision: 1, stopRequested: actor.kind === 'user' && input.stopCurrent === true, createdAt: now(), updatedAt: now() };
        const source = this.source(t, h.toMemberId, actor, h); h.sourceId = source.id; h.sourceRevision = source.revision; h.sourceDigest = digest(source.content);
        this.port.db.prepare('INSERT INTO cc_task_handoffs VALUES(?,?,?,?)').run(h.id, taskId, t.conversationId, JSON.stringify(h));
        this.delivery(source.id, 'held', '等待正式交接应用与旧执行释放。'); t.pendingHandoffId = h.id; this.save(t, 'task.handoff_prepared', { handoffId: h.id });
        this.apply(h.id); return { task: this.getTask(taskId), handoff: this.get<TaskHandoff>('cc_task_handoffs', h.id) };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  private cancelPending(t: OrdinaryTask, reason: string) {
    if (!t.pendingHandoffId) return;
    const h = this.get<TaskHandoff>('cc_task_handoffs', t.pendingHandoffId);
    if (h.state === 'waiting') { h.state = 'cancelled'; h.reason = reason; this.saveHandoff(h); this.delivery(h.sourceId, 'withdrawn', reason); }
    delete t.pendingHandoffId;
  }
  cancelHandoff(taskId: string, input: TaskCommandVersion) {
    return this.port.tx(() => {
      const result = this.port.command(`task-handoff-cancel:${taskId}:${input.requestId}`, input, () => {
        const t = this.getTask(taskId); this.version(t, input); if (!t.pendingHandoffId) fail('没有等待中的交接。');
        this.cancelPending(t, '用户撤销本次交接；停止意图和已有执行事实不撤销。'); this.save(t, 'task.handoff_cancelled'); return { task: t };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  private released(ref: TaskExecutionRef, taskId: string, ownerRevision: number): boolean {
    const i = this.port.invocation(ref.invocationId), binding = i.taskBindings?.find(b => b.fence === ref.fence);
    const r = this.get<CollaborationResponse>('cc_responses', i.responseId);
    return binding?.taskId === taskId && binding.ownerRevision === ownerRevision && i.responseId === ref.responseId && r.inputRevision === ref.inputRevision && r.inputSourceIds.includes(ref.sourceId) && i.memberId === ref.memberId && i.conversationId === ref.conversationId && (!ref.nativeSessionId || i.nativeSessionId === ref.nativeSessionId) && (!ref.nativeTurnId || i.nativeTurnId === ref.nativeTurnId) && terminal.has(i.status) && i.teardown === 'confirmed';
  }
  private apply(handoffId: string): void {
    const h = this.get<TaskHandoff>('cc_task_handoffs', handoffId); if (h.state !== 'waiting') return;
    const t = this.getTask(h.taskId), source = this.get<SourceWork>('cc_sources', h.sourceId);
    let refused: string | undefined;
    if (t.pendingHandoffId !== h.id || t.ownerRevision !== h.expectedOwnerRevision || t.ownerMemberId !== h.fromMemberId || source.revision !== h.sourceRevision || digest(source.content) !== h.sourceDigest || source.taskRef?.handoffId !== h.id || source.taskRef?.taskId !== t.id || source.taskRef?.ownerRevision !== h.expectedOwnerRevision + 1 || source.requestedTargets.length !== 1 || source.requestedTargets[0] !== h.toMemberId || !this.rows<Delivery>('cc_deliveries', 'WHERE source_id=?', [source.id]).some(d => d.memberId === h.toMemberId && d.status === 'held') || t.status === 'done' || t.disposition) refused = '任务或交接来源已失效。';
    if (h.actor.kind === 'agent') {
      const issuer = this.port.invocation(h.actor.invocationId);
      if ((issuer.cancelRevision ?? 0) !== h.actor.cancelRevision || this.get<SourceWork>('cc_sources', h.actor.sourceId).revision !== h.actor.sourceRevision) refused = '发起交接的执行已取消或原来源已变化。';
      try { this.sourceFor(issuer); this.target(t.conversationId, h.actor.memberId); } catch { refused = '原消费来源或发起者权限已失效。'; }
    }
    try { this.target(t.conversationId, h.toMemberId); } catch { refused = '目标已禁用或离开会话。'; }
    if (h.executionRef && t.executionRef && (t.executionRef.invocationId !== h.executionRef.invocationId || t.executionRef.fence !== h.executionRef.fence)) refused = '任务执行已变化，旧交接不得释放新执行。';
    if (refused) {
      h.state = 'refused'; h.reason = refused; this.saveHandoff(h); this.delivery(h.sourceId, 'withdrawn', refused);
      if (t.pendingHandoffId === h.id) { delete t.pendingHandoffId; this.save(t, 'task.handoff_refused'); } return;
    }
    if (h.executionRef && !this.released(h.executionRef, t.id, h.expectedOwnerRevision)) return;
    if (t.currentSourceId) this.delivery(t.currentSourceId, 'withdrawn', '负责人已正式转交。');
    if (t.executionRef) { t.lastExecutionRef = t.executionRef; delete t.executionRef; }
    t.ownerMemberId = h.toMemberId; t.ownerRevision++; t.currentSourceId = h.sourceId; delete t.pendingHandoffId;
    if (t.status === 'blocked') { t.status = 'todo'; delete t.statusReason; }
    h.state = 'applied'; this.saveHandoff(h); this.save(t, 'task.owner_changed', { handoffId: h.id, ownerMemberId: h.toMemberId }); this.delivery(h.sourceId, 'pending');
  }
  onInvocationChanged(i: CollaborationInvocation): void {
    for (const t of this.list(i.conversationId).filter(t => t.executionRef?.invocationId === i.id)) {
      const ref = t.executionRef!;
      if (i.nativeSessionId && !ref.nativeSessionId) ref.nativeSessionId = i.nativeSessionId;
      if (i.nativeTurnId && !ref.nativeTurnId) ref.nativeTurnId = i.nativeTurnId;
      if (this.released(ref, t.id, t.ownerRevision)) { t.lastExecutionRef = ref; delete t.executionRef; this.save(t, 'task.execution_released', { invocationId: i.id }); }
      else this.port.db.prepare('UPDATE cc_ordinary_tasks SET value=? WHERE id=?').run(JSON.stringify(t), t.id);
      if (t.pendingHandoffId) this.apply(t.pendingHandoffId);
    }
  }
  reconcile(): void { this.port.tx(() => { for (const h of this.rows<TaskHandoff>('cc_task_handoffs').filter(h => h.state === 'waiting')) this.apply(h.id); }); }
  pendingStops(): string[] {
    return [...new Set(this.rows<TaskHandoff>('cc_task_handoffs').filter(h => h.state === 'waiting' && h.stopRequested && h.executionRef).map(h => h.executionRef!.invocationId))]
      .filter(id => { const i = this.port.invocation(id); return !i.cancelRevision && (['prepared', 'running'].includes(i.status) || i.recoveryState === 'pending'); });
  }
  tool(invocationId: string, name: string, args: Record<string, unknown>, callId: string) {
    this.actor(invocationId); const i = this.port.invocation(invocationId);
    const allowed: Record<string, string[]> = { task_list: [], task_create: ['title', 'description', 'ownerMemberId'], task_update: ['taskId', 'expectedRevision', 'expectedOwnerRevision', 'status', 'reason'], task_handoff: ['taskId', 'expectedRevision', 'expectedOwnerRevision', 'targetMemberId', 'reason'] };
    if (!allowed[name] || Object.keys(args).some(key => !allowed[name]!.includes(key))) throw new AppError(400, '任务工具参数无效；身份与执行绑定只能由服务端生成。');
    if (name === 'task_list') return { tasks: this.list(i.conversationId), handoffs: this.handoffs(i.conversationId) };
    const requestId = `agent:${invocationId}:${text(callId, '工具调用标识', 100)}`;
    return this.port.tx(() => {
      const receipt = this.port.command(`task-tool:${invocationId}:${callId}`, { name, args }, () => {
    if (name === 'task_create') return this.create(i.conversationId, { requestId, title: args.title as string, description: args.description as string, ownerMemberId: args.ownerMemberId as string | null }, invocationId);
    const taskId = text(args.taskId, '任务 ID', 100), version = { requestId, expectedRevision: args.expectedRevision as number, expectedOwnerRevision: args.expectedOwnerRevision as number };
    if (name === 'task_update') return this.update(taskId, { ...version, status: args.status as UpdateOrdinaryTask['status'], reason: args.reason as string, disposition: args.disposition as UpdateOrdinaryTask['disposition'] }, invocationId);
    if (name === 'task_handoff') return this.handoff(taskId, { ...version, targetMemberId: args.targetMemberId as string, reason: args.reason as string }, invocationId);
    throw new AppError(400, '任务工具不存在。');
      }); return { ...receipt.result, replayed: receipt.replayed };
    });
  }
  projection(conversationId: string, at = Date.now()): ResponsibilityItem[] {
    const invocations = this.rows<CollaborationInvocation>('cc_invocations', 'WHERE conversation_id=?', [conversationId]);
    const evidence = this.rows<{ invocationId: string; createdAt: string }>('cc_evidence');
    const result: ResponsibilityItem[] = this.list(conversationId).map(t => {
      const i = invocations.find(i => i.id === t.executionRef?.invocationId), last = invocations.find(i => i.id === t.lastExecutionRef?.invocationId);
      const base = { key: `task:${t.id}`, kind: 'task' as const, taskId: t.id, ownerMemberId: t.ownerMemberId, memberId: i?.memberId ?? t.ownerMemberId ?? undefined, invocationId: i?.id };
      if (t.disposition || t.status === 'done') return { ...base, state: 'resolved', reason: `${t.disposition?.reason || '普通任务已明确完成。'}${i ? ' 原执行尚未释放，责任终结不替代退出证据。' : ''}`, disposition: t.disposition?.kind };
      if (t.pendingHandoffId) return { ...base, state: 'waiting', reason: '等待原任务执行的准确终态和退出证据，负责人尚未改变。' };
      if (i) {
        const latest = evidence.filter(e => e.invocationId === i.id).at(-1)?.createdAt ?? i.startedAt ?? i.createdAt;
        if (terminal.has(i.status)) return { ...base, state: 'attention', reason: '执行已终止呈现，但退出证据未齐，禁止重复启动。', diagnostic: 'dead' };
        return { ...base, state: 'active', reason: at - Date.parse(latest) > 300_000 ? '超过 5 分钟未观察到进展；仅提示，不判定退出。' : '准确任务执行进行中。', ...(at - Date.parse(latest) > 300_000 ? { diagnostic: 'zombie' as const } : {}) };
      }
      if (t.status === 'blocked') return { ...base, state: 'waiting', reason: t.statusReason || '任务明确等待条件，尚无自动唤醒。' };
      if (this.pending(t)) { const held = this.rows<Delivery>('cc_deliveries', 'WHERE source_id=?', [t.currentSourceId!]).find(d => d.status === 'held'); return { ...base, state: held ? 'waiting' : 'pending', sourceId: t.currentSourceId, reason: held?.holdReason || '任务已分配，等待原来源合法领取。' }; }
      if (!t.ownerMemberId) return { ...base, state: 'pending', reason: '未分配任务，等待用户指派或获授权成员领取。' };
      return { ...base, state: 'attention', reason: last && ['failed', 'interrupted', 'cancelled'].includes(last.status) ? '上一执行异常结束，任务未完成；需要明确后续工作。' : '任务未完成，目前没有执行或待投递来源承接。', diagnostic: last && ['failed', 'interrupted', 'cancelled'].includes(last.status) ? 'dead' : 'void' };
    });
    for (const s of this.rows<SourceWork>('cc_sources', 'WHERE conversation_id=?', [conversationId]).filter(s => !s.taskRef)) for (const d of this.rows<Delivery>('cc_deliveries', 'WHERE source_id=?', [s.id])) {
      const i = invocations.find(i => i.responseId === d.responseId);
      result.push({ key: `message:${d.id}`, kind: 'message', sourceId: s.id, memberId: d.memberId, invocationId: i?.id,
        state: d.status === 'held' ? 'waiting' : d.status === 'pending' ? 'pending' : i && (!terminal.has(i.status) || i.teardown !== 'confirmed') ? 'active' : 'resolved',
        reason: d.holdReason || (d.status === 'pending' ? '原消息投递等待领取，不改变任务负责人。' : i?.teardown === 'unknown' ? '准确执行尚未释放。' : '此消息投递已有处理事实，不代表普通任务已完成。') });
    }
    return result;
  }
}
