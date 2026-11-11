import { userAcceptanceQuote } from './user-acceptance.js';
import { ciTargets, observedCi } from './obligation-ci.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { AcceptanceEvidence, CollaborationInvocation, ConversationMessage, Delivery, MentionGroup, OrdinaryTask, ProjectReviewCheck, SourceWork, TaskHandoff } from '../../shared/collaboration.js';
import type { Obligation, ObligationDelegation, ObligationEndpoint, ObligationReport, OperatorObligation } from '../../shared/obligations.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';

export function migrateObligations(db: DatabaseSync) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS cc_obligations(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS cc_obligations_room ON cc_obligations(conversation_id)',
    "CREATE UNIQUE INDEX IF NOT EXISTS cc_obligation_root_task ON cc_obligations(json_extract(value,'$.taskId')) WHERE json_extract(value,'$.taskId') IS NOT NULL",
    'CREATE TABLE IF NOT EXISTS cc_obligation_sources(source_id TEXT NOT NULL REFERENCES cc_sources(id), obligation_id TEXT NOT NULL REFERENCES cc_obligations(id), PRIMARY KEY(source_id,obligation_id))',
    'CREATE INDEX IF NOT EXISTS cc_obligation_source_owner ON cc_obligation_sources(obligation_id)'
  ].join(';'));
}

