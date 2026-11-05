import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import { ServiceLeaseLost, StaleOperation, Store } from '../server/store.js';
import type { CollaborationRuntime, RuntimeRequest } from '../shared/collaboration.js';

type Lease = { owner: string; expires_at: number };
const lease = (store: Store) => store.db.prepare('SELECT owner, expires_at FROM service_lease WHERE id=1').get() as Lease | undefined;
const expire = (store: Store) => store.db.prepare('UPDATE service_lease SET expires_at=? WHERE id=1').run(Date.now() - 60_000);
const role = { name: '租约测试角色', description: '测试事务恢复。', instructions: '完成测试。', tools: [] };
const probe: CollaborationRuntime['probe'] = async () => [
  { carrier: 'codex-app-server', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested' },
];
function accepted(request: RuntimeRequest) {
  request.onEvent({ kind: 'accepted', detail: { nativeTurnId: `turn-${request.invocationId}`, protocol: 'lease-test' } });
}
function exited(request: RuntimeRequest) {
  request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true, fixture: true } });
}
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Lease recovery condition did not settle.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function http<T = { error: string; code: string }>(app: Awaited<ReturnType<typeof createApplication>>, url: string, path: string, body?: unknown) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': app.csrfToken },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() as T };
}
const conversationInput = (requestId: string) => ({ title: '租约恢复测试', memberIds: ['codex'], defaultMemberId: 'codex', requestId });

test('expired same-owner leases renew in heartbeat and in transactional assertions before any timer runs', () => {
  const store = new Store(':memory:', { leaseMs: 30_000 });
  try {
    expire(store);
    store.heartbeat();
    assert.equal(lease(store)?.owner, store.owner);
    assert.ok(lease(store)!.expires_at > Date.now());

    expire(store);
    store.assertLease();
    assert.ok(lease(store)!.expires_at > Date.now(), 'The first callback/request assertion must renew without waiting for heartbeat.');

    expire(store);
    const saved = store.addRole(role);
    assert.equal(store.listRoles().find(item => item.id === saved.id)?.name, role.name);
    assert.ok(lease(store)!.expires_at > Date.now(), 'Renewal must also work inside an existing BEGIN IMMEDIATE transaction.');

    store.db.exec('DELETE FROM service_lease WHERE id=1');
    assert.throws(() => store.heartbeat(), ServiceLeaseLost);
    assert.throws(() => store.assertLease(), ServiceLeaseLost);
    assert.equal(lease(store), undefined, 'A missing lease must never be silently recreated by an old owner.');
  } finally { store.close(); }
  assert.throws(() => store.assertLease(), ServiceLeaseLost);
  assert.throws(() => store.heartbeat(), ServiceLeaseLost);
});

