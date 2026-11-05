import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { CollaborationRuntime, RuntimeRequest } from '../shared/collaboration.js';

test('N5 HTTP: proposal → exact approval → managed file → real callback boundary review; CSRF, download and identity restrictions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n5-http-')); const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe: async () => [], invoke: async r => {
    calls.push(r); r.onEvent({ kind: 'accepted', detail: {} });
    if (r.member.id === 'codex') await r.onToolCall('artifact_propose', { name: 'test.html', content: '<script>window.BAD=true</script>Exact content' }, 'p1');
    else {
      const list: any = await r.onToolCall('artifact_list', {}, 'list'), review = list.reviews[0];
      const read: any = await r.onToolCall('artifact_read', { versionId: review.versionId }, 'read'); assert.match(read.content, /Exact content/);
      await r.onToolCall('review_submit', { reviewId: review.id, versionId: review.versionId, digest: review.digest, expectedRevision: review.revision, verdict: 'accept', comment: 'Reviewed as plain text' }, 'verdict');
    }
    r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'Done', continuity: 'fresh' };
  } };
  const app = await createApplication({ dataDir: dir, port: 0, collaborationRuntime: runtime });
  try {
    const { url } = await app.start(), boot = await (await fetch(url + '/api/collaboration/bootstrap')).json() as any;
    const api = async (path: string, body?: unknown, csrf = true) => { const r = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': boot.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() as any }; };
    const until = async (check: () => boolean) => { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('N5 HTTP timeout'); await new Promise(r => setTimeout(r, 20)); } };
    const c = (await api('/api/conversations', { requestId: 'c', title: 'N5 HTTP', memberIds: ['codex', 'claude'], defaultMemberId: 'codex' })).body.conversation;
    await api(`/api/conversations/${c.id}/messages`, { requestId: 'm', content: '@codex propose' });
    await until(() => app.collaborationStore.invocations(c.id)[0]?.status === 'succeeded');
    const p = app.collaborationStore.artifacts.detail(c.id), a = p.artifactApprovals[0]!, v = p.artifactVersions[0]!;
    assert.equal((await api(`/api/managed-artifacts/versions/${v.id}/download`)).status, 409);
    const decision = { requestId: 'a', expectedRevision: a.revision, operationDigest: a.operationDigest, decision: 'approve' };
    assert.equal((await api(`/api/artifact-approvals/${a.id}/decide`, decision, false)).status, 403);
    assert.equal((await api(`/api/artifact-approvals/${a.id}/decide`, { ...decision, actor: { kind: 'agent' } })).status, 400);
    assert.equal((await api(`/api/artifact-approvals/${a.id}/decide`, decision)).status, 200);
    await until(() => app.collaborationStore.artifacts.detail(c.id).jobs[0]?.state === 'succeeded');
    const download = await fetch(url + `/api/managed-artifacts/versions/${v.id}/download`); assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment/); assert.match(download.headers.get('content-type')!, /text\/plain/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await api(`/api/conversations/${c.id}/artifact-reviews`, { requestId: 'r', versionId: v.id, digest: v.digest, reviewerMemberId: 'claude' })).status, 200);
    await until(() => app.collaborationStore.invocations(c.id).length === 2 && app.collaborationStore.invocations(c.id).every(i => i.status === 'succeeded'));
    const d = (await api(`/api/conversations/${c.id}`)).body; assert.equal(d.reviews[0].current, true); assert.equal(d.reviews[0].verdict, 'accept'); assert.equal(d.tasks.length, 0); assert.equal(calls.length, 2);
    assert.equal((await api(`/api/managed-jobs/${d.jobs[0].id}/reconcile`, { observation: { state: 'succeeded' } })).status, 400);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N5 Terra P1: application refuses workspace overlapping managed artifact directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n5-overlap-'));
  try { for (const suffix of ['', '/nested']) await assert.rejects(createApplication({ dataDir: dir, port: 0, workspace: join(dir, 'collaboration-artifacts' + suffix) }), /不得重叠/); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
