import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import { ArtifactFiles } from '../server/collaboration/artifact-files.js';
import type { ArtifactApproval, ArtifactVersion, ManagedJob, RuntimeInteraction } from '../shared/collaboration.js';
const requestId = () => randomUUID();
function setup(persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'n5-artifacts-')), root = join(dir, 'objects'), workspace = join(dir, 'workspace'); mkdirSync(workspace);
  let owner = new Store(persistent ? join(dir, 'test.sqlite') : ':memory:'), store = new CollaborationStore(owner, { artifactDir: root, workspace });
  const c = store.create({ title: 'N5', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: requestId() }).conversation;
  const run = (send = true) => { if (send) store.send(c.id, { content: '@codex create material', requestId: requestId() }); const i = store.admitNext()!.invocations[0]!; store.startInvocation(i.id); store.recordEvidence(i.id, { kind: 'accepted', detail: {} }); return store.invocation(i.id); };
  const propose = (extra: Record<string, unknown> = {}, invocationId?: string) => store.artifacts.propose(c.id, { requestId: requestId(), name: 'design.md', content: 'fixed material', ...extra }, invocationId);
  const approve = (a: ArtifactApproval, extra: Record<string, unknown> = {}) => store.artifacts.decide(a.id, { requestId: requestId(), expectedRevision: a.revision, operationDigest: a.operationDigest, decision: 'approve', ...extra });
  const publish = () => { const p = propose(); approve(p.approval); store.artifacts.processJobs(); return p; };
  const end = (id: string) => { store.recordEvidence(id, { kind: 'process_exit', detail: { confirmed: true } }); store.finish(id, 'succeeded', 'Done'); };
  return { dir, root, workspace, c, run, propose, approve, publish, end, get store() { return store; }, get owner() { return owner; },
    restart() { owner.close(); owner = new Store(join(dir, 'test.sqlite')); store = new CollaborationStore(owner, { artifactDir: root, workspace }); store.recover(); store.artifacts.recover(); },
    close() { owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('N5: proposal and approval are separate; immutable digest, exact consent, one durable write and replay', () => {
  const h = setup(); try {
    const input = { requestId: requestId(), name: 'design.md', content: 'abc' }, p = h.propose(input);
    assert.equal(h.propose(input).version.id, p.version.id); assert.throws(() => h.propose({ ...input, content: 'other' }));
    assert.equal(h.store.artifacts.detail(h.c.id).jobs.length, 0);
    assert.throws(() => h.approve(p.approval, { operationDigest: 'wrong' }));
    assert.throws(() => h.approve(p.approval, { expectedRevision: 0 }));
    const id = requestId(); h.approve(p.approval, { requestId: id }); h.approve(p.approval, { requestId: id });
    h.store.artifacts.processJobs(); h.store.artifacts.processJobs();
    const d = h.store.artifacts.detail(h.c.id); assert.equal(d.jobs.length, 1); assert.equal(d.jobs[0]!.state, 'succeeded'); assert.equal(d.artifacts[0]!.headVersionId, p.version.id);
    assert.equal(h.store.artifacts.content(p.version.id).content, 'abc'); assert.equal(h.store.detail(h.c.id).sources.length, 0);
    assert.throws(() => h.store.artifacts.files.write(d.jobs[0]!, d.artifactVersions[0]!, 'abc'));
  } finally { h.close(); }
});

test('N5: concurrent proposals use base-head CAS; losing version never replaces first committed head', () => {
  const h = setup(); try {
    const p = h.publish(), a = h.store.artifacts.detail(h.c.id).artifacts[0]!;
    const next = { artifactId: a.id, expectedRevision: a.revision, baseVersionId: p.version.id };
    const one = h.propose({ ...next, content: 'one' }), two = h.propose({ ...next, content: 'two' }); h.approve(one.approval); h.approve(two.approval); h.store.artifacts.processJobs();
    const d = h.store.artifacts.detail(h.c.id); assert.equal(d.artifacts[0]!.headVersionId, one.version.id); assert.equal(d.jobs.find(j => j.versionId === two.version.id)?.state, 'stale');
    assert.equal(h.store.artifacts.content(p.version.id).content, 'fixed material');
  } finally { h.close(); }
});

test('N5: agent proposal survives successful confirmed exit; cancellation or unknown result revokes authority', () => {
  for (const state of ['success', 'cancel', 'unknown', 'failed'] as const) {
    const h = setup(); try {
      const i = h.run(), p = h.propose({}, i.id);
      if (state === 'success') h.end(i.id);
      if (state === 'cancel') h.store.cancel(i.id);
      if (state === 'unknown') h.store.finish(i.id, 'interrupted', 'Unknown');
      if (state === 'failed') h.store.finish(i.id, 'failed', 'failed');
      if (state === 'success') { h.approve(p.approval); h.store.artifacts.processJobs(); assert.equal(h.store.artifacts.content(p.version.id).version.state, 'published'); }
      else { assert.throws(() => h.approve(p.approval)); h.store.artifacts.sweep(); assert.equal(h.store.artifacts.detail(h.c.id).artifactApprovals[0]!.state, 'stale'); }
    } finally { h.close(); }
  }
});

test('N5: task-linked proposal requires exact owner execution and becomes stale after responsibility changes', () => {
  const h = setup(); try {
    const t = h.store.tasks.create(h.c.id, { requestId: requestId(), title: 'Task', description: '', ownerMemberId: 'codex' }).task, i = h.run(false);
    const p = h.propose({ taskId: t.id }, i.id), bound = h.store.tasks.getTask(t.id);
    h.store.tasks.handoff(t.id, { requestId: requestId(), expectedRevision: bound.revision, expectedOwnerRevision: bound.ownerRevision, targetMemberId: 'claude', reason: 'transfer' }, i.id);
    assert.throws(() => h.approve(p.approval)); h.end(i.id); assert.equal(h.store.tasks.getTask(t.id).ownerMemberId, 'claude');
  } finally { h.close(); }
});

test('N5: source/input changes and disabled members invalidate original approvals', () => {
  for (const change of ['source', 'input', 'member']) { const h = setup(); try {
    const i = h.run(), p = h.propose({}, i.id);
    if (change === 'member') h.store.saveMember({ ...i.member, enabled: false });
    else { const table = change === 'source' ? 'cc_sources' : 'cc_responses', value: any = change === 'source' ? h.store.detail(h.c.id).sources[0] : h.store.response(i.responseId); if (change === 'source') value.revision++; else value.inputRevision++; h.owner.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), value.id); }
    assert.throws(() => h.approve(p.approval));
  } finally { h.close(); } }
});

