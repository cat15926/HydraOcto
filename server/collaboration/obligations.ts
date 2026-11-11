import { userAcceptanceQuote } from './user-acceptance.js';
import { ciTargets, observedCi } from './obligation-ci.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { AcceptanceEvidence, CollaborationInvocation, ConversationMessage, Delivery, OrdinaryTask, ProjectReviewCheck, SourceWork } from '../../shared/collaboration.js';
import type { Obligation, ObligationDelegation, ObligationEndpoint, ObligationReport } from '../../shared/obligations.js';
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
  private actor(id: string, requireRunning = true) {
    const run = this.store.invocation(id), c = this.store.contract(id), source = this.store.visibility.primary(id);
    const member = this.endpoint(run.conversationId, run.memberId);
    if (!c.obligationPolicy || !c.roomMember || c.roomMember.id !== member.instanceId || c.roomMember.generation !== member.generation ||
        c.roomMember.conversationId !== run.conversationId || c.roomMember.memberId !== run.memberId || !c.roomMember.active ||
        source.withdrawnAt || c.visibility || source.visibility || source.excerptRefs?.length || source.crossRef || source.actionRef ||
        run.acceptance !== 'accepted' || (run.cancelRevision ?? 0) !== 0) conflict('责任操作需要本房间的有效公开执行和真实接受证据。');
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
  private save(o: Obligation, reason: string) {
    o.revision++; o.updatedAt = now();
    this.store.artifacts.save('cc_obligations', o, 'obligation.' + reason);
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
    if (condition.startsWith('ci:') && !ciTargets(this.store,id).some(target => target.condition === condition)) conflict('请选择本实例已经获准交付的 PR 和准确提交。');
    if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= this.clock()) conflict('请指定未来的有效截止时间。');
    o.wait = {id:randomUUID(),condition,deadline:new Date(deadline).toISOString()}; o.state = 'waiting'; return this.save(o,'waiting');
  }
  tool(id: string, name: string, args: Record<string,unknown>, callId: string) {
    this.actor(id);
    const keys:Record<string,string[]> = {obligation_list:[],obligation_open:['goal','acceptance'],obligation_report:['obligationId','version','outcome','summary','evidenceId'],obligation_deliver:['obligationId','summary'],obligation_wait:['obligationId','condition','deadline']};
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
      this.save(parent,'result_returned');
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
  private applySignal(cid: string, id: string, input: WaitSignal, fromCi: boolean) {
    this.room(cid);
    return this.port.tx(() => this.port.command('obligation-signal:' + cid + ':' + value(input.requestId,'请求编号',160),{id,input},() => {
      const o = this.owner(this.row(cid,id)); this.version(o,input.expectedRevision);
      const summary = value(input.summary,'条件结果');
      if (o.state !== 'waiting' || !o.wait || o.wait.id !== input.waitId || o.wait.condition !== input.condition || Date.parse(o.wait.deadline) <= this.clock()) conflict('这项等待已变化、过期或取消。');
      o.wait.signal = {requestId:input.requestId,summary,receivedAt:now()}; o.state = 'open';
      this.wake(o,(fromCi ? '平台已核对 CI 条件「' : '用户已明确确认条件「') + o.wait.condition + '」：' + summary);
      return {obligation:this.save(o,'wait_signalled')};
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
        if (o.state !== 'blocked' || !same(o.owner,this.endpoint(cid,o.owner.memberId))) conflict('只可请当前有效负责人复核阻塞的委托。');
        const t = o.taskId && this.store.tasks.getTask(o.taskId);
        if (t && (t.disposition || t.pendingHandoffId || t.status === 'done' || t.status === 'blocked' || t.executionRef)) conflict('关联任务不可复核或仍在处理中。');
        const source = this.store.artifacts.get<SourceWork>('cc_sources',o.originSourceId);
        if (source.withdrawnAt || source.visibility || source.excerptRefs?.length) conflict('原委托授权已失效。');
        this.actor(o.originInvocationId,false);
        if (source.projectWork) {
          const c = this.store.contract(o.originInvocationId);
          this.store.projectReviews.requireGrant(cid,o.owner.memberId,c.workspaceGrant!.revision,c.workspaceGrant);
        }
        const active = this.store.db.prepare("SELECT d.value FROM cc_obligation_sources s JOIN cc_deliveries d ON d.source_id=s.source_id WHERE s.obligation_id=? AND d.member_id=?").all(o.id,o.owner.memberId) as {value:string}[];
        if (active.some(r => {
          const d: Delivery = JSON.parse(r.value);
          if (d.status === 'pending' || d.status === 'held') return true;
          if (!d.responseId) return false;
          const run = this.store.invocation(this.store.response(d.responseId).invocationId);
          return !terminal.has(run.status) || run.teardown !== 'confirmed';
        })) conflict('仍有待领取或未释放的执行，请先等待。');
        this.wake(o,'用户要求复核先前的阻塞：' + (o.reason ?? '待核对') + '。请核对现有证据，需要新的项目操作时重新申请授权。');
        o.state = 'open'; o.reminderCount = 0; delete o.reason; delete o.delivery;
      } else if (input.decision === 'cancel') {
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
          if (o.state === 'waiting' && o.wait && Date.parse(o.wait.deadline) > this.clock() && o.wait.condition.startsWith('ci:')) {
            const observation = observedCi(this.store,o);
            if (observation) this.applySignal(o.conversationId,o.id,{...observation,condition:o.wait.condition,expectedRevision:o.revision,waitId:o.wait.id},true);
            continue;
          }
          if (o.state === 'waiting' && o.wait && Date.parse(o.wait.deadline) <= this.clock()) conflict('等待已到期，请核对结果。');
          if (o.state === 'delegated') {
            const child = this.latestChild(o);
            if (child && (ended(child) || child.state === 'blocked')) this.returnReport(child);
            continue;
          }
          if (!['open','delivery_pending'].includes(o.state)) continue;
          const source = this.store.artifacts.get<SourceWork>('cc_sources',o.currentSourceId);
          const delivery = (this.store.db.prepare('SELECT value FROM cc_deliveries WHERE source_id=? AND member_id=?').get(source.id,o.owner.memberId) as {value:string}|undefined);
          const d: Delivery|undefined = delivery && JSON.parse(delivery.value);
          if (source.withdrawnAt || !d || d.status === 'withdrawn') conflict('原责任投递已失效。');
          if (d?.responseId) {
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