const terminal = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const ended = (o: Obligation) => o.state === 'delivered' || o.state === 'cancelled';
function conflict(message: string): never { throw new AppError(409, message, 'obligation_conflict'); }
function value(input: unknown, label: string, max = 2000): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max) throw new AppError(400, label + '无效。');
  return input.trim();
}
function same(a: ObligationEndpoint, b: ObligationEndpoint) {
  return a.memberId === b.memberId && a.instanceId === b.instanceId && a.generation === b.generation;
}
interface WaitSignal {requestId:string;expectedRevision:number;condition:string;summary:string;waitId:string}
interface Observation { id: string; invocationId: string; }
export class ObligationService {
  constructor(private readonly store: CollaborationStore) {}
  private get port() { return this.store.artifacts.port; }
  private clock() { return this.store.options.clock?.() ?? Date.now(); }
  private room(cid: string) {
    const room = this.store.workbench.conversation(cid);
    if (room.archivedAt || room.deletedAt || room.importedFor) conflict('会话不可继续公开责任。');
    return room;
  }
  private endpoint(cid: string, memberId: string): ObligationEndpoint {
    this.room(cid);
    this.store.artifacts.target(cid, memberId);
    const instance = this.store.roomMembers.resolve(cid, memberId);
    if (!instance?.active) conflict('责任成员实例不可用。');
    return { memberId, instanceId: instance.id, generation: instance.generation };
  }
  private publicOrigin(id: string) {
    const run = this.store.invocation(id), c = this.store.contract(id), source = this.store.visibility.primary(id);
    if (!c.obligationPolicy || !c.roomMember ||
        c.roomMember.conversationId !== run.conversationId || c.roomMember.memberId !== run.memberId || !c.roomMember.active ||
        source.withdrawnAt || c.visibility || source.visibility || source.excerptRefs?.length || source.crossRef || source.actionRef ||
        run.acceptance !== 'accepted' || (run.cancelRevision ?? 0) !== 0) conflict('责任操作需要本房间的有效公开执行和真实接受证据。');
    return {run,source,originalMember:c.roomMember};
  }
  private actor(id: string, requireRunning = true) {
    const {run,source,originalMember} = this.publicOrigin(id);
    const member = this.endpoint(run.conversationId, run.memberId);
    if (originalMember.id !== member.instanceId || originalMember.generation !== member.generation) conflict('责任执行所属的房间成员已变化。');
    if (requireRunning) {
      this.store.tasks.actor(id);
      this.store.visibility.validateInvocation(id);
    }
    return { run, source, member };
  }
  private raw(cid: string) { return this.store.artifacts.rows<Obligation>('cc_obligations', cid); }
  private row(cid: string, id: string) {
    const row = this.store.artifacts.get<Obligation>('cc_obligations', id);
    if (row.conversationId !== cid) throw new AppError(404, '找不到该责任。');
    return row;
  }
  private save(o: Obligation, reason: string, returnedChildId?: string) {
    o.revision++; o.updatedAt = now();
    this.store.artifacts.save('cc_obligations', o, 'obligation.' + reason);
    this.store.factors.recordObligation(o, reason, returnedChildId);
    return o;
  }
  private link(source: string, id: string) {
    this.store.db.prepare('INSERT OR IGNORE INTO cc_obligation_sources VALUES(?,?)').run(source, id);
  }
  isBoundSource(id: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM cc_obligation_sources WHERE source_id=? LIMIT 1').get(id);
  }
  private forSource(id: string): Obligation[] {
    const rows = this.store.db.prepare('SELECT o.value FROM cc_obligation_sources s JOIN cc_obligations o ON o.id=s.obligation_id WHERE s.source_id=?').all(id) as {value:string}[];
    return rows.map(r => JSON.parse(r.value));
  }
  /** Adoption uses the applied TaskHandoff and the actual task-source delivery. */
  private owner(o: Obligation) {
    if (!o.taskId || ended(o)) return o;
    const t = this.store.tasks.getTask(o.taskId);
    if (t.ownerRevision === o.ownerRevision) return o;
    const h = this.store.tasks.handoffs(o.conversationId).findLast(h => h.taskId === t.id && h.state === 'applied' &&
      h.expectedOwnerRevision + 1 === t.ownerRevision && h.toMemberId === t.ownerMemberId);
    if (!h || !t.ownerMemberId) conflict('任务负责人变更缺少正式交接证据。');
    o.owner = this.endpoint(o.conversationId, t.ownerMemberId); o.ownerRevision = t.ownerRevision;
    o.currentSourceId = h.sourceId; o.reminderCount = 0;
    if (o.state === 'delivery_pending' || o.state === 'awaiting_acceptance') { o.state = 'open'; delete o.delivery; }
    this.link(h.sourceId, o.id);
    return this.save(o, 'handoff_applied');
  }
  list(cid: string) { return this.raw(cid); }
  context(id: string) {
    const {run, source, member} = this.actor(id, false);
    return this.port.tx(() => this.raw(run.conversationId).filter(o => {
      if (ended(o)) return false;
      this.owner(o);
      return o.currentSourceId === source.id && same(o.owner, member);
    }));
  }
  private authorize(id: string, key: unknown) {
    const {run, source, member} = this.actor(id);
    const o = this.owner(this.row(run.conversationId, value(key, '责任编号', 100)));
    if (ended(o) || o.currentSourceId !== source.id || !same(o.owner, member)) conflict('此执行没有当前责任的交付权。');
    if (o.taskId) {
      const t = this.store.tasks.getTask(o.taskId);
      if (t.pendingHandoffId || t.disposition || t.status === 'done' || t.status === 'blocked' || t.ownerMemberId !== run.memberId ||
          (t.executionRef && t.executionRef.invocationId !== id)) conflict('任务负责人或执行权已变化。');
    }
    return {o,run,source};
  }
  settleHandoffOffer(h: TaskHandoff) {
    if (!h.offer) return;
    const o = this.row(h.conversationId,h.offer.obligationId);
    if (ended(o) || o.taskId !== h.taskId || o.ownerRevision !== h.expectedOwnerRevision || o.owner.instanceId !== h.offer.issuer.id) return;
    if (h.state === 'applied') { this.owner(o); return; }
    if (h.state !== 'refused' || o.state !== 'open') return;
    if (!this.store.roomMembers.isCurrent(h.offer.issuer)) {
      this.block(o,'交班未生效，原负责人身份已变化。'); return;
    }
    if (h.actor.kind !== 'agent' || this.store.invocation(h.actor.invocationId).cancelRevision ||
        this.store.artifacts.get<SourceWork>('cc_sources',h.actor.sourceId).withdrawnAt) {
      this.block(o,'交班未生效，原执行或委托已撤销。'); return;
    }
    this.wake(o,'交班未生效，责任仍在你手中。原因：'+h.reason);
    this.save(o,'handoff_refused');
  }
  private acceptanceRequest(invocationId: string, source: SourceWork): Obligation['userAcceptance'] {
    if (source.taskRef && (source.kind === 'task' || source.kind === 'task_handoff')) {
      const snapshot = this.store.contract(invocationId).taskSnapshot;
      if (!snapshot || snapshot.createdBy.kind !== 'user' || snapshot.id !== source.taskRef.taskId ||
          snapshot.conversationId !== source.conversationId || snapshot.ownerRevision !== source.taskRef.ownerRevision ||
          snapshot.ownerMemberId !== this.store.invocation(invocationId).memberId) return;
      // The immutable command result contains the original form values, before any handoff exists.
      const row = this.store.db.prepare("SELECT result FROM cc_commands WHERE request_id GLOB ? AND json_extract(result,'$.task.id')=? LIMIT 1")
        .get('task-create:'+source.conversationId+':*',snapshot.id) as {result:string}|undefined;
      const original: OrdinaryTask|undefined = row && JSON.parse(row.result).task;
      if (!original || original.createdBy.kind !== 'user' || original.conversationId !== source.conversationId ||
          original.title !== snapshot.title || original.description !== snapshot.description) return;
      const quote = userAcceptanceQuote([original.title,original.description].join('\n'));
      return quote ? {taskId:original.id,sourceRevision:source.revision,quote} : undefined;
    }
    if (source.kind !== 'user' || source.parentInvocationId || source.authorMemberId || source.projectFollowupOf ||
        source.projectRepair || source.projectCiRepair || source.taskRef || source.visibility || source.excerptRefs?.length) return;
    const raw = this.store.db.prepare("SELECT value FROM cc_messages WHERE conversation_id=? AND json_extract(value,'$.sourceId')=? AND json_extract(value,'$.author')='user' LIMIT 1")
      .get(source.conversationId,source.id) as {value:string}|undefined;
    const message: ConversationMessage|undefined = raw && JSON.parse(raw.value);
    if (!message || message.deletedAt || message.visibility || message.branchOrigin || !message.content.trim() || message.content.trim() !== source.routingContent ||
        !(source.content === message.content || ((source.replyTo || source.attachmentIds?.length) && source.content.startsWith(message.content + '\n')))) return;
    const quote = userAcceptanceQuote(message.content);
    return quote ? {messageId:message.id,sourceRevision:source.revision,quote} : undefined;
  }
  private open(id: string, args: Record<string,unknown>, callId: string) {
    const {run,source,member} = this.actor(id);
    if (this.room(run.conversationId).collaborationMode !== 'continuous') conflict('会话已关闭持续跟进。');
    if (source.kind !== 'user' && !source.taskRef) conflict('仅实际用户委托或已消费的任务可以登记根责任。');
    const goal = value(args.goal, '交付目标');
    if (args.acceptance !== undefined && args.acceptance !== 'user' && args.acceptance !== 'delivery') conflict('验收方式无效。');
    const resumed = this.forSource(source.id).find(o => !o.parentId && o.currentSourceId === source.id && o.originSourceId !== source.id && same(o.owner,member));
    if (resumed) return resumed;
    const prior = this.forSource(source.id).filter(o => !o.parentId && o.originSourceId === source.id && same(o.owner,member));
    // Existing contracts keep their own acceptance policy. New goals on one user request share
    // a single root; a later tool call cannot carve a different approval boundary out of its text.
    const old = prior.find(o => o.goal === goal) ?? prior[0];
    if (old) return old;
    const userAcceptance = this.acceptanceRequest(id,source), acceptBy = userAcceptance ? 'user' : 'delivery';
    let taskId = source.taskRef?.taskId;
    if (taskId) {
      this.store.tasks.executionAuthority(taskId, this.store.tasks.actor(id));
      if (this.raw(run.conversationId).some(o => o.taskId === taskId)) conflict('此任务已经登记责任。');
    } else {
      taskId = this.store.tasks.create(run.conversationId, {requestId:'obligation-' + id + '-' + callId, title:goal.slice(0,200),
        description:goal,ownerMemberId:run.memberId},id).task.id;
    }
    const t = this.store.tasks.getTask(taskId);
    const o: Obligation = {id:randomUUID(), conversationId:run.conversationId, taskId, ownerRevision:t.ownerRevision, owner:member, goal,
      acceptance:acceptBy === 'user' ? '用户确认最终交付' : '向用户公开交付', acceptBy, ...(userAcceptance && {userAcceptance}), state:'open', originSourceId:source.id,
      originInvocationId:id, currentSourceId:source.id, reminderCount:0, revision:0, createdAt:now(), updatedAt:now()};
    this.save(o,'opened'); this.link(source.id,o.id); return o;
  }
  /** Called from inside the existing authorized A2A creation command. Throwing rolls back the delivery too. */
  bindDelegation(id: string, source: SourceWork, input: ObligationDelegation) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['obligationId','version','acceptance'].includes(k))) throw new AppError(400,'交付约定参数无效。');
    const {o:parent, run} = this.authorize(id,input.obligationId);
    if (parent.parentId || !['open','blocked'].includes(parent.state) || source.kind !== 'a2a' || source.parentInvocationId !== id ||
        source.conversationId !== run.conversationId || source.requestedTargets.length !== 1 || source.authorMemberId !== run.memberId ||
        source.requestedTargets[0] === run.memberId || source.visibility || source.excerptRefs?.length) conflict('子委托必须来自负责人的准确执行并指向一位独立成员。');
    const version = value(input.version,'受验版本',256), acceptance = value(input.acceptance,'验收条件');
    const authorTest = source.projectReview && this.proofs(id).findLast(e =>
      e.kind === 'tool' && e.detail.origin === 'project_author_test' && e.detail.name === 'project_npm_test' && e.detail.state === 'tested' &&
      e.detail.treeExited === true && e.detail.snapshotSha256 === version && Array.isArray(e.detail.argv));
    if (source.projectReview && (!/^[a-f0-9]{64}$/.test(version) || !authorTest)) conflict('项目评审必须绑定作者实际检查的快照 SHA-256 和命令。');
    if (this.store.contract(id).projectWork && !source.projectReview) conflict('项目责任验证需要使用获准的项目评审委托。');
    const previous = this.raw(parent.conversationId).filter(o => o.parentId === parent.id).at(-1);
    if (previous?.projectReview && !source.projectReview) conflict('项目复验必须沿用项目评审权限。');
    if (previous && previous.state === 'blocked') {
      previous.state = 'cancelled'; previous.reason = '负责人已另行委托复验。'; this.save(previous,'superseded');
    }
    const owner = this.endpoint(parent.conversationId, source.requestedTargets[0]);
    const child: Obligation = {id:randomUUID(),conversationId:parent.conversationId,parentId:parent.id,owner,returnTo:parent.owner,
      goal:source.content,acceptance,version,acceptBy:'report',state:'open',originSourceId:source.id,originInvocationId:id,
      currentSourceId:source.id,reminderCount:0,revision:0,createdAt:now(),updatedAt:now(),...(authorTest ? {projectReview:true,testArgv:authorTest.detail.argv as string[]} : {})};
    this.save(child,'delegated'); this.link(source.id,child.id);
    parent.state = 'delegated'; delete parent.reason;
    this.save(parent,'waiting_for_child'); return child;
  }
  private proofs(id: string) {
    return (this.store.db.prepare('SELECT value FROM cc_evidence WHERE invocation_id=? ORDER BY rowid').all(id) as {value:string}[])
      .map(r => JSON.parse(r.value) as AcceptanceEvidence);
  }
  private originalReview(o: Obligation): Observation | undefined {
    const receipt = this.store.db.prepare('SELECT i.id AS invocationId, i.response_id AS id FROM cc_consumptions x JOIN cc_invocations i ON i.response_id=x.response_id WHERE x.source_id=? AND i.member_id=? ORDER BY x.rowid LIMIT 1')
      .get(o.originSourceId,o.owner.memberId) as unknown as Observation | undefined;
    return receipt;
  }
  private report(id: string, args: Record<string,unknown>) {
    const {o,run} = this.authorize(id,args.obligationId);
    if (o.parentId && this.row(o.conversationId,o.parentId).state !== 'delegated') conflict('上游不再等待这次回报。');
    const outcome = args.outcome;
    if (!o.parentId || o.state !== 'open' || args.version !== o.version || !['passed','failed','blocked'].includes(String(outcome))) conflict('回报需要匹配当前子责任和固定版本。');
    const summary = value(args.summary,'回报说明'), evidenceIds: string[] = [];
    const report: ObligationReport = {outcome:outcome as ObligationReport['outcome'],version:o.version!,summary,invocationId:id,evidenceIds,authority:'member'};
    if (o.projectReview && outcome !== 'blocked') {
      const original = this.originalReview(o);
      if (!original) conflict('找不到准确项目评审执行。');
      this.actor(original.invocationId,false);
      const c = this.store.contract(original.invocationId), scope = c.projectReview!;
      this.store.projectReviews.requireGrant(o.conversationId,run.memberId,scope.grantRevision,c.workspaceGrant);
      const proofs = this.proofs(original.invocationId).filter(e => e.kind === 'tool' && e.detail.origin === 'project_review');
      const tests = proofs.filter(e => e.detail.state === 'tested' && e.detail.name === 'project_review_test' &&
        e.detail.treeExited === true && e.detail.snapshotSha256 === o.version && JSON.stringify(e.detail.argv) === JSON.stringify(o.testArgv) && Number.isInteger(e.detail.exitCode));
      const test = tests.at(-1);
      if (!test || (outcome === 'passed') !== (test.detail.exitCode === 0) || (args.evidenceId && args.evidenceId !== test.id)) conflict('当前受验快照缺少匹配结论的独立测试回执。');
      const reads = proofs.filter(e => e.detail.state === 'read' && e.detail.name === 'project_review_read');
      if (!reads.length || scope.paths.some(path => !reads.some(e => e.detail.path === path))) conflict('请先独立读取本轮受验文件。');
      report.authority = 'project_test'; evidenceIds.push(...reads.map(e => e.id),test.id);
    } else if (args.evidenceId !== undefined) {
      const evidence = this.proofs(id).find(e => e.id === args.evidenceId && e.kind === 'tool');
      if (!evidence) conflict('证据不属于此次准确执行。');
      evidenceIds.push(evidence.id);
    }
    o.report = report; o.state = 'delivery_pending'; return this.save(o,'report_submitted');
  }
  private deliver(id: string, args: Record<string,unknown>) {
    const {o} = this.authorize(id,args.obligationId);
    if (o.parentId || o.state !== 'open') conflict('当前责任尚不具备最终交付条件。');
    const last = this.raw(o.conversationId).filter(x => x.parentId === o.id).at(-1);
    if (last && (last.state !== 'delivered' || last.report?.outcome !== 'passed')) conflict('子委托未通过，不能完成最终交付。');
    o.delivery = {invocationId:id,summary:value(args.summary,'最终交付')}; o.state = 'delivery_pending';
    return this.save(o,'delivery_submitted');
  }
  private wait(id: string, args: Record<string,unknown>) {
    const {o} = this.authorize(id,args.obligationId);
    if (o.parentId || o.state !== 'open') conflict('请在开放的主责任上登记等待。');
    const deadline = value(args.deadline,'截止时间',64), condition = value(args.condition,'等待条件');
    const durable = this.store.contract(id).continuationPolicy === 'durable-v1';
    const kind = args.kind === undefined && durable ? 'event' : args.kind;
    if (kind !== undefined && (!durable || (kind !== 'event' && kind !== 'timer'))) conflict('本轮不支持这种等待方式。');
    if (kind === 'timer' && condition.startsWith('ci:')) conflict('CI 结果必须来自真实的运行记录。');
    if (condition.startsWith('ci:') && !ciTargets(this.store,id).some(target => target.condition === condition)) conflict('请选择本实例已经获准交付的 PR 和准确提交。');
    if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= this.clock()) conflict('请指定未来的有效截止时间。');
    if (kind && (o.waitCount ?? 0) >= 16) return this.block(o,'已连续登记 16 次等待，请负责人核对进展。');
    if (kind) o.waitCount = (o.waitCount ?? 0) + 1;
    o.wait = {id:randomUUID(), condition, deadline:new Date(deadline).toISOString(),
      ...(kind && {kind, returnTo:{...o.owner}, ownerRevision:o.ownerRevision})};
    o.state = 'waiting';
    return this.save(o,'waiting');
  }
  tool(id: string, name: string, args: Record<string,unknown>, callId: string) {
    this.actor(id);
    const keys:Record<string,string[]> = {obligation_list:[],obligation_open:['goal','acceptance'],obligation_handoff:['obligationId','targetMemberId','reason'],obligation_report:['obligationId','version','outcome','summary','evidenceId'],obligation_deliver:['obligationId','summary'],obligation_wait:['obligationId','condition','deadline','kind']};
    if (!keys[name] || Object.keys(args).some(k => !keys[name]!.includes(k))) throw new AppError(400,'责任工具参数无效；身份与执行只能由平台提供。');
    if (name === 'obligation_list') {
      const obligations = this.context(id);
      const receipts = obligations.filter(o => !o.parentId).flatMap(o => this.raw(o.conversationId)
        .filter(child => child.parentId === o.id && child.report && (ended(child) || child.state === 'blocked'))
        .map(child => ({obligationId:o.id,childId:child.id,version:child.version,state:child.state,report:child.report})));
      return {obligations,receipts};
    }
    const key = value(callId,'调用编号',160);
    return this.port.tx(() => this.port.command('obligation-tool:' + id + ':' + key,{name,args},() => {
      if (name === 'obligation_handoff') {
        if (this.store.contract(id).handoffPolicy !== 'consent-v2') throw new AppError(403,'本轮冻结的工具契约不支持按委托交班。');
        const {o} = this.authorize(id,args.obligationId);
        if (o.parentId || !o.taskId || o.state !== 'open') conflict('仅开放的主委托可发起整项交班。');
        const t = this.store.tasks.getTask(o.taskId);
        const {handoff} = this.store.tasks.handoff(t.id,{requestId:randomUUID(),expectedRevision:t.revision,expectedOwnerRevision:o.ownerRevision!,
          targetMemberId:value(args.targetMemberId,'候选成员',100),reason:value(args.reason,'交班说明')},id);
        if (handoff.offer?.obligationId !== o.id) conflict('交班邀请未与原委托绑定。');
        return {obligation:o,handoff};
      }
      let obligation: Obligation;
      switch (name) {
        case 'obligation_open': obligation = this.open(id,args,key); break;
        case 'obligation_report': obligation = this.report(id,args); break;
        case 'obligation_deliver': obligation = this.deliver(id,args); break;
        case 'obligation_wait': obligation = this.wait(id,args); break;
        default: throw new AppError(400,'未知责任工具。');
      }
      return {obligation};
    }).result);
  }

  private block(o: Obligation, reason: string) {
    if (o.state === 'blocked' && o.reason === reason || ended(o)) return o;
    o.state = 'blocked'; o.reason = reason; delete o.blockedReturnSourceId; return this.save(o,'blocked');
  }
  private wake(o: Obligation, content: string) {
    const owner = this.endpoint(o.conversationId,o.owner.memberId);
    if (!same(o.owner,owner)) conflict('接回成员代次已变化。');
    const source = this.store.admitSource({conversationId:o.conversationId,kind:'job_result',requestedTargets:[owner.memberId],
      content:'责任 ' + o.id + ' · ' + o.goal + '\n' + content + '\n请先查询本轮委托，再决定下一步。',depth:0});
    o.currentSourceId = source.id; o.wakeSourceId = source.id; this.link(source.id,o.id);
  }
  beginGroup(id: string, key: unknown, group: MentionGroup): NonNullable<MentionGroup['contract']> | string {
    if (this.store.contract(id).continuationPolicy !== 'durable-v1') conflict('此次执行尚未启用持续征询。');
    const {o} = this.authorize(id, key);
    if (o.parentId || o.activeGroupId || !['open', 'blocked'].includes(o.state)) {
      conflict('仅当前负责的开放或待复核主委托可登记持续征询。');
    }
    const participants = group.targets.map(memberId => this.endpoint(o.conversationId, memberId));
    if ((o.groupCount ?? 0) >= 16) {
      const reason = '此委托的 16 次持续征询额度已用尽；请依据已有结果交付或由用户复核。';
      this.block(o, reason);
      return reason;
    }
    o.activeGroupId = group.id;
    o.groupCount = (o.groupCount ?? 0) + 1;
    o.state = 'waiting';
    delete o.reason; delete o.wait; delete o.blockedReturnSourceId;
    this.save(o, 'collecting');
    return {version:2, obligationId:o.id, ownerRevision:o.ownerRevision!, returnTo:{...o.owner}, participants};
  }

  groupIssue(g: MentionGroup): string | undefined {
    const contract = g.contract!;
    const o = this.row(g.conversationId, contract.obligationId);
    if (o.activeGroupId !== g.id || o.state !== 'waiting') return '主委托已不再等待本次征询。';
    const task = o.taskId && this.store.tasks.getTask(o.taskId);
    if (task && (task.pendingHandoffId || task.ownerRevision !== contract.ownerRevision || task.ownerMemberId !== contract.returnTo.memberId || task.disposition || ['done','blocked'].includes(task.status))) return '主任务的交付权已变化。';
    try {
      if (!same(o.owner, contract.returnTo) || !same(contract.returnTo, this.endpoint(g.conversationId, o.owner.memberId))) return '接回成员已变化。';
      for (const participant of contract.participants) {
        if (!same(participant, this.endpoint(g.conversationId, participant.memberId))) return '参与成员已退房或重新加入。';
      }
    } catch (e) { if (!(e instanceof AppError)) throw e; return '会话或约定的成员已不可用。'; }
  }

  settleGroup(g: MentionGroup) {
    const contract = g.contract!;
    const o = this.row(g.conversationId, contract.obligationId);
    if (o.activeGroupId !== g.id || ended(o)) return;
    delete o.activeGroupId;
    if (g.state === 'cancelled' || g.state === 'lost') {
      const reason = g.reason ?? '持续征询已取消，等待负责人复核。';
      o.state = 'blocked'; o.reason = reason; delete o.blockedReturnSourceId;
      this.save(o, 'collection_blocked'); return;
    }
    const collected = (g.results ?? []).map(r =>
      '[' + r.memberId + ' · ' + (r.status === 'failed' ? '执行失败' : '已答复') + '] ' + r.content);
    const status = g.state === 'timeout'
      ? '本次征询已到期。缺少答复：' + g.missing!.join('、')
      : '参与成员均已回报。请结合各份答复判断下一步。';
    this.wake(o, ['持续征询 ' + g.id + ' · ' + g.question, status, ...collected].join('\n'));
    contract.wakeSourceId = o.currentSourceId;
    o.state = 'open'; o.reminderCount = 0;
    this.save(o, 'collection_returned');
  }
  private returnReport(child: Obligation) {
    const parent = this.row(child.conversationId,child.parentId!);
    if (ended(parent) || parent.state !== 'delegated') return;
    try {
      this.owner(parent);
      if (parent.taskId && this.store.tasks.getTask(parent.taskId).pendingHandoffId) return;
      const pass = child.state === 'delivered' && child.report?.outcome === 'passed';
      this.wake(parent, '子委托 ' + child.id + '，版本 ' + child.version + '。' +
        (child.report?.summary ?? child.reason ?? '没有取得有效结论。') +
        (pass ? '\n独立核验通过，可决定向用户交付。' : '\n核验未通过，请安排复验或说明阻塞。'));
      parent.state = pass ? 'open' : 'blocked'; parent.reason = pass ? undefined : '子责任未通过，需要负责人处理。';
      parent.blockedReturnSourceId = pass ? undefined : parent.currentSourceId;
      this.save(parent,'result_returned',child.id);
    } catch (e) { if (!(e instanceof AppError)) throw e; this.block(parent,'约定的接回成员不可用。'); }
  }
  private latestChild(o: Obligation) { return this.raw(o.conversationId).filter(child => child.parentId === o.id).at(-1); }
  private checkProjectIdentity(child: Obligation) {
    const original = this.originalReview(child);
    if (!original) conflict('原项目核验执行缺失。');
    const {member} = this.actor(original.invocationId,false), c = this.store.contract(original.invocationId);
    if (!same(member,child.owner) || !c.projectReview || !c.workspaceGrant) conflict('原项目核验身份失效。');
    this.store.projectReviews.originalRequest(child.conversationId,c.projectReview);
    return this.store.projectReviews.requireGrant(child.conversationId,member.memberId,c.projectReview.grantRevision,c.workspaceGrant);
  }
  /** Use the VM runner's exact manifest algorithm without copying files or running project commands. */
  private async currentVersion(child: Obligation, signal?: AbortSignal) {
    const grant = this.checkProjectIdentity(child);
    const helper = fileURLToPath(new URL('../../scripts/runtime/project-review-test.py',import.meta.url));
    const script = [
      'import os,runpy,sys', 'p,root,dev,ino=sys.argv[1:]', 'fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)',
      's=os.fstat(fd)', 'if (s.st_dev,s.st_ino)!=(int(dev),int(ino)): raise SystemExit(2)',
      'print(runpy.run_path(p)["snapshot"](fd))'
    ].join('\n');
    let digest: string;
    try {
      const result = await promisify(execFile)('/usr/bin/python3',['-I','-c',script,helper,grant.path,String(grant.device),String(grant.inode)],
        {cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:15000,maxBuffer:2048,signal});
      digest = result.stdout.trim();
    } catch { signal?.throwIfAborted(); conflict('无法复核当前项目快照，尚未确认最终交付。'); }
    this.checkProjectIdentity(child);
    if (digest !== child.version) conflict('当前项目快照与已通过的版本不同，请复验当前版本。');
    return digest;
  }
  async verifyDelivery(id: string, signal?: AbortSignal) {
    const run = this.store.invocation(id);
    for (const o of this.raw(run.conversationId).filter(o => o.state === 'delivery_pending' && o.delivery?.invocationId === id)) {
      const child = this.latestChild(o);
      if (!child?.projectReview) continue;
      let version: string;
      try { version = await this.currentVersion(child,signal); }
      catch (e) {
        if (e instanceof AppError) this.port.tx(() => {
          const current = this.row(o.conversationId,o.id);
          if (current.state === 'delivery_pending' && current.revision === o.revision) this.block(current,e.message);
        });
        throw e;
      }
      this.authorize(id,o.id);
      this.store.recordEvidence(id,{kind:'tool',detail:{origin:'obligation_delivery',obligationId:o.id,childId:child.id,version,revision:o.revision,state:'verified'}});
    }
  }
  private reviewedFiles(child: Obligation) {
    const original = this.originalReview(child);
    if (!original) return false;
    const checked = this.proofs(original.invocationId).findLast(e => e.kind === 'tool' && e.detail.origin === 'project_review' && e.detail.state === 'checked');
    const files = checked?.detail.files as ProjectReviewCheck['files'] | undefined;
    return Array.isArray(files) && files.length > 0 && files.every(f => f.status === 'unchanged');
  }
  private finishTask(o: Obligation) {
    if (!o.taskId || !o.delivery?.messageId) conflict('主责任缺少关联任务或公开交付记录。');
    this.store.tasks.finishObligation(o.id,o.delivery.messageId);
  }
  /** Called after the response and its public message have been committed to the transaction. */
  onFinish(run: CollaborationInvocation) {
    const contract = this.store.contract(run.id);
    if (!contract.obligationPolicy || !contract.primarySourceId || !terminal.has(run.status)) return;
    this.port.tx(() => {
      for (const row of this.forSource(contract.primarySourceId!)) {
        if (ended(row) || row.currentSourceId !== contract.primarySourceId || row.owner.memberId !== run.memberId) continue;
        this.settle(row,run);
      }
    });
  }
  private settle(o: Obligation, run: CollaborationInvocation) {
    if (run.status === 'cancelled' || (run.cancelRevision ?? 0) > 0) {
      this.block(o,'准确执行已取消；保留既有结果，等待负责人复核。');
      if (o.parentId) this.returnReport(o);
      return;
    }
    if (o.state === 'delegated' || o.state === 'waiting' || o.state === 'awaiting_acceptance') return;
    if (o.state === 'blocked') return;
    try {
      this.owner(o);
      if (o.currentSourceId !== this.store.contract(run.id).primarySourceId) return;
      if (o.taskId && this.store.tasks.getTask(o.taskId).pendingHandoffId) return;
      const {member} = this.actor(run.id,false);
      if (!same(member,o.owner) || !same(member,this.endpoint(o.conversationId,run.memberId))) conflict('责任接手人已失效。');
      if (run.status !== 'succeeded') conflict(run.error ?? '执行未成功，需要核查原执行。');
      if (run.teardown !== 'confirmed') return;
      if (o.report && o.report.invocationId === run.id) {
        if (o.projectReview && o.report.outcome === 'passed') {
          this.checkProjectIdentity(o);
          if (!this.reviewedFiles(o)) conflict('受验文件读取后已变化或缺少结束核对。');
        }
        o.state = o.report.outcome === 'passed' ? 'delivered' : 'blocked';
        if (o.state === 'blocked') o.reason = o.report.summary;
        this.save(o,'report_checked'); this.returnReport(o); return;
      }
      if (o.delivery?.invocationId === run.id) {
        const raw = this.store.db.prepare('SELECT value FROM cc_messages WHERE response_id=? AND conversation_id=?').get(run.responseId,run.conversationId) as {value:string} | undefined;
        const message: ConversationMessage | undefined = raw && JSON.parse(raw.value);
        if (!message || message.author !== 'member' || message.memberId !== run.memberId || message.visibility || !message.content.includes(o.delivery.summary)) conflict('公开回复未包含登记的交付内容。');
        const child = this.latestChild(o);
        if (child?.projectReview && !this.proofs(run.id).some(e => e.kind === 'tool' && e.detail.origin === 'obligation_delivery' &&
            e.detail.state === 'verified' && e.detail.obligationId === o.id && e.detail.revision === o.revision && e.detail.childId === child.id && e.detail.version === child.version)) conflict('缺少最终交付时的项目版本核对。');
        o.delivery.messageId = message.id;
        if (o.acceptBy === 'delivery') this.finishTask(o);
        o.state = o.acceptBy === 'user' ? 'awaiting_acceptance' : 'delivered';
        this.save(o,'delivery_recorded'); return;
      }
      if (o.reminderCount >= 1) conflict('一次补交机会已用尽，仍缺少约定交付。');
      this.wake(o,'上一执行已释放，请补交原回执或说明阻塞。只需核对现有结果，无需重做已执行操作。');
      o.reminderCount++; this.save(o,'reminded');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.block(o,error.message);
      if (o.parentId) this.returnReport(o);
    }
  }
  bindAdmission(source: SourceWork, run: CollaborationInvocation) {
    if (source.kind === 'user' && source.projectWork && source.replyTo && !source.visibility && !source.excerptRefs?.length && run.roomMember &&
        source.requestedTargets.length === 1 && this.room(source.conversationId).collaborationMode === 'continuous') {
      const message = this.store.artifacts.get<ConversationMessage>('cc_messages',source.replyTo);
      if (message.conversationId !== run.conversationId || message.deletedAt || message.visibility || message.branchOrigin) return;
      const quoted = message.sourceId ?? (message.responseId && this.store.contract(this.store.response(message.responseId).invocationId).primarySourceId);
      if (!quoted) return;
      const matches = this.forSource(quoted).filter(o => o.state === 'blocked' && o.taskId && !o.parentId &&
        o.owner.instanceId === run.roomMember!.id && o.owner.memberId === run.memberId && o.owner.generation === run.roomMember!.generation);
      if (matches.length !== 1) return;
      const o = matches[0]!, t = this.store.tasks.getTask(o.taskId!);
      const original = this.store.artifacts.get<SourceWork>('cc_sources',o.originSourceId);
      if (t.pendingHandoffId || t.executionRef || t.disposition || t.status === 'done' || t.status === 'blocked' || t.ownerRevision !== o.ownerRevision ||
          !original.projectWork || original.withdrawnAt || original.projectGrantRevision !== source.projectGrantRevision) return;
      const current = this.store.db.prepare("SELECT 1 FROM cc_deliveries WHERE source_id=? AND status IN ('pending','held')").get(o.currentSourceId);
      if (current) return;
      this.store.tasks.bindObligation(o.taskId!,source,run);
      o.currentSourceId = source.id; o.state = 'open'; o.reminderCount = 0; delete o.delivery; delete o.reason; delete o.blockedReturnSourceId;
      this.link(source.id,o.id); this.save(o,'project_reopened'); return;
    }
    if (source.kind !== 'job_result') return;
    for (const o of this.forSource(source.id)) {
      if (o.taskId && o.currentSourceId === source.id && o.wakeSourceId === source.id && !ended(o) &&
          run.roomMember?.id === o.owner.instanceId && run.roomMember.generation === o.owner.generation &&
          same(o.owner,this.endpoint(run.conversationId,run.memberId))) this.store.tasks.bindObligation(o.taskId,source,run);
    }
  }
  admissionReason(source: SourceWork): string | undefined {
    const linked = this.forSource(source.id);
    if (!linked.length || source.kind === 'user') return;
    try {
      for (const o of linked) {
        if (ended(o) || o.currentSourceId !== source.id || !same(o.owner,this.endpoint(o.conversationId,o.owner.memberId))) return '责任或成员代次已变化。';
        if (o.parentId && this.row(o.conversationId,o.parentId).state !== 'delegated') return '上游不再等待这次交付。';
        if (o.state === 'blocked' && o.blockedReturnSourceId !== source.id) return '责任已阻塞，等待显式处理。';
      }
    } catch (e) { if (!(e instanceof AppError)) throw e; return '责任或成员不可用。'; }
  }
  private version(o: Obligation, revision: number) {
    if (!Number.isSafeInteger(revision) || revision !== o.revision) conflict('责任已更新，请刷新后再处理。');
  }
  signal(cid: string,id: string,input: WaitSignal) {
    if (input.condition?.startsWith('ci:')) conflict('CI 条件仅接受平台核对的真实运行结果。');
    return this.applySignal(cid,id,input,false);
  }
  private recordWaitWake(o: Obligation, eventKey: string) {
    const wait = o.wait!;
    wait.firedAt = new Date(this.clock()).toISOString();
    this.store.db.prepare('INSERT INTO cc_obligation_wait_wakes(wait_id,obligation_id,source_id,event_key,value) VALUES(?,?,?,?,?)')
      .run(wait.id,o.id,o.wakeSourceId!,eventKey,JSON.stringify(wait));
  }
  private applySignal(cid: string, id: string, input: WaitSignal, fromCi: boolean) {
    this.room(cid);
    return this.port.tx(() => this.port.command('obligation-signal:' + cid + ':' + value(input.requestId,'请求编号',160),{id,input},() => {
      const o = this.owner(this.row(cid,id)); this.version(o,input.expectedRevision);
      const summary = value(input.summary,'条件结果');
      if (o.wait?.kind === 'timer') conflict('定时等待只在约定时刻由平台唤醒。');
      if (o.wait?.returnTo && (!same(o.wait.returnTo,o.owner) || o.wait.ownerRevision !== o.ownerRevision)) conflict('等待的接回人已变更。');
      if (o.state !== 'waiting' || !o.wait || o.wait.id !== input.waitId || o.wait.condition !== input.condition || Date.parse(o.wait.deadline) <= this.clock()) conflict('这项等待已变化、过期或取消。');
      o.wait.signal = {requestId:input.requestId,summary,receivedAt:now()}; o.state = 'open';
      this.wake(o,(fromCi ? '平台已核对 CI 条件「' : '用户已明确确认条件「') + o.wait.condition + '」：' + summary);
      if (o.wait.kind) this.recordWaitWake(o, input.requestId);
      return {obligation:this.save(o,'wait_signalled')};
    }).result);
  }
  private requireReleased(o: Obligation, withdrawing?: string) {
    const active = this.store.db.prepare("SELECT d.value FROM cc_obligation_sources s JOIN cc_deliveries d ON d.source_id=s.source_id WHERE s.obligation_id=? AND d.member_id=?").all(o.id,o.owner.memberId) as {value:string}[];
    if (active.some(r => {
      const d: Delivery = JSON.parse(r.value);
      if (d.status === 'pending' || d.status === 'held') return !(d.sourceId === withdrawing && !d.responseId);
      if (!d.responseId) return false;
      const run = this.store.invocation(this.store.response(d.responseId).invocationId);
      return !terminal.has(run.status) || run.teardown !== 'confirmed';
    })) conflict('仍有待领取或未释放的执行，请先等待。');
  }
  private requireRetry(o: Obligation) {
    const cid = o.conversationId;
    if (o.state !== 'blocked' || !same(o.owner,this.endpoint(cid,o.owner.memberId))) conflict('只可请当前有效负责人复核阻塞的委托。');
    const t = o.taskId && this.store.tasks.getTask(o.taskId);
    if (t && (t.disposition || t.pendingHandoffId || t.status === 'done' || t.status === 'blocked' || t.executionRef)) conflict('关联任务不可复核或仍在处理中。');
    const {source,originalMember} = this.publicOrigin(o.originInvocationId);
    if (source.id !== o.originSourceId || source.conversationId !== cid) conflict('原委托授权已失效。');
    if (originalMember.id !== o.owner.instanceId && (!t || !this.store.tasks.handoffs(cid).some(h =>
      h.taskId === t.id && h.state === 'applied' && h.toMemberId === o.owner.memberId && h.expectedOwnerRevision + 1 === o.ownerRevision))) {
      conflict('当前成员缺少正式接手这项责任的凭据。');
    }
    if (source.projectWork) {
      this.actor(o.originInvocationId,false);
      const c = this.store.contract(o.originInvocationId);
      this.store.projectReviews.requireGrant(cid,o.owner.memberId,c.workspaceGrant!.revision,c.workspaceGrant);
    }
    this.requireReleased(o);
  }
  private handoffTask(o: Obligation) {
    if (o.state !== 'blocked' || o.parentId || !o.taskId) conflict('只能改派受阻的主委托。');
    const t = this.store.tasks.getTask(o.taskId);
    if (t.ownerRevision !== o.ownerRevision || t.ownerMemberId !== o.owner.memberId ||
        t.executionRef || t.pendingHandoffId || t.delegationId || t.disposition || t.status === 'done') {
      conflict('关联任务已有执行、交接或终结处置，请查看最新进度。');
    }
    const {source:origin} = this.publicOrigin(o.originInvocationId);
    if (origin.id !== o.originSourceId || origin.conversationId !== o.conversationId) conflict('原委托授权已失效。');
    if (origin.projectWork || this.latestChild(o)?.projectReview) conflict('项目授权与原执行绑定，请在项目中重新授权。');
    if (o.activeGroupId || this.raw(o.conversationId).some(c => c.parentId === o.id && !ended(c) && c.state !== 'blocked')) conflict('尚有未接回的下游委托。');
    const source = this.store.artifacts.get<SourceWork>('cc_sources',o.currentSourceId);
    const unclaimed = source.kind === 'job_result' && source.id === o.wakeSourceId && !source.withdrawnAt &&
      source.requestedTargets.length === 1 && source.requestedTargets[0] === o.owner.memberId &&
      this.store.db.prepare("SELECT 1 FROM cc_deliveries WHERE source_id=? AND member_id=? AND status IN ('pending','held') AND json_extract(value,'$.responseId') IS NULL")
        .get(source.id,o.owner.memberId) ? source : undefined;
    this.requireReleased(o,unclaimed?.id);
    return {task:t,unclaimed};
  }
  operatorList(cid: string): OperatorObligation[] {
    const room = this.store.workbench.conversation(cid);
    return this.raw(cid).map(o => {
      if (o.parentId || o.state !== 'blocked' || room.archivedAt || room.deletedAt || room.importedFor) return o;
      const recovery: NonNullable<OperatorObligation['recovery']> = {handoffTargets:[]};
      try { this.requireRetry(o); } catch (e) {
        if (!(e instanceof AppError)) throw e;
        recovery.retryUnavailable = e.message;
      }
      try {
        recovery.taskRevision = this.handoffTask(o).task.revision;
        for (const id of room.memberIds) {
          if (id === o.owner.memberId) continue;
          try { recovery.handoffTargets.push(this.endpoint(cid,id)); }
          catch (e) { if (!(e instanceof AppError)) throw e; }
        }
      } catch (e) { if (!(e instanceof AppError)) throw e; }
      return {...o,recovery};
    });
  }
  reassign(cid: string, id: string, input: {requestId:string; expectedRevision:number; taskRevision:number; target:ObligationEndpoint; reason:string}) {
    this.room(cid);
    return this.port.tx(() => this.port.command('obligation-decision:' + cid + ':' + value(input.requestId,'请求编号',160),{id,input},() => {
      const o = this.row(cid,id); this.version(o,input.expectedRevision);
      const {task,unclaimed} = this.handoffTask(o), target = this.endpoint(cid,input.target.memberId);
      if (!same(input.target,target) || target.memberId === o.owner.memberId) conflict('接手成员已变更，请重新选择。');
      const result = this.store.tasks.handoff(task.id,{requestId:input.requestId,expectedRevision:input.taskRevision,
        expectedOwnerRevision:o.ownerRevision!,targetMemberId:target.memberId,reason:value(input.reason,'交接说明',1000)});
      if (result.handoff.state !== 'applied') conflict('交接尚未生效，请核对当前负责人。');
      if (unclaimed) this.store.cross.withdraw(unclaimed);
      this.owner(o);
      o.state = 'open'; o.groupCount = 0; o.waitCount = 0;
      delete o.reason; delete o.delivery; delete o.blockedReturnSourceId; delete o.wait;
      return {obligation:this.save(o,'user_reassigned')};
    }).result);
  }
  async decide(cid: string, id: string, input: {requestId:string;expectedRevision:number;decision:'accept'|'cancel'|'retry';reason?:string}) {
    this.room(cid); const key = 'obligation-decision:' + cid + ':' + value(input.requestId,'请求编号',160);
    const initial = this.row(cid,id), child = this.latestChild(initial);
    if (input.decision === 'accept' && initial.state === 'awaiting_acceptance' && child?.projectReview) {
      this.version(initial,input.expectedRevision);
      try { await this.currentVersion(child); }
      catch (e) {
        if (e instanceof AppError) this.port.tx(() => {
          const current = this.row(cid,id);
          if (current.state === 'awaiting_acceptance' && current.revision === initial.revision) this.block(current,e.message);
        });
        throw e;
      }
    }
    return this.port.tx(() => this.port.command(key,{id,input},() => {
      const o = this.owner(this.row(cid,id)); this.version(o,input.expectedRevision);
      if (o.parentId || ended(o)) conflict('责任已终结或不属于用户交付。');
      if (input.decision === 'accept') {
        if (o.state !== 'awaiting_acceptance' || !o.delivery?.messageId) conflict('当前没有待确认的最终交付。');
        this.endpoint(cid,o.owner.memberId); this.finishTask(o); o.state = 'delivered';
      } else if (input.decision === 'retry') {
        this.requireRetry(o);
        const note = input.reason === undefined ? '' : '\n用户补充的公开材料，请独立核对：' + value(input.reason,'补充材料',1000);
        this.wake(o,'用户要求复核先前的阻塞：' + (o.reason ?? '待核对') + '。请核对现有证据，需要新的项目操作时重新申请授权。' + note);
        o.state = 'open'; o.reminderCount = 0; o.waitCount = 0; o.groupCount = 0; delete o.reason; delete o.delivery;
      } else if (input.decision === 'cancel') {
        if (o.activeGroupId) {
          this.store.cooperation.stopRootGroup(o.activeGroupId);
          delete o.activeGroupId;
        }
        for (const linked of [o,...this.raw(cid).filter(child => child.parentId === o.id && !ended(child))]) {
          const source = this.store.artifacts.get<SourceWork>('cc_sources',linked.currentSourceId);
          if (!source.withdrawnAt && (source.kind === 'job_result' || (linked.parentId && source.kind === 'a2a'))) {
            this.store.cross.withdraw(source);
          }
        }
        o.state = 'cancelled'; o.reason = value(input.reason ?? '用户已取消。','取消原因');
        for (const sub of this.raw(cid).filter(s => s.parentId === o.id && !ended(s))) { sub.state = 'cancelled'; sub.reason = o.reason; this.save(sub,'cancelled'); }
        if (o.taskId) {
          const t = this.store.tasks.getTask(o.taskId);
          if (!t.disposition && t.status !== 'done') this.store.tasks.update(t.id,{requestId:'obligation-cancel-' + o.id,
            expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision,disposition:'abandoned',reason:o.reason});
        }
      } else conflict('未知的责任处理方式。');
      return {obligation:this.save(o,'user_decision')};
    }).result);
  }
  reconcile() {
    this.port.tx(() => {
      const rows = this.store.db.prepare("SELECT value FROM cc_obligations WHERE json_extract(value,'$.state') NOT IN ('delivered','cancelled') ORDER BY rowid").all() as {value:string}[];
      for (const row of rows) {
        const initial = JSON.parse(row.value) as Obligation;
        const o = this.row(initial.conversationId,initial.id);
        if (ended(o)) continue;
        try {
          this.owner(o);
          if (!same(o.owner,this.endpoint(o.conversationId,o.owner.memberId))) conflict('原责任成员已离开或代次已变化。');
          if (o.taskId) {
            const t = this.store.tasks.getTask(o.taskId);
            if (t.disposition || t.status === 'done' || t.status === 'blocked') conflict('关联任务已终结或阻塞，责任尚未交付。');
            if (t.pendingHandoffId) continue;
          }
          if (o.state === 'waiting' && !o.wait && !o.activeGroupId) conflict('没有找到已登记的等待对象，请负责人复核。');
          if (o.state === 'waiting' && o.wait?.returnTo && (!same(o.owner,o.wait.returnTo) || o.ownerRevision !== o.wait.ownerRevision)) conflict('原等待的接回人已变化，需要重新约定。');
          if (o.state === 'waiting' && o.wait?.kind === 'timer' && Date.parse(o.wait.deadline) <= this.clock()) {
            this.wake(o, '已到约定时间 ' + o.wait.deadline + '。请按约定处理「' + o.wait.condition + '」。');
            this.recordWaitWake(o,'timer:' + o.wait.id);
            o.state = 'open';
            this.save(o,'timer_elapsed');
            continue;
          }
          if (o.state === 'waiting' && o.activeGroupId) {
            const row = this.store.db.prepare('SELECT value FROM cc_mention_groups WHERE id=? AND conversation_id=?').get(o.activeGroupId, o.conversationId) as {value:string}|undefined;
            const group: MentionGroup|undefined = row && JSON.parse(row.value);
            if (!group || group.contract?.obligationId !== o.id || group.state !== 'collecting') {
              delete o.activeGroupId;
              conflict('找不到此责任有效的征询等待，请负责人复核。');
            }
            continue;
          }
          if (o.state === 'waiting' && o.wait && Date.parse(o.wait.deadline) > this.clock() && o.wait.condition.startsWith('ci:')) {
            const observation = observedCi(this.store,o);
            if (observation) this.applySignal(o.conversationId,o.id,{...observation,condition:o.wait.condition,expectedRevision:o.revision,waitId:o.wait.id},true);
            continue;
          }
          if (o.state === 'waiting' && o.wait && Date.parse(o.wait.deadline) <= this.clock()) conflict('等待已到期，请核对结果。');
          if (o.state === 'delegated') {
            const child = this.latestChild(o);
            if (!child) conflict('子委托记录缺失，需由负责人核对后继续。');
            if (ended(child) || child.state === 'blocked') this.returnReport(child);
            continue;
          }
          if (!['open','delivery_pending'].includes(o.state)) continue;
          const source = this.store.artifacts.get<SourceWork>('cc_sources',o.currentSourceId);
          const delivery = (this.store.db.prepare('SELECT value FROM cc_deliveries WHERE source_id=? AND member_id=?').get(source.id,o.owner.memberId) as {value:string}|undefined);
          const d: Delivery|undefined = delivery && JSON.parse(delivery.value);
          if (source.withdrawnAt || !d || d.status === 'withdrawn') conflict('原责任投递已失效。');
          if (d.status === 'consumed' && !d.responseId) conflict('投递已领取，但缺少对应的执行记录。');
          if (d.responseId) {
            const run = this.store.invocation(this.store.response(d.responseId).invocationId);
            if (terminal.has(run.status)) this.settle(o,run);
          }
        } catch(error) {
          if (!(error instanceof AppError)) throw error;
          this.block(o,error.message);
          if (o.parentId) this.returnReport(o);
        }
      }
    });
  }
}