test('N5: traversal, binary, oversized input, cross-conversation reads and symlink destinations rejected', () => {
  const h = setup(); try {
    for (const name of ['../x', '/tmp/x', 'x\\y', '.env', 'bad\nname']) assert.throws(() => h.propose({ name }));
    assert.throws(() => h.propose({ content: 'x'.repeat(32769) })); assert.throws(() => h.propose({ content: '\0' }));
    const p = h.propose(); assert.throws(() => h.store.artifacts.content(p.version.id, 'foreign'));
    symlinkSync(h.workspace, h.root); h.approve(p.approval); h.store.artifacts.processJobs(); assert.equal(h.store.artifacts.detail(h.c.id).jobs[0]!.state, 'unknown');
  } finally { h.close(); }
});

for (const state of ['pending', 'missing', 'complete', 'tampered'] as const) test(`N5: restart recovery ${state} never replays uncertain filesystem side effects`, () => {
  const h = setup(true); try {
    const p = h.propose({ notifyMemberId: 'claude' }); h.approve(p.approval); let j = h.store.artifacts.detail(h.c.id).jobs[0]!;
    if (state !== 'pending') j = h.store.artifacts.claimJob(j.id);
    if (state === 'complete' || state === 'tampered') h.store.artifacts.files.write(j, p.version, 'fixed material');
    if (state === 'tampered') { const path = join(h.root, `${j.id}.json`), receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.fence = 'foreign'; writeFileSync(path, JSON.stringify(receipt)); }
    h.restart(); h.store.artifacts.processJobs(); h.store.artifacts.reconcileJob(j.id); h.store.artifacts.reconcileJob(j.id);
    const expected = ['pending', 'complete'].includes(state) ? 'succeeded' : 'unknown';
    assert.equal(h.store.artifacts.detail(h.c.id).jobs[0]!.state, expected);
    assert.equal(h.store.detail(h.c.id).sources.filter(s => s.kind === 'job_result').length, expected === 'succeeded' ? 1 : 0);
  } finally { h.close(); }
});

