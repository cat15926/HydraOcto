import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ArtifactApproval, ArtifactOrigin, ArtifactReview, ArtifactVersion, CollaborationResponse, Conversation, ManagedArtifact, ManagedJob, Member, SourceWork } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';
import { ArtifactFiles, contentDigest } from './artifact-files.js';
import type { ArtifactPort } from './artifact-port.js';

const fail = (reason: string): never => { throw new AppError(409, reason, 'artifact_conflict'); };
export const stringField = (value: unknown, label: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label}无效。`);
  return value;
};
export class ArtifactService {
  readonly files: ArtifactFiles;
  readonly epoch = randomUUID();
  constructor(readonly port: ArtifactPort, root: string, readonly workspace: string) { this.files = new ArtifactFiles(root, workspace); }
  rows<T>(table: string, conversationId?: string): T[] { return (this.port.db.prepare(`SELECT value FROM ${table}${conversationId ? ' WHERE conversation_id=?' : ''} ORDER BY rowid`).all(...(conversationId ? [conversationId] : [])) as { value: string }[]).map(r => JSON.parse(r.value) as T); }
  get<T>(table: string, id: string): T { const r = this.port.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id) as { value: string } | undefined; if (!r) throw new AppError(404, '记录不存在。', 'not_found'); return JSON.parse(r.value) as T; }
  save(table: string, value: { id: string; conversationId: string }, event: string) {
    this.port.db.prepare(`INSERT INTO ${table}(id,conversation_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(value.id, value.conversationId, JSON.stringify(value));
    this.port.event(value.conversationId, event, { id: value.id });
  }
  target(conversationId: string, memberId: string) { const c = this.get<Conversation>('cc_conversations', conversationId), m = this.get<Member>('cc_members', memberId); if (!c.memberIds.includes(memberId) || !m.enabled) fail('目标不属于当前会话的已启用成员。'); }
  origin(conversationId: string, invocationId?: string, taskId?: string, allowPrivate = false): ArtifactOrigin {
    this.get<Conversation>('cc_conversations', conversationId);
    const actor = this.port.tasks.actor(invocationId, allowPrivate);
    const origin: ArtifactOrigin = { actor };
    if (actor.kind === 'agent') {
      const i = this.port.invocation(actor.invocationId), contract = this.port.contract(i.id);
      if (!allowPrivate && contract.visibility?.kind === 'private' && !contract.visibility.revealedAt) fail('私聊执行不能写入公开产物。');
      if (i.conversationId !== conversationId || !['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1'].includes(contract.toolPolicyVersion) || i.acceptance !== 'accepted') fail('此准确执行没有产物权限或接受证据。');
      const r = this.get<CollaborationResponse>('cc_responses', i.responseId);
      origin.responseId = r.id; origin.inputRevision = r.inputRevision; origin.sourceDigest = contract.sourceDigest;
    }
    if (taskId) {
      const t = this.port.tasks.getTask(taskId);
      if (t.conversationId !== conversationId || t.status === 'done' || t.disposition || t.pendingHandoffId) fail('任务关联已失效。');
      if (actor.kind === 'agent') this.port.tasks.executionAuthority(taskId, actor);
      origin.task = { id: t.id, ownerRevision: t.ownerRevision, fence: t.executionRef?.fence ?? '' };
    }
    return origin;
  }
  originReason(origin: ArtifactOrigin, conversationId: string): string | undefined {
    const a = origin.actor;
    if (a.kind === 'agent') {
      const i = this.port.invocation(a.invocationId), s = this.get<SourceWork>('cc_sources', a.sourceId), r = this.get<CollaborationResponse>('cc_responses', i.responseId);
      try { this.target(conversationId, a.memberId); } catch { return '原成员已停用或离开会话。'; }
      if (i.conversationId !== conversationId || i.memberId !== a.memberId || i.responseId !== origin.responseId || r.inputRevision !== origin.inputRevision || !r.inputSourceIds.includes(s.id) || s.revision !== a.sourceRevision || digest(s.content) !== origin.sourceDigest || (i.cancelRevision ?? 0) !== a.cancelRevision || i.acceptance !== 'accepted' || !(i.status === 'running' || (i.status === 'succeeded' && i.teardown === 'confirmed'))) return '原执行、来源、输入或取消代次已失效，或执行结果/退出未确认。';
    }
    if (origin.task) {
      const t = this.port.tasks.getTask(origin.task.id), ref = t.executionRef ?? t.lastExecutionRef;
      if (t.conversationId !== conversationId || t.status === 'done' || t.disposition || t.pendingHandoffId || t.ownerRevision !== origin.task.ownerRevision || (origin.task.fence && (ref?.fence !== origin.task.fence || (a.kind === 'agent' && ref.invocationId !== a.invocationId)))) return '关联任务的准确责任已变化。';
    }
  }
  private operation(v: ArtifactVersion, a: ArtifactApproval) { return digest({ kind: 'artifact_materialize', versionId: v.id, artifactId: v.artifactId, baseVersionId: v.baseVersionId, digest: v.digest, bytes: v.bytes, origin: v.origin, notifyMemberId: a.notifyMemberId ?? null }); }
  private guard(v: ArtifactVersion, a: ArtifactApproval): string | undefined {
    const artifact = this.get<ManagedArtifact>('cc_artifacts', v.artifactId);
    if (Date.parse(a.expiresAt) <= Date.now()) return '审批已过期。';
    if ((artifact.headVersionId ?? null) !== v.baseVersionId) return '产物当前版本已变化，请重新提出版本。';
    if (this.operation(v, a) !== a.operationDigest) return '审批操作或材料摘要不匹配。';
    if (a.notifyMemberId) { try { this.target(v.conversationId, a.notifyMemberId); } catch { return '完成通知目标已失效。'; } }
    return this.originReason(v.origin, v.conversationId);
  }
  propose(conversationId: string, input: Record<string, unknown>, invocationId?: string) {
    return this.port.tx(() => {
      const requestId = stringField(input.requestId, '请求标识'), origin = this.origin(conversationId, invocationId, input.taskId === undefined ? undefined : stringField(input.taskId, '任务'));
      const out = this.port.command(`artifact-propose:${conversationId}:${requestId}`, { input, origin }, () => {
        const name = stringField(input.name, '文件名', 120);
        if (/[\\/\x00-\x1f\x7f]/.test(name) || name.startsWith('.') || /[. ]$/.test(name)) throw new AppError(400, '名称须为可见文件名，不能含路径或控制字符。');
        const content = input.content;
        if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 32768 || Buffer.from(content).toString('utf8') !== content) throw new AppError(400, '产物须为至多 32 KiB 的有效 UTF-8 文本。');
        let artifact: ManagedArtifact;
        if (input.artifactId) {
          artifact = this.get('cc_artifacts', stringField(input.artifactId, '产物'));
          if (artifact.conversationId !== conversationId || artifact.name !== name || artifact.revision !== input.expectedRevision || (artifact.headVersionId ?? null) !== (input.baseVersionId ?? null)) fail('产物范围、名称或基准版本已变化。');
        } else artifact = { id: randomUUID(), conversationId, name, revision: 1, createdAt: now(), updatedAt: now() };
        if (this.rows<ArtifactApproval>('cc_artifact_approvals', conversationId).filter(x => x.state === 'pending').length >= 100) fail('待审批产物过多，请先处理。');
        const approval: ArtifactApproval = { id: randomUUID(), conversationId, versionId: randomUUID(), operationDigest: '', revision: 1, state: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
        if (input.notifyMemberId !== undefined) { approval.notifyMemberId = stringField(input.notifyMemberId, '通知成员'); this.target(conversationId, approval.notifyMemberId); }
        const version: ArtifactVersion = { id: approval.versionId, artifactId: artifact.id, conversationId, number: 1 + Math.max(0, ...this.rows<ArtifactVersion>('cc_artifact_versions', conversationId).filter(v => v.artifactId === artifact.id).map(v => v.number)), baseVersionId: artifact.headVersionId ?? null, digest: contentDigest(content), bytes: Buffer.byteLength(content), origin, createdAt: now(), state: 'proposed', approvalId: approval.id };
        approval.operationDigest = this.operation(version, approval);
        this.save('cc_artifacts', artifact, 'artifact.proposed'); this.save('cc_artifact_versions', version, 'artifact.version_proposed');
        this.port.db.prepare('INSERT INTO cc_artifact_contents VALUES(?,?)').run(version.id, content);
        this.save('cc_artifact_approvals', approval, 'artifact.approval_requested');
        return { artifact, version, approval };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  content(versionId: string, conversationId?: string) {
    const v = this.get<ArtifactVersion>('cc_artifact_versions', versionId);
    if (conversationId && v.conversationId !== conversationId) fail('产物不属于当前会话。');
    const row = this.port.db.prepare('SELECT content FROM cc_artifact_contents WHERE version_id=?').get(v.id) as { content: string };
    if (!row || contentDigest(row.content) !== v.digest) fail('材料内容摘要不一致。');
    if (v.state === 'published') { const job = this.get<ManagedJob>('cc_managed_jobs', v.jobId!); if (!this.files.inspect(job, v)) fail('已发布文件的准确回执无法验证。'); }
    return { version: v, content: row.content, artifact: this.get<ManagedArtifact>('cc_artifacts', v.artifactId) };
  }
  decide(approvalId: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const out = this.port.command(`artifact-decision:${approvalId}:${stringField(input.requestId, '请求标识')}`, input, () => {
        const a = this.get<ArtifactApproval>('cc_artifact_approvals', approvalId), v = this.get<ArtifactVersion>('cc_artifact_versions', a.versionId);
        if (a.state !== 'pending' || a.revision !== input.expectedRevision || a.operationDigest !== input.operationDigest || !['approve', 'reject'].includes(String(input.decision))) fail('审批状态、修订或操作摘要已变化。');
        const reason = this.guard(v, a); if (reason) fail(reason);
        a.state = input.decision === 'approve' ? 'approved' : 'rejected'; a.decidedAt = now(); a.revision++;
        if (a.state === 'approved') {
          const j: ManagedJob = { id: randomUUID(), conversationId: a.conversationId, versionId: v.id, approvalId: a.id, operationDigest: a.operationDigest, kind: 'artifact_materialize', state: 'pending', revision: 1, fence: randomUUID(), createdAt: now() };
          v.jobId = j.id; this.save('cc_managed_jobs', j, 'job.created');
        } else v.state = 'rejected';
        this.save('cc_artifact_versions', v, 'artifact.version_decided'); this.save('cc_artifact_approvals', a, 'artifact.approval_decided'); return { approval: a, version: v };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  private invalidate(v: ArtifactVersion, a: ArtifactApproval, reason: string) {
    a.state = Date.parse(a.expiresAt) <= Date.now() ? 'expired' : 'stale'; a.reason = reason; a.revision++;
    v.state = a.state; v.reason = reason; this.save('cc_artifact_versions', v, 'artifact.invalidated'); this.save('cc_artifact_approvals', a, 'artifact.approval_invalidated');
  }
  sweep() {
    this.port.tx(() => {
      for (const a of this.rows<ArtifactApproval>('cc_artifact_approvals')) {
        if (!['pending', 'approved'].includes(a.state)) continue;
        const v = this.get<ArtifactVersion>('cc_artifact_versions', a.versionId); if (v.state === 'published' || v.state === 'unknown') continue;
        const reason = this.guard(v, a); if (reason) this.invalidate(v, a, reason);
      }
      for (const review of this.rows<ArtifactReview>('cc_artifact_reviews')) {
        if (review.state !== 'pending') continue;
        const reason = this.reviewReason(review);
        if (reason) { review.state = Date.parse(review.expiresAt) <= Date.now() ? 'expired' : 'stale'; review.revision++; this.save('cc_artifact_reviews', review, 'review.invalidated'); this.withdrawReview(review, reason); }
      }
    });
  }
  claimJob(id: string): ManagedJob {
    return this.port.tx(() => {
      const j = this.get<ManagedJob>('cc_managed_jobs', id), v = this.get<ArtifactVersion>('cc_artifact_versions', j.versionId), a = this.get<ArtifactApproval>('cc_artifact_approvals', j.approvalId);
      if (j.state !== 'pending') fail('作业不能再次执行。');
      const reason = this.guard(v, a);
      if (reason || a.state !== 'approved' || v.jobId !== j.id || a.operationDigest !== j.operationDigest) { j.state = 'stale'; j.reason = reason ?? '准确审批已失效。'; }
      else { j.state = 'running'; j.startedAt = now(); j.supervisorEpoch = this.epoch; }
      j.revision++; this.save('cc_managed_jobs', j, 'job.claimed'); return j;
    });
  }
  processJobs() {
    this.sweep();
    for (const pending of this.rows<ManagedJob>('cc_managed_jobs').filter(j => j.state === 'pending')) {
      const j = this.claimJob(pending.id); if (j.state !== 'running') continue;
      const v = this.get<ArtifactVersion>('cc_artifact_versions', j.versionId);
      try { this.files.write(j, v, this.content(v.id).content); } catch { /* An uncertain write is inspected, never repeated. */ }
      this.reconcileJob(j.id);
    }
  }
  reconcileJob(id: string) {
    const observed = this.get<ManagedJob>('cc_managed_jobs', id), v = this.get<ArtifactVersion>('cc_artifact_versions', observed.versionId);
    if (!['running', 'unknown'].includes(observed.state)) return { job: observed };
    const receipt = this.files.inspect(observed, v);
    return this.port.tx(() => {
      const j = this.get<ManagedJob>('cc_managed_jobs', id); if (j.revision !== observed.revision || !['running', 'unknown'].includes(j.state)) return { job: j };
      const a = this.get<ArtifactApproval>('cc_artifact_approvals', j.approvalId), current = this.get<ArtifactVersion>('cc_artifact_versions', j.versionId);
      if (!receipt) { j.state = 'unknown'; j.reason = '没有准确完整文件回执；保持未知，不自动重写。'; current.state = 'unknown'; }
      else {
        j.receiptDigest = digest(receipt);
        const reason = this.guard(current, a);
        if (reason || a.state !== 'approved' || current.jobId !== j.id || j.operationDigest !== a.operationDigest) { j.state = 'stale'; j.reason = reason ?? '作业授权已失效。'; current.state = 'stale'; }
        else {
          const artifact = this.get<ManagedArtifact>('cc_artifacts', current.artifactId);
          artifact.headVersionId = current.id; artifact.revision++; artifact.updatedAt = now(); current.state = 'published'; current.publishedAt = now(); j.state = 'succeeded'; j.finishedAt = now(); delete j.reason;
          this.save('cc_artifacts', artifact, 'artifact.published');
          if (a.notifyMemberId && !j.notificationSourceId) j.notificationSourceId = this.port.addSource({ conversationId: j.conversationId, kind: 'job_result', content: `受管作业 ${j.id} 已写入产物 ${artifact.name} 版本 ${current.id}，摘要 ${current.digest}。此通知不表示普通任务完成。`, requestedTargets: [a.notifyMemberId], depth: 0 }).id;
        }
      }
      j.revision++; this.save('cc_artifact_versions', current, 'artifact.materialization_checked'); this.save('cc_managed_jobs', j, 'job.checked'); return { job: j };
    });
  }
  recover() { for (const j of this.rows<ManagedJob>('cc_managed_jobs').filter(j => ['running', 'unknown'].includes(j.state))) this.reconcileJob(j.id); }
  gitHead(): string | undefined {
    try {
      if (!this.workspace || execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: this.workspace, encoding: 'utf8', timeout: 2000, maxBuffer: 200000 }).trim()) return;
      return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: this.workspace, encoding: 'utf8', timeout: 2000 }).trim();
    } catch { return; }
  }
  private reviewReason(r: ArtifactReview): string | undefined {
    const a = this.get<ManagedArtifact>('cc_artifacts', r.artifactId), v = this.get<ArtifactVersion>('cc_artifact_versions', r.versionId);
    if (a.headVersionId !== r.versionId || v.state !== 'published' || v.digest !== r.digest) return '评审材料已被新版本替代。';
    if (r.state === 'pending' && Date.parse(r.expiresAt) <= Date.now()) return '评审已到期。';
    if (r.state === 'submitted' && r.invocationId) {
      const i = this.port.invocation(r.invocationId), s = this.get<SourceWork>('cc_sources', r.sourceId), c = this.port.contract(i.id), response = this.get<CollaborationResponse>('cc_responses', i.responseId);
      if ((i.cancelRevision ?? 0) !== r.submission?.cancelRevision || i.responseId !== r.submission?.responseId || response.inputRevision !== r.submission?.inputRevision || !response.inputSourceIds.includes(s.id) || i.memberId !== r.reviewerMemberId || s.revision !== r.sourceRevision || digest(s.content) !== c.sourceDigest || !(i.status === 'running' || (i.status === 'succeeded' && i.teardown === 'confirmed'))) return '提交评审的准确执行已失效或结果/退出未确认。';
    }
    if (r.headCommit && this.gitHead() !== r.headCommit) return '代码 HEAD 或工作区内容已变化。';
    try { this.target(r.conversationId, r.reviewerMemberId); this.content(v.id); } catch { return '评审目标或准确材料不可用。'; }
    return this.originReason(r.origin, r.conversationId);
  }
  private withdrawReview(r: ArtifactReview, reason: string) {
    for (const row of this.port.db.prepare("SELECT id,value FROM cc_deliveries WHERE source_id=? AND status IN ('pending','held')").all(r.sourceId) as { id: string; value: string }[]) {
      const d = JSON.parse(row.value); d.status = 'withdrawn'; d.revision++; d.holdReason = reason;
      this.port.db.prepare('UPDATE cc_deliveries SET status=?,value=? WHERE id=?').run(d.status, JSON.stringify(d), d.id);
    }
  }
  review(id: string): ArtifactReview { return this.get('cc_artifact_reviews', id); }
  admissionReason(s: SourceWork) { if (s.reviewRef) { const r = this.review(s.reviewRef.reviewId); return r.state !== 'pending' || r.sourceId !== s.id || r.sourceRevision !== s.revision || r.versionId !== s.reviewRef.versionId || r.digest !== s.reviewRef.digest ? '评审来源已失效。' : this.reviewReason(r); } }
  requestReview(conversationId: string, input: Record<string, unknown>, invocationId?: string) {
    return this.port.tx(() => {
      const origin = this.origin(conversationId, invocationId);
      const out = this.port.command(`review-request:${conversationId}:${stringField(input.requestId, '请求标识')}`, { input, origin }, () => {
        const v = this.get<ArtifactVersion>('cc_artifact_versions', stringField(input.versionId, '版本')), a = this.get<ManagedArtifact>('cc_artifacts', v.artifactId), reviewer = stringField(input.reviewerMemberId, '评审成员');
        this.target(conversationId, reviewer); this.content(v.id, conversationId);
        if (a.headVersionId !== v.id || v.state !== 'published' || v.digest !== input.digest || (v.origin.actor.kind === 'agent' && v.origin.actor.memberId === reviewer)) fail('评审须为当前已发布版本，并由不同成员进行。');
        const head = input.codeReview === true ? this.gitHead() : undefined;
        if (input.codeReview === true && !head) fail('代码评审需要存在 HEAD 且工作区完全干净。');
        const r: ArtifactReview = { id: randomUUID(), conversationId, artifactId: a.id, versionId: v.id, digest: v.digest, reviewerMemberId: reviewer, sourceId: '', sourceRevision: 1, revision: 1, origin, state: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 86400000).toISOString(), ...(head ? { headCommit: head } : {}) };
        const s = this.port.addSource({ conversationId, kind: 'artifact_review', content: `请评审产物 ${a.name} 的固定版本 ${v.id}，SHA-256 ${v.digest}${head ? `，代码 HEAD ${head}` : ''}。通过 artifact_read 读取准确版本，完成后 review_submit 提交评审 ${r.id} 的 verdict 与 comment。文字回复不是评审结论，不自动完成普通任务。`, requestedTargets: [reviewer], depth: 0, reviewRef: { reviewId: r.id, versionId: v.id, digest: v.digest } });
        r.sourceId = s.id; this.save('cc_artifact_reviews', r, 'review.requested'); return { review: r };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  submitReview(invocationId: string, input: Record<string, unknown>, callId: string) {
    return this.port.tx(() => {
      const i = this.port.invocation(invocationId), actor = this.origin(i.conversationId, i.id).actor;
      const out = this.port.command(`review-submit:${invocationId}:${callId}`, input, () => {
        const r = this.review(stringField(input.reviewId, '评审')), c = this.port.contract(i.id);
        if (r.state !== 'pending' || r.revision !== input.expectedRevision || r.digest !== input.digest || r.versionId !== input.versionId || actor.kind !== 'agent' || r.sourceId !== actor.sourceId || r.sourceRevision !== actor.sourceRevision || r.reviewerMemberId !== i.memberId || c.reviewSnapshot?.id !== r.id || c.reviewSnapshot?.digest !== r.digest) fail('评审不是本轮准确消费的当前材料。');
        const reason = this.reviewReason(r); if (reason) fail(reason);
        if (!['accept', 'changes_requested'].includes(String(input.verdict))) throw new AppError(400, '评审结论无效。');
        r.verdict = input.verdict as ArtifactReview['verdict']; r.comment = stringField(input.comment, '评审说明', 10000); r.state = 'submitted'; r.invocationId = i.id; r.submission = { responseId: i.responseId, inputRevision: this.get<CollaborationResponse>('cc_responses', i.responseId).inputRevision, cancelRevision: i.cancelRevision ?? 0 }; r.submittedAt = now(); r.revision++; this.save('cc_artifact_reviews', r, 'review.submitted'); return { review: r };
      }); return { ...out.result, replayed: out.replayed };
    });
  }
  detail(conversationId: string) {
    return { artifacts: this.rows<ManagedArtifact>('cc_artifacts', conversationId), artifactVersions: this.rows<ArtifactVersion>('cc_artifact_versions', conversationId), artifactApprovals: this.rows<ArtifactApproval>('cc_artifact_approvals', conversationId), jobs: this.rows<ManagedJob>('cc_managed_jobs', conversationId), reviews: this.rows<ArtifactReview>('cc_artifact_reviews', conversationId).map(r => ({ ...r, current: r.state === 'submitted' && !this.reviewReason(r) })) };
  }
  tool(invocationId: string, name: string, args: Record<string, unknown>, callId: string): unknown {
    const i = this.port.invocation(invocationId); this.origin(i.conversationId, i.id);
    if (['actor', 'invocationId', 'conversationId', 'origin', 'fence', 'requestId'].some(k => k in args)) throw new AppError(400, '产物身份由当前执行绑定。');
    return this.port.tx(() => this.port.command(`artifact-tool:${invocationId}:${callId}`, { name, args }, () => {
    if (name === 'artifact_list') return this.detail(i.conversationId);
    if (name === 'artifact_read') return this.content(stringField(args.versionId, '版本'), i.conversationId);
    if (name === 'artifact_propose') return this.propose(i.conversationId, { ...args, requestId: `${i.id}:${callId}` }, i.id);
    if (name === 'review_request') return this.requestReview(i.conversationId, { ...args, requestId: `${i.id}:${callId}` }, i.id);
    if (name === 'review_submit') return this.submitReview(i.id, args, callId);
    throw new AppError(400, '未知产物工具。');
    }).result);
  }
}
