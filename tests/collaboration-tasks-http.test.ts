import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { CollaborationBootstrap, CollaborationRuntime, OrdinaryTask, RuntimeRequest } from '../shared/collaboration.js';

const version = (t: OrdinaryTask) => ({ requestId: randomUUID(), expectedRevision: t.revision, expectedOwnerRevision: t.ownerRevision });
async function setup(runtime?: CollaborationRuntime) {
  const dir = await mkdtemp(join(tmpdir(), 'n4-http-'));
  const app = await createApplication({ port: 0, dataDir: dir, startWorker: !!runtime, collaborationRuntime: runtime ?? { probe: async () => [], invoke: async () => { throw new Error('No live model in test'); } } });
  const { url } = await app.start(), boot = await (await fetch(url + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
  const api = async (path: string, body?: unknown, headers = {}) => {
    const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() as any };
  };
  const c = (await api('/api/conversations', { title: 'N4 HTTP', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() })).data.conversation;
  return { app, api, c, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('N4 HTTP: CSRF, body identity, revision and replay guards protect task creation/assignment/completion', async () => {
  const h = await setup(); try {
    const path = `/api/conversations/${h.c.id}/ordinary-tasks`, input = { requestId: randomUUID(), title: 'Optional', description: '', ownerMemberId: null };
    assert.equal((await h.api(path, input, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await h.api(path, input, { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await h.api(path, { ...input, actor: { kind: 'agent', invocationId: 'fake' } })).status, 400);
    const created = await h.api(path, input); assert.equal(created.status, 201); const t = created.data.task as OrdinaryTask;
    const replay = await h.api(path, input); assert.equal(replay.status, 200); assert.equal(replay.data.task.id, t.id);
    assert.equal((await h.api(`/api/ordinary-tasks/${t.id}/handoff`, { ...version(t), targetMemberId: 'claude', reason: 'Assign', stopCurrent: 'yes' })).status, 400);
    const transfer = await h.api(`/api/ordinary-tasks/${t.id}/handoff`, { ...version(t), targetMemberId: 'claude', reason: 'Assign' });
    assert.equal(transfer.status, 200); assert.equal(transfer.data.handoff.state, 'applied');
    assert.equal((await h.api(`/api/ordinary-tasks/${t.id}/update`, { ...version(t), status: 'done' })).status, 409);
    assert.equal((await h.api(`/api/ordinary-tasks/${t.id}/update`, { ...version(transfer.data.task), status: 'blocked' })).status, 400);
    assert.equal((await h.api(`/api/ordinary-tasks/${t.id}/update`, { ...version(transfer.data.task), status: 'done' })).status, 200);
    const detail = (await h.api(`/api/conversations/${h.c.id}`)).data;
    assert.equal(detail.tasks[0].status, 'done'); assert.equal(detail.deliveries[0].status, 'withdrawn'); assert.equal(detail.responsibility[0].state, 'resolved');
    assert.equal(detail.invocations.length, 0);
  } finally { await h.close(); }
});

test('N4 HTTP + engine: injected adapters use server-bound task tools; transfer waits for actual release then target explicitly completes', async () => {
  const calls: RuntimeRequest[] = []; let release: (() => void) | undefined;
  const errors: string[] = [];
  const h = await setup({ probe: async () => [], invoke: async r => {
    calls.push(r); r.onEvent({ kind: 'accepted', detail: {} });
    assert.equal(r.toolPolicyVersion, 'cooperation-v2');
    const read = await r.onToolCall('task_list', {}, `read-${r.member.id}`) as { tasks: OrdinaryTask[] }, t = read.tasks[0]!;
    try { await r.onToolCall('task_update', { taskId: t.id, actor: { kind: 'user' }, status: 'done' }, 'forged'); } catch { errors.push('identity rejected'); }
    if (r.member.id === 'codex') {
      const result = await r.onToolCall('task_handoff', { taskId: t.id, expectedRevision: t.revision, expectedOwnerRevision: t.ownerRevision, targetMemberId: 'claude', reason: 'Actual target should finish' }, 'transfer') as any;
      assert.equal(result.handoff.state, 'waiting'); await new Promise<void>(resolve => { release = resolve; });
    } else await r.onToolCall('task_update', { taskId: t.id, expectedRevision: t.revision, expectedOwnerRevision: t.ownerRevision, status: 'done', reason: 'Explicit tool success' }, 'complete');
    r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'Successful reply', continuity: 'fresh' };
  } });
  const until = async (condition: () => boolean) => { const end = Date.now() + 4000; while (!condition()) { if (Date.now() > end) throw new Error('HTTP task timeout'); await new Promise(r => setTimeout(r, 15)); } };
  try {
    await h.api(`/api/conversations/${h.c.id}/ordinary-tasks`, { requestId: randomUUID(), title: 'Handoff', description: '', ownerMemberId: 'codex' });
    await until(() => !!release); let d = (await h.api(`/api/conversations/${h.c.id}`)).data;
    assert.equal(d.tasks[0].ownerMemberId, 'codex'); assert.equal(d.taskHandoffs[0].state, 'waiting'); assert.equal(calls.length, 1);
    release!(); await until(() => calls.length === 2 && h.app.collaborationStore.tasks.list(h.c.id)[0]?.executionRef === undefined);
    d = (await h.api(`/api/conversations/${h.c.id}`)).data; assert.equal(d.tasks[0].status, 'done'); assert.equal(d.tasks[0].ownerMemberId, 'claude');
    assert.equal(d.sources.length, 2); assert.equal(d.consumptions.length, 2); assert.equal(errors.length, 2);
  } finally { release?.(); await h.close(); }
});