test('N5: recovery of exact receipt after approval drift records stale side effect without publishing it', () => {
  const h = setup(); try { const i = h.run(), p = h.propose({}, i.id); h.approve(p.approval); const j = h.store.artifacts.claimJob(h.store.artifacts.detail(h.c.id).jobs[0]!.id); h.store.artifacts.files.write(j, p.version, 'fixed material'); h.store.cancel(i.id); h.store.artifacts.reconcileJob(j.id); const d = h.store.artifacts.detail(h.c.id); assert.equal(d.jobs[0]!.state, 'stale'); assert.ok(d.jobs[0]!.receiptDigest); assert.equal(d.artifacts[0]!.headVersionId, undefined); } finally { h.close(); }
});

test('N5: exact review consumption required; text/A2A cannot submit; changed head invalidates old verdict', () => {
  const h = setup(); try {
    const p = h.publish(), r = h.store.artifacts.requestReview(h.c.id, { requestId: requestId(), versionId: p.version.id, digest: p.version.digest, reviewerMemberId: 'claude' }).review;
    const i = h.run(false); assert.equal(i.memberId, 'claude'); assert.equal(h.store.contract(i.id).reviewSnapshot?.id, r.id);
    const input = { reviewId: r.id, versionId: p.version.id, digest: p.version.digest, expectedRevision: r.revision, verdict: 'accept', comment: 'Verified exact text' };
    const unrelated = h.run(); assert.throws(() => h.store.artifacts.submitReview(unrelated.id, input, 'wrong'));
    assert.throws(() => h.store.artifacts.submitReview(i.id, { ...input, digest: 'wrong' }, 'bad'));
    h.store.artifacts.submitReview(i.id, input, 'verdict'); h.store.artifacts.submitReview(i.id, input, 'verdict'); h.end(i.id); h.end(unrelated.id);
    assert.equal(h.store.artifacts.detail(h.c.id).reviews[0]!.current, true); assert.equal(h.store.tasks.list(h.c.id).length, 0);
    const a = h.store.artifacts.detail(h.c.id).artifacts[0]!, next = h.propose({ artifactId: a.id, expectedRevision: a.revision, baseVersionId: a.headVersionId, content: 'new' }); h.approve(next.approval); h.store.artifacts.processJobs();
    assert.equal(h.store.artifacts.detail(h.c.id).reviews[0]!.current, false); assert.equal(h.store.artifacts.detail(h.c.id).reviews[0]!.verdict, 'accept');
  } finally { h.close(); }
});

