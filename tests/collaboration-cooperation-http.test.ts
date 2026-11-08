import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { CollaborationRuntime, RuntimeRequest } from '../shared/collaboration.js';
const rid = () => randomUUID();
async function setup(runtime?: CollaborationRuntime) {
  const dir = await mkdtemp(join(tmpdir(), 'n6-http-'));
  const app = await createApplication({ port: 0, dataDir: dir, startWorker: !!runtime, collaborationRuntime: runtime ?? { probe: async () => [], invoke: async () => { throw new Error('No live model'); } } });
  const { url } = await app.start(), boot: any = await (await fetch(url + '/api/collaboration/bootstrap')).json();
  const api = async (path: string, body?: unknown, csrf = boot.csrfToken) => {
    const r = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() as any };
  };
  const c = (await api('/api/conversations', { title: 'N6 HTTP', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: rid() })).data.conversation;
  return { app, api, c, boot, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }); } };
}
const until = async (predicate: () => boolean) => { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) throw new Error('N6 HTTP timeout'); await new Promise(r => setTimeout(r, 10)); } };

test('N6 HTTP: source queue CAS, exact scope, CSRF, group cancellation and forged evidence rejection', async () => {
  const h = await setup(); try {
    assert.equal(h.boot.version, '0.25.0-p8-pr-ci');
    const path = '/api/conversations/' + h.c.id;
    const a = (await h.api(path + '/messages', { requestId: rid(), content: '@codex one' })).data.source;
    const b = (await h.api(path + '/messages', { requestId: rid(), content: '@claude two' })).data.source;
    let d = (await h.api(path)).data;
    const input = { requestId: rid(), expectedRevision: d.queue.revision, sourceIds: [b.id, a.id] };
    assert.equal((await h.api(path + '/queue-order', input, '')).status, 403);
    assert.equal((await h.api(path + '/queue-order', input)).status, 200);
    assert.equal((await h.api(path + '/queue-order', { ...input, requestId: rid() })).status, 409);
    assert.equal((await h.api(path + '/queue-order', input)).status, 200);
    assert.equal((await h.api('/api/sources/' + a.id + '/withdraw', { requestId: rid(), expectedRevision: a.revision })).status, 200);
    assert.equal((await h.api(path + '/mention-groups', { requestId: rid(), targets: ['codex', 'claude'], question: 'q', actor: 'forged' })).status, 400);
    const g = (await h.api(path + '/mention-groups', { requestId: rid(), targets: ['codex', 'claude'], question: 'q' })).data.group;
    assert.equal((await h.api('/api/mention-groups/' + g.id + '/cancel', { requestId: rid(), expectedRevision: g.revision })).status, 200);
    assert.equal((await h.api('/api/input-handoffs/fake/inspect', { requestId: rid(), expectedRevision: 1, observation: { state: 'accepted' } })).status, 400);
    assert.equal((await h.api(path + '/messages', { requestId: rid(), content: 'x', deliveryMode: 'newest' })).status, 400);
    d = (await h.api(path)).data; assert.equal(d.groups[0].state, 'cancelled'); assert.equal(d.queue.sources[0].id, b.id);
  } finally { await h.close(); }
});

test('N6 HTTP + engine: natural input appends to the exact run, tool-read adds separate pending work, caller cannot forge identities', async () => {
  let release: (() => void) | undefined, request: RuntimeRequest | undefined;
  const sends: string[] = [];
  const h = await setup({ probe: async () => [], invoke: async r => {
    request = r; r.onEvent({ kind: 'session', detail: { nativeSessionId: 'thread', nativeTurnId: 'turn' } }); r.onEvent({ kind: 'accepted', detail: {} });
    r.onAppendReady?.({
      send: async x => { sends.push(x.id); return { nativeSessionId: 'thread', nativeTurnId: 'turn', nativeDeliveryId: x.nativeDeliveryId, state: 'accepted', reason: 'synthetic ACK', observedAt: new Date().toISOString() }; },
      inspect: async x => ({ nativeSessionId: 'thread', nativeTurnId: 'turn', nativeDeliveryId: x.nativeDeliveryId, state: 'read', reason: 'synthetic exact read', observedAt: new Date().toISOString() }),
    });
    await new Promise<void>(resolve => { release = resolve; r.signal.addEventListener('abort', () => resolve(), { once: true }); });
    r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'done', continuity: 'fresh' };
  } });
  try {
    const path = '/api/conversations/' + h.c.id;
    await h.api(path + '/messages', { requestId: rid(), content: '@codex first' }); await until(() => !!release);
    const extra = (await h.api(path + '/messages', { requestId: rid(), content: '@codex second' })).data.source;
    await until(() => h.app.collaborationStore.cooperation.handoffs()[0]?.state === 'accepted');
    const handoff = h.app.collaborationStore.cooperation.handoffs()[0]!;
    assert.equal(handoff.sourceId, extra.id); assert.equal(sends.length, 1);
    assert.equal((await h.api('/api/input-handoffs/' + handoff.id + '/inspect', { requestId: rid(), expectedRevision: handoff.revision })).data.handoff.state, 'read');
    const queued = (await h.api(path + '/messages', { requestId: rid(), content: '@codex next', deliveryMode: 'next_turn' })).data.source;
    const directory: any = await request!.onToolCall('conversation_pending', {}, 'directory');
    assert.deepEqual(directory.sources.map((s: any) => s.id), [queued.id]);
    await assert.rejects(request!.onToolCall('conversation_read', { sourceIds: [queued.id], invocationId: 'forged' }, 'bad'));
    await request!.onToolCall('conversation_read', { sourceIds: [queued.id] }, 'read');
    release!(); await until(() => h.app.collaborationStore.invocations()[0]?.status === 'succeeded');
    const d = (await h.api(path)).data;
    assert.equal(d.responses[0].inputSourceIds.length, 3); assert.equal(d.responses[0].inputRevision, 3); assert.equal(d.invocations.length, 1);
    assert.equal(d.inputExposures.length, 2); assert.equal(d.inputHandoffs[0].state, 'read');
  } finally { release?.(); await h.close(); }
});

test('N6 engine: identity probe failure backs off prepared work without entering the runtime', async () => {
  let probes = 0, invokes = 0;
  const h = await setup({ probe: async () => [], sessionIdentity: async () => { probes++; throw new Error('temporary discovery error'); }, invoke: async () => { invokes++; throw new Error('must not run'); } });
  try {
    await h.api('/api/conversations/' + h.c.id + '/messages', { requestId: rid(), content: '@codex probe only' });
    await until(() => h.app.collaborationStore.cooperation.queue(h.c.id).backoffs.length === 1);
    for (let n = 0; n < 4; n++) h.app.collaborationEngine.kick();
    assert.equal(probes, 1); assert.equal(invokes, 0);
    const i = h.app.collaborationStore.invocations()[0]!; assert.equal(i.status, 'prepared'); assert.equal(i.dispatchStarted, false);
  } finally { await h.close(); }
});
