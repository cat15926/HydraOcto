import assert from 'node:assert/strict';
import { randomFillSync, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { FolderPicker } from '../server/collaboration/folder-picker.js';
import type { RuntimeRequest } from '../shared/collaboration.js';
const rid = () => randomUUID();
async function setup(folderPicker?: FolderPicker) {
  const root = await mkdtemp(join(tmpdir(), 'n7-http-')), workspace = join(root, 'workspace'); await mkdir(workspace);
  const calls: RuntimeRequest[] = [];
  const app = await createApplication({ port: 0, folderPicker, dataDir: join(root, 'private'), workspace, collaborationRuntime: {
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
    assert.equal(h.boot.version, '0.25.0-p8-pr-ci');
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

test('desktop folder selection checks the target twice and cannot grant on open, cancel or disconnect', async () => {
  let resolvePicker!: (value: string | null) => void, opens = 0, aborts = 0;
  const h = await setup(signal => new Promise(resolve => {
    ++opens; resolvePicker = resolve;
    signal.addEventListener('abort', () => { ++aborts; resolve(null); }, { once: true });
  }));
  try {
    const c = (await h.api('/api/conversations', { title: 'picker', memberIds: ['codex'], defaultMemberId: 'codex', requestId: rid() })).data.conversation;
    const base = '/api/conversations/' + c.id, pick = base + '/workspace-pick', body = {expectedRevision: c.revision ?? 1};
    assert.equal((await h.api(pick, body, '')).status, 403);
    assert.equal((await h.api(pick, { ...body, path: h.workspace })).status, 400);
    assert.equal((await h.api(pick, {expectedRevision: 99})).status, 409);
    assert.equal(opens, 0);
    let pending = h.api(pick, body); await until(() => opens === 1);
    assert.equal((await h.api(pick, body)).status, 409);
    resolvePicker(null); assert.deepEqual((await pending).data, {preview: null});
    const controller = new AbortController();
    const disconnected = fetch(h.url + pick, {method: 'POST', signal: controller.signal, headers: {'content-type':'application/json','x-csrf-token':h.boot.csrfToken},body:JSON.stringify(body)}).catch(() => undefined);
    await until(() => opens === 2); controller.abort(); await disconnected; await until(() => aborts === 1);
    pending = h.api(pick, body); await until(() => opens === 3);
    resolvePicker(join(h.root,'private')); assert.notEqual((await pending).status, 200);
    pending = h.api(pick, body); await until(() => opens === 4);
    assert.equal((await h.api(base + '/organize', {action:'archive', requestId:rid(), ...body})).status, 200);
    resolvePicker(h.workspace); assert.equal((await pending).status, 409);
    const archived = (await h.api(base)).data.conversation;
    assert.equal((await h.api(pick, {expectedRevision:archived.revision})).status, 409);
    assert.equal(opens, 4); assert.ok(!archived.workspaceGrant);
    await h.api(base + '/organize', {action:'restore',requestId:rid(),expectedRevision:archived.revision});
    pending = h.api(pick, {expectedRevision:(await h.api(base)).data.conversation.revision});
    await until(() => opens === 5); const dir = join(h.root,'目录 with space '); await mkdir(dir); resolvePicker(dir);
    const { preview } = (await pending).data; assert.ok(preview.value.path.endsWith('/目录 with space '));
    assert.ok(!(await h.api(base)).data.conversation.workspaceGrant);
    assert.equal((await h.api(base + '/workspace-apply', {previewId:preview.id,requestId:rid()})).status,200);
    assert.equal((await h.api(base)).data.conversation.workspaceGrant.path,preview.value.path); assert.equal(h.calls.length,0);
  } finally { resolvePicker?.(null); await h.close(); }
});

test('P0 HTTP: pending project work survives the picker, unavailable confirmation and retry; private and forged requests never carry project authority', async () => {
  let chosen: string | null = null;
  const h = await setup(async () => chosen);
  try {
    const c = (await h.api('/api/conversations', { title: '项目委托', memberIds: ['codex'], defaultMemberId: 'codex', requestId: rid() })).data.conversation;
    const path = '/api/conversations/' + c.id;
    const message = { content: '请修复月报文件并运行测试', requestId: rid() };
    const waiting = await h.api(path + '/messages', message);
    assert.equal(waiting.status, 202); const intent = waiting.data.intent;
    const pick = { expectedRevision: 1, mode: 'project-work', intentId: intent.id };
    assert.equal((await h.api(path + '/workspace-pick', pick)).data.preview, null);
    assert.equal((await h.api(path)).data.projectIntents[0].id, intent.id);
    chosen = h.workspace;
    const selected = (await h.api(path + '/workspace-pick', pick)).data.preview;
    assert.deepEqual(selected.affectedMemberIds, ['codex']); assert.equal(selected.projectCapabilities[0].available, false);
    assert.equal((await h.api(path + '/workspace-apply', { previewId: selected.id, requestId: rid() })).status, 409);
    let detail = (await h.api(path)).data;
    assert.equal(detail.sources.length, 0); assert.equal(detail.conversation.workspaceGrant, undefined);
    const cmd = { expectedRevision: 1, requestId: rid() };
    assert.equal((await h.api(path + '/project-intents/' + intent.id + '/cancel', cmd)).status, 200);
    assert.equal((await h.api(path + '/messages', message)).data.intent.state, 'cancelled');
    assert.equal(h.calls.length, 0);
    const privateReply = await h.api(path + '/messages', { ...message, requestId: rid(), privateTo: ['codex'], projectWork: true });
    assert.equal(privateReply.status, 201); assert.equal(privateReply.data.source.projectWork, undefined);
    await until(() => h.app.collaborationStore.invocations().some(i => i.status === 'succeeded'));
    detail = (await h.api(path)).data;
    assert.equal(detail.sources.length, 1); assert.equal(detail.projectIntents.length, 0);
  } finally { await h.close(); }
});

test('screenshot upload uses a bounded larger HTTP body and serves only sent, visible images', async () => {
  const h = await setup();
  try {
    const c = (await h.api('/api/conversations', { title:'截图', memberIds:['codex','claude'], defaultMemberId:'codex', requestId:rid() })).data.conversation;
    const path = '/api/conversations/'+c.id;
    const width = 420, height = 360;
    const rows = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y++) randomFillSync(rows, y * (1 + width * 3) + 1, width * 3);
    const chunk = (name:string, body:Buffer) => {
      const bytes = Buffer.alloc(12 + body.length);
      bytes.writeUInt32BE(body.length,0); bytes.write(name,4); body.copy(bytes,8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);
      return bytes;
    };
    const header = Buffer.from('00000000000000000802000000','hex');
    header.writeUInt32BE(width); header.writeUInt32BE(height,4);
    const file = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
    assert.ok(file.length > 400_000);
    const upload = {requestId:rid(),name:'手机.png',mediaType:'image/png',base64:file.toString('base64')};
    const response = await h.api(path+'/attachments',upload);
    assert.equal(response.status,201);
    const a = response.data.result;
    const imageUrl = h.url + path + '/attachments/' + a.id + '/image';
    assert.equal((await fetch(imageUrl)).status,404);
    const sent = await h.api(path+'/messages',{requestId:rid(),privateTo:['codex'],content:'请看截图',attachmentIds:[a.id]});
    assert.equal(sent.status,201);
    await until(()=>h.calls.length===1);
    assert.equal(h.calls[0]?.images?.[0]?.base64,upload.base64);
    assert.ok(!h.calls[0]?.prompt.includes(upload.base64));
    assert.equal((await fetch(imageUrl+'?viewer=claude')).status,404);
    const imageResponse = await fetch(imageUrl+'?viewer=codex');
    assert.equal(imageResponse.status,200); assert.equal(imageResponse.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),file);
    assert.equal((await h.api(path+'/attachments/'+a.id)).status,415);
    assert.equal((await h.api(path+'/attachments',{...upload,requestId:rid(),mediaType:'image/jpeg'})).status,415);
    assert.equal((await h.api(path+'/messages',{requestId:rid(),content:upload.base64})).status,413);
    assert.ok(!JSON.stringify((await h.api(path)).data).includes(upload.base64));
  } finally { await h.close(); }
});