test('N5: queued reviews expire when materials change and old running review callbacks cannot submit', () => {
  for (const running of [false, true]) { const h = setup(); try {
    const p = h.publish(), r = h.store.artifacts.requestReview(h.c.id, { requestId: requestId(), versionId: p.version.id, digest: p.version.digest, reviewerMemberId: 'claude' }).review;
    const i = running ? h.run(false) : undefined, a = h.store.artifacts.detail(h.c.id).artifacts[0]!;
    const next = h.propose({ artifactId: a.id, expectedRevision: a.revision, baseVersionId: a.headVersionId, content: 'new' }); h.approve(next.approval); h.store.artifacts.processJobs(); h.store.artifacts.sweep();
    assert.equal(h.store.artifacts.review(r.id).state, 'stale');
    if (i) assert.throws(() => h.store.artifacts.submitReview(i.id, { reviewId: r.id, versionId: p.version.id, digest: p.version.digest, expectedRevision: r.revision, verdict: 'accept', comment: 'late' }, 'late'));
    else { assert.equal(h.store.admitNext(), undefined); assert.equal(h.store.detail(h.c.id).deliveries[0]!.status, 'withdrawn'); }
  } finally { h.close(); } }
});

test('N5: code review binds real clean HEAD and rejects dirty content', () => {
  const h = setup(); try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: h.workspace, stdio: 'pipe' }); git('init'); writeFileSync(join(h.workspace, 'test.txt'), 'one'); git('add', '.'); git('-c', 'user.name=N5', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
    const p = h.publish(), r = h.store.artifacts.requestReview(h.c.id, { requestId: requestId(), versionId: p.version.id, digest: p.version.digest, reviewerMemberId: 'claude', codeReview: true }).review; assert.ok(r.headCommit);
    const i = h.run(false); writeFileSync(join(h.workspace, 'test.txt'), 'dirty');
    assert.throws(() => h.store.artifacts.submitReview(i.id, { reviewId: r.id, versionId: p.version.id, digest: p.version.digest, expectedRevision: r.revision, verdict: 'accept', comment: 'bad' }, 'verdict'));
  } finally { h.close(); }
});

test('N5: exact interactive answer, parameter drift, duplicate delivery and cancellation protection', async () => {
  const h = setup(); try {
    const i = h.run(), args = { questions: [{ id: 'choice', question: 'Choose output', options: ['Markdown', 'Text'] }] }, controller = new AbortController();
    const waiting = h.store.interactions.tool(i.id, args, 'q1', controller.signal), q = h.store.interactions.list()[0]!;
    const answer = { requestId: requestId(), expectedRevision: q.revision, payloadDigest: q.payloadDigest, answers: { choice: 'Markdown' } };
    assert.throws(() => h.store.interactions.answer(q.id, { ...answer, payloadDigest: 'wrong' }));
    h.store.interactions.answer(q.id, answer); h.store.interactions.answer(q.id, answer); assert.equal((await waiting).answers?.choice, 'Markdown');
    assert.equal((await h.store.interactions.tool(i.id, args, 'q1', controller.signal)).state, 'cancelled');
    await assert.rejects(h.store.interactions.tool(i.id, { questions: [{ id: 'choice', question: 'changed' }] }, 'q1', controller.signal));
    const waiting2 = h.store.interactions.tool(i.id, args, 'q2', controller.signal), q2 = h.store.interactions.list()[1]!; h.store.cancel(i.id); controller.abort();
    assert.equal((await waiting2).state, 'cancelled'); assert.throws(() => h.store.interactions.answer(q2.id, { ...answer, requestId: requestId(), expectedRevision: q2.revision, payloadDigest: q2.payloadDigest }));
  } finally { h.close(); }
});