test('a real second Store takeover fences old renewal and writes, and old close preserves the new lease', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lease-takeover-'));
  const path = join(dataDir, 'platform.sqlite');
  const original = new Store(path, { leaseMs: 30_000 });
  let successor: Store | undefined;
  try {
    expire(original);
    successor = new Store(path, { leaseMs: 30_000 });
    const current = lease(successor);
    assert.equal(current?.owner, successor.owner);
    assert.throws(() => original.heartbeat(), ServiceLeaseLost);
    assert.throws(() => original.assertLease(), StaleOperation, 'Lease loss must retain execution fencing compatibility.');
    const roleCount = successor.listRoles().length;
    assert.throws(() => original.addRole(role), ServiceLeaseLost);
    assert.equal(successor.listRoles().length, roleCount);
    assert.deepEqual(lease(successor), current, 'The old owner may not extend or replace the new lease.');
    original.close();
    assert.deepEqual(lease(successor), current);
    successor.heartbeat();
    assert.equal(lease(successor)?.owner, successor.owner);
  } finally { original.close(); successor?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('HTTP sends and in-flight runtime callbacks recover after expiry without replaying invocations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lease-http-recovery-'));
  const calls: RuntimeRequest[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let callbackRenewed = false;
  let app!: Awaited<ReturnType<typeof createApplication>>;
  const runtime: CollaborationRuntime = { probe, async invoke(request) {
    calls.push(request); accepted(request);
    if (calls.length === 1) {
      await gate;
      // This synchronous callback is deliberately the first operation after expiry.
      expire(app.store);
      request.onEvent({ kind: 'text', detail: { text: '恢复后的执行结果。' } });
      callbackRenewed = lease(app.store)!.expires_at > Date.now();
    }
    exited(request);
    // Let engine.finish itself encounter the expired lease before another timer.
    expire(app.store);
    return { text: '执行完成。', continuity: 'fresh' };
  } };
  app = await createApplication({ dataDir, port: 0, leaseMs: 60_000, collaborationRuntime: runtime });
  try {
    const { url } = await app.start();
    const created = await http<{ conversation: { id: string } }>(app, url, '/api/conversations', conversationInput('lease-conversation'));
    assert.equal(created.status, 201);
    const id = created.data.conversation.id;
    const path = `/api/conversations/${id}/messages`;
    const firstMessage = { content: '开始第一项测试。', requestId: 'lease-message-1' };
    expire(app.store);
    assert.equal((await http(app, url, path, firstMessage)).status, 201);
    await until(() => calls.length === 1);
    const invocationId = calls[0]!.invocationId;

    expire(app.store);
    assert.equal((await http(app, url, path, firstMessage)).status, 200, 'An in-flight request retry must reuse its durable source.');
    assert.equal(calls.length, 1);
    releaseFirst();
    await until(() => app.collaborationStore.detail(id).responses[0]?.status === 'succeeded');
    assert.ok(callbackRenewed, 'Runtime callbacks must renew before heartbeat and retain their evidence.');
    assert.ok(lease(app.store)!.expires_at > Date.now(), 'Completion must renew and persist its result.');
    assert.equal(app.collaborationStore.detail(id).invocations[0]?.id, invocationId);

    expire(app.store);
    assert.equal((await http(app, url, path, firstMessage)).status, 200, 'A completed request retry must not dispatch again.');
    expire(app.store);
    const secondMessage = { content: '继续第二项测试。', requestId: 'lease-message-2' };
    assert.equal((await http(app, url, path, secondMessage)).status, 201);
    await until(() => { const result = app.collaborationStore.detail(id); return result.responses.length === 2 && result.responses.every(item => item.status === 'succeeded'); });
    const detail = app.collaborationStore.detail(id);
    assert.equal(calls.length, 2);
    assert.equal(new Set(calls.map(item => item.invocationId)).size, 2);
    assert.equal(detail.sources.length, 2);
    assert.equal(detail.consumptions.length, 2);
    assert.ok(detail.invocations.every(item => item.acceptance === 'accepted' && item.teardown === 'confirmed'));
    assert.equal((await http(app, url, '/health')).status, 200);
  } finally { releaseFirst(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('heartbeat detects actual takeover, aborts scheduling, and HTTP reports service_lease_lost instead of 500', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lease-http-takeover-'));
  const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe, async invoke(request) {
    calls.push(request); accepted(request);
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('Fixture stopped after lease takeover.')), { once: true });
    });
  } };
  const app = await createApplication({ dataDir, port: 0, leaseMs: 600, collaborationRuntime: runtime });
  let successor: Store | undefined;
  try {
    const { url } = await app.start();
    const created = await http<{ conversation: { id: string } }>(app, url, '/api/conversations', conversationInput('takeover-conversation'));
    assert.equal(created.status, 201);
    const id = created.data.conversation.id;
    const path = `/api/conversations/${id}/messages`;
    assert.equal((await http(app, url, path, { content: '运行中的任务。', requestId: 'takeover-running' })).status, 201);
    await until(() => calls.length === 1);
    assert.equal((await http(app, url, path, { content: '排队中的任务。', requestId: 'takeover-queued' })).status, 201);
    const sourcesBefore = app.collaborationStore.detail(id).sources.length;

    // No await between expiry and construction: the second owner really claims the row.
    expire(app.store);
    successor = new Store(join(dataDir, 'platform.sqlite'), { leaseMs: 30_000 });
    await until(() => calls[0]!.signal.aborted);
    assert.equal(calls.length, 1, 'The queued task must not execute after the owner changes.');
    for (const endpoint of ['/health', '/api/collaboration/bootstrap', `/api/conversations/${id}`]) {
      const response = await http(app, url, endpoint);
      assert.equal(response.status, 503, endpoint);
      assert.equal(response.data.code, 'service_lease_lost', endpoint);
      assert.notEqual(response.data.error, 'Internal server error.');
    }
    const rejected = await http(app, url, path, { content: '不得接受的新任务。', requestId: 'takeover-rejected' });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.data.code, 'service_lease_lost');
    const detail = app.collaborationStore.detail(id);
    assert.equal(detail.sources.length, sourcesBefore);
    assert.equal(detail.invocations.length, 1);
    assert.equal(detail.invocations[0]!.acceptance, 'accepted');
    assert.notEqual(detail.invocations[0]!.teardown, 'confirmed', 'An old owner cannot invent successful teardown evidence.');
    await app.close();
    successor.assertLease();
    assert.equal(lease(successor)?.owner, successor.owner);
  } finally { await app.close(); successor?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('a transient heartbeat storage error does not permanently stop the collaboration engine', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lease-transient-heartbeat-'));
  const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe, async invoke(request) {
    calls.push(request); accepted(request); exited(request);
    return { text: '瞬时故障后仍能执行。', continuity: 'fresh' };
  } };
  const app = await createApplication({ dataDir, port: 0, leaseMs: 600, collaborationRuntime: runtime });
  const heartbeat = app.store.heartbeat.bind(app.store);
  let attempts = 0;
  app.store.heartbeat = () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Controlled transient storage failure.');
    heartbeat();
  };
  try {
    const { url } = await app.start();
    await until(() => attempts >= 2);
    assert.equal((await http(app, url, '/health')).status, 200);
    const created = await http<{ conversation: { id: string } }>(app, url, '/api/conversations', conversationInput('transient-conversation'));
    assert.equal(created.status, 201);
    const id = created.data.conversation.id;
    assert.equal((await http(app, url, `/api/conversations/${id}/messages`, { content: '瞬时存储故障后的任务。', requestId: 'transient-message' })).status, 201);
    await until(() => app.collaborationStore.detail(id).responses[0]?.status === 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(lease(app.store)?.owner, app.store.owner);
  } finally { app.store.heartbeat = heartbeat; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
