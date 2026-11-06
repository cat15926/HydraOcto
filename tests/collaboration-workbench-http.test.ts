import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { RuntimeRequest } from '../shared/collaboration.js';
const rid = () => randomUUID();
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'n7-http-')), workspace = join(root, 'workspace'); await mkdir(workspace);
  const calls: RuntimeRequest[] = [];
  const app = await createApplication({ port: 0, dataDir: join(root, 'private'), workspace, collaborationRuntime: {
    probe: async () => [],
    discoverAccount: async a => ({ accountId: a.id, accountRevision: a.revision ?? 1, installed: true, configured: true, checkedAt: new Date().toISOString(), connection: 'reachable', identity: { state: 'unknown' }, models: [{ id: 'fixture-model', name: 'Synthetic model', efforts: [] }], catalogSource: 'http-fixture', quota: { state: 'unknown' } }),
    invoke: async r => { calls.push(r); r.onEvent({ kind: 'accepted', detail: { source: 'synthetic' } }); r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'Synthetic result containing uploaded material', continuity: 'fresh' }; },
  } });
  const { url } = await app.start(); const boot: any = await (await fetch(url + '/api/collaboration/bootstrap')).json();
  const api = async (path: string, body?: unknown, csrf = boot.csrfToken) => { const res = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: res.status, data: await res.json() as any }; };
  return { app, url, boot, api, calls, root, workspace, close: async () => { await app.close(); await rm(root, { force: true, recursive: true }); } };
}
async function until(fn: () => boolean) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 20)); } }
test('N7 HTTP: configure real-directory member -> explicit workspace grant -> pure attachment -> actual runtime request and reply reference', async () => {
  const h = await setup(); try {
    assert.equal(h.boot.version, '0.8.0-n7');
    assert.equal((await h.api('/api/accounts/codex-cli/probe', { identity: 'forged' })).status, 400);
    assert.equal((await h.api('/api/accounts/codex-cli/probe', {})).status, 200);
    const member = { ...h.boot.members[0], aliases: ['reviewer'], model: 'fixture-model', expectedRevision: 1, requestId: rid() };
    assert.equal((await h.api('/api/members', member, '')).status, 403);
    assert.equal((await h.api('/api/members', member)).status, 200);
    assert.equal((await h.api('/api/members', { ...member, requestId: rid() })).status, 409);
    assert.equal((await h.api('/api/members', { ...member, expectedRevision: 2, requestId: rid(), model: 'invented' })).status, 409);
    assert.equal((await h.api('/api/members', { ...member, requestId: undefined, expectedRevision: undefined })).status, 400, 'omitting CAS cannot bypass catalog validation');
    const c = (await h.api('/api/conversations', { title: 'N7 flow', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: rid() })).data.conversation;
    const path = '/api/conversations/' + c.id;
    const p = (await h.api(path + '/workspace-preview', { path: h.workspace })).data;
    assert.equal((await h.api(path + '/workspace-apply', { previewId: p.id, requestId: rid() }, '')).status, 403);
    assert.equal((await h.api(path + '/workspace-apply', { previewId: p.id, requestId: rid() })).status, 200);
    const a = (await h.api(path + '/attachments', { requestId: rid(), name: '<b>.txt', base64: Buffer.from('N7_EXACT_ATTACHMENT @claude').toString('base64'), mediaType: 'text/plain' })).data.result;
    const s = await h.api(path + '/messages', { content: '', attachmentIds: [a.id], requestId: rid() }); assert.equal(s.status, 201);
    await until(() => h.app.collaborationStore.invocations().some(i => i.status === 'succeeded'));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.member.model, 'fixture-model'); assert.equal(h.calls[0]!.member.id, 'codex');
    assert.ok(h.calls[0]!.prompt.includes('N7_EXACT_ATTACHMENT')); assert.ok(h.calls[0]!.workspaceGrant);
    const d = (await h.api(path)).data; const m = d.messages.find((m: any) => m.author === 'user');
    assert.equal((await h.api(path + '/messages', { content: 'follow up', replyTo: m.id, requestId: rid() })).status, 201);
    await until(() => h.app.collaborationStore.invocations().filter(i => i.status === 'succeeded').length === 2);
    assert.ok(h.calls[1]!.prompt.includes('N7_EXACT_ATTACHMENT'));
    const boot = (await h.api('/api/collaboration/bootstrap')).data; assert.equal(boot.accountObservations.find((o: any) => o.accountId === 'codex-cli').latestInvocation.status, 'succeeded');
    assert.equal(boot.accountObservations.find((o: any) => o.accountId === 'codex-cli').quota.state, 'unknown');
  } finally { await h.close(); }
});
test('N7 HTTP: durable event pages and SSE Last-Event-ID replay exact subsequent events; foreign attachment IDs rejected', async () => {
  const h = await setup(); try {
    const create = async () => (await h.api('/api/conversations', { title: 'events', memberIds: ['codex'], defaultMemberId: 'codex', requestId: rid() })).data.conversation;
    const c = await create(), other = await create(); const path = '/api/conversations/' + c.id;
    const cursor = h.app.collaborationStore.cursor();
    const a = (await h.api(path + '/attachments', { requestId: rid(), name: 'events.txt', base64: 'ZXZlbnRz', mediaType: 'text/plain' })).data.result;
    assert.equal((await h.api(`/api/conversations/${other.id}/attachments/${a.id}`)).status, 404);
    assert.equal((await h.api(`/api/conversations/${other.id}/messages`, { content: '', attachmentIds: [a.id], requestId: rid() })).status, 400);
    const first = (await h.api('/api/collaboration/event-page?after=' + cursor)).data;
    assert.equal(first.events.length, 1); assert.equal(first.events[0].type, 'attachment.uploaded');
    assert.deepEqual((await h.api('/api/collaboration/event-page?after=' + first.nextCursor)).data.events, []);
    const controller = new AbortController(); const response = await fetch(h.url + '/api/collaboration/events?after=0', { headers: { 'last-event-id': String(cursor) }, signal: controller.signal });
    const reader = response.body!.getReader(); const read = await reader.read(); const body = Buffer.from(read.value!).toString('utf8'); controller.abort();
    assert.ok(body.includes(`id: ${first.nextCursor}\n`)); assert.ok(!body.includes('conversation.created')); assert.ok(body.includes('user_upload'));
    assert.equal((await h.api('/api/collaboration/event-page?after=-1')).status, 400);
  } finally { await h.close(); }
});