test('N5: interaction and artifact expiration, invalid question identities, read-only legacy contracts', () => {
  const h = setup(); try {
    const i = h.run(), p = h.propose();
    const a = { ...p.approval, expiresAt: new Date(0).toISOString() }; h.owner.db.prepare('UPDATE cc_artifact_approvals SET value=? WHERE id=?').run(JSON.stringify(a), a.id); h.store.artifacts.sweep(); assert.equal(h.store.artifacts.detail(h.c.id).artifactApprovals[0]!.state, 'expired');
    const req = { providerRequestId: 'q', kind: 'question' as const, operation: 'user_question', questions: [{ id: 'q', question: 'Proceed?' }], payload: {} };
    const q = h.store.interactions.create(i.id, req, 'platform'); q.expiresAt = new Date(0).toISOString(); h.owner.db.prepare('UPDATE cc_runtime_interactions SET value=? WHERE id=?').run(JSON.stringify(q), q.id); h.store.interactions.sweep(); assert.equal(h.store.interactions.get(q.id).state, 'expired');
    assert.throws(() => h.store.interactions.create(i.id, { ...req, providerRequestId: 'bad', questions: [{ id: '__proto__', question: 'bad' }] }, 'platform'));
    const contract = h.store.contract(i.id); contract.toolPolicyVersion = 'readonly-tasks-v1'; h.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE id=?').run(JSON.stringify(contract), contract.id);
    assert.throws(() => h.propose({}, i.id)); assert.equal(runtimeTools(contract).length, 7); assert.equal(runtimeTools({ toolPolicyVersion: 'managed-artifacts-v1' }).length, 13);
  } finally { h.close(); }
});

test('N5 Terra P2: replaced ancestor symlink is rejected across a reconstructed file service', () => {
  const h = setup(); try {
    const p = h.propose(); h.approve(p.approval); const j = h.store.artifacts.claimJob(h.store.artifacts.detail(h.c.id).jobs[0]!.id);
    const parent = join(h.dir, 'parent'), replacement = join(h.dir, 'replacement'); mkdirSync(parent); mkdirSync(replacement);
    new ArtifactFiles(join(parent, 'objects')).write(j, p.version, 'fixed material');
    renameSync(parent, parent + '-old'); symlinkSync(replacement, parent);
    const restarted = new ArtifactFiles(join(parent, 'objects'));
    assert.throws(() => restarted.write({ ...j, id: randomUUID() }, p.version, 'fixed material'), /symbolic/);
    assert.equal(restarted.inspect(j, p.version), undefined);
  } finally { h.close(); }
});

test('N5: submitted review preserves exact response/input/cancel revision and fails closed after drift', () => {
  const h = setup(); try {
    const p = h.publish(), r = h.store.artifacts.requestReview(h.c.id, { requestId: requestId(), versionId: p.version.id, digest: p.version.digest, reviewerMemberId: 'claude' }).review, i = h.run(false);
    h.store.artifacts.submitReview(i.id, { reviewId: r.id, versionId: p.version.id, digest: p.version.digest, expectedRevision: r.revision, verdict: 'accept', comment: 'exact' }, 'submit');
    assert.equal(h.store.artifacts.detail(h.c.id).reviews[0]!.current, true);
    const response = h.store.response(i.responseId); response.inputRevision++; h.owner.db.prepare('UPDATE cc_responses SET value=? WHERE id=?').run(JSON.stringify(response), response.id);
    assert.equal(h.store.artifacts.detail(h.c.id).reviews[0]!.current, false);
  } finally { h.close(); }
});

test('N5: native resolved request cancels an answer before adapter delivery without closing a same-ID platform question', async () => {
  const h = setup(); try {
    const i = h.run(), req = { providerRequestId: 'shared-id', kind: 'question' as const, operation: 'item/tool/requestUserInput', questions: [{ id: 'q', question: 'Format?' }], payload: {} };
    const platform = h.store.interactions.create(i.id, req, 'platform');
    const waiting = h.store.interactions.wait(i.id, req, 'codex', new AbortController().signal), native = h.store.interactions.list().find(q => q.transport === 'codex')!;
    h.store.interactions.answer(native.id, { requestId: requestId(), expectedRevision: native.revision, payloadDigest: native.payloadDigest, answers: { q: 'Text' } });
    h.store.interactions.resolved(i.id, req.providerRequestId);
    assert.equal((await waiting).state, 'cancelled'); assert.equal(h.store.interactions.get(platform.id).state, 'pending');
  } finally { h.close(); }
});
