import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import type { OrdinaryTask, TaskCommandVersion, RuntimeRequest } from '../shared/collaboration.js';

const version = (t: OrdinaryTask, requestId = randomUUID()): TaskCommandVersion => ({ requestId, expectedRevision: t.revision, expectedOwnerRevision: t.ownerRevision });
function setup(path = ':memory:') {
  const owner = new Store(path), store = new CollaborationStore(owner);
  const c = store.create({ title: 'N4 tasks', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
  const create = (assigned: string | null = 'codex') => store.tasks.create(c.id, { requestId: randomUUID(), title: 'Check task', description: 'Synthetic tracking', ownerMemberId: assigned }).task;
  const run = () => { const i = store.admitNext()!.invocations[0]!; store.startInvocation(i.id); store.recordEvidence(i.id, { kind: 'accepted', detail: {} }); return store.invocation(i.id); };
  const get = (t: OrdinaryTask) => store.tasks.getTask(t.id);
  const exit = (id: string) => store.recordEvidence(id, { kind: 'process_exit', detail: { confirmed: true, code: 0 } });
  const finish = (id: string, text = 'Reply complete', status: 'succeeded' | 'failed' = 'succeeded') => { exit(id); store.finish(id, status, text); };
  return { owner, store, c, create, run, get, exit, finish };
}

test('N4: chat has no mandatory task; unassigned creation is idempotent and does not dispatch', () => {
  const h = setup(); try {
    h.store.send(h.c.id, { content: '@codex ordinary chat', requestId: randomUUID() }); const i = h.run(); h.finish(i.id);
    assert.deepEqual(h.store.tasks.list(h.c.id), []);
    const input = { requestId: randomUUID(), title: 'Optional', description: '', ownerMemberId: null };
    const t = h.store.tasks.create(h.c.id, input).task;
    assert.equal(h.store.tasks.create(h.c.id, input).task.id, t.id);
    assert.throws(() => h.store.tasks.create(h.c.id, { ...input, title: 'Different' }), /request|幂等/i);
    assert.equal(h.store.admitNext(), undefined); assert.equal(t.ownerRevision, 0);
  } finally { h.owner.close(); }
});

test('N4: admission atomically binds source/input/fence and freezes task context; reply success is not task done', () => {
  const h = setup(); try {
    const t = h.create(), i = h.run(), bound = h.get(t), contract = h.store.contract(i.id);
    assert.equal(bound.executionRef?.invocationId, i.id); assert.equal(i.taskBindings?.[0]?.fence, bound.executionRef?.fence);
    assert.deepEqual(contract.taskSnapshot, bound); assert.equal(contract.toolPolicyVersion, 'managed-artifacts-v1');
    assert.ok(h.store.prompt(i.id).includes(t.id)); assert.ok(h.store.input(i.id)!.manifest.items.some(x => x.kind === 'task'));
    h.finish(i.id, 'The task is done.');
    assert.equal(h.get(t).status, 'todo'); assert.equal(h.get(t).executionRef, undefined);
    assert.equal(h.store.tasks.projection(h.c.id)[0]!.diagnostic, 'void');
    assert.deepEqual(h.store.contract(i.id), contract);
  } finally { h.owner.close(); }
});

test('N4: ordinary A2A is independently executable and cannot take or complete the caller task', () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(); h.store.requestCollaboration(a.id, 'help', { targets: ['claude'], content: 'Please inspect only' }); const b = h.run();
    assert.equal(b.memberId, 'claude'); assert.equal(b.taskBindings, undefined);
    assert.throws(() => h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'done' }, b.id), /准确执行/);
    h.finish(b.id); assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.get(t).executionRef?.invocationId, a.id);
    h.finish(a.id); assert.equal(h.get(t).status, 'todo');
  } finally { h.owner.close(); }
});

for (const order of ['exit-first', 'terminal-first'] as const) test(`N4: formal handoff requires both exact terminal and teardown (${order})`, () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(); const prepared = h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Finish the task' }, a.id);
    assert.equal(prepared.handoff.state, 'waiting'); assert.equal(h.get(t).ownerMemberId, 'codex');
    const delivery = h.store.detail(h.c.id).deliveries.find(d => d.sourceId === prepared.handoff.sourceId)!;
    h.store.recheckDelivery(delivery.id, { requestId: randomUUID(), expectedDeliveryRevision: delivery.revision, expectedSourceRevision: 1 });
    assert.equal(h.store.detail(h.c.id).deliveries.find(d => d.id === delivery.id)?.status, 'held'); assert.equal(h.store.admitNext(), undefined);
    if (order === 'exit-first') h.exit(a.id); else h.store.finish(a.id, 'succeeded', 'Handed to @claude');
    assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.store.admitNext(), undefined);
    if (order === 'exit-first') h.store.finish(a.id, 'succeeded', 'Handed to @claude'); else h.exit(a.id);
    const applied = h.get(t); assert.equal(applied.ownerMemberId, 'claude'); assert.equal(applied.ownerRevision, 2); assert.equal(applied.executionRef, undefined);
    assert.equal(h.store.detail(h.c.id).sources.filter(s => s.kind === 'mention').length, 0, 'Handoff summary mention must not double-dispatch its target.');
    const b = h.run(); assert.equal(h.get(t).executionRef?.invocationId, b.id);
    assert.throws(() => h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'done' }, a.id));
    h.exit(a.id); assert.equal(h.get(t).executionRef?.invocationId, b.id, 'Late old exit cannot clear new binding.');
    h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'done' }, b.id);
    assert.ok(h.get(t).executionRef, 'done does not prove exit'); h.finish(b.id); assert.equal(h.get(t).executionRef, undefined);
    assert.equal(h.get(t).status, 'done');
  } finally { h.owner.close(); }
});

test('N4: unassigned task claim requires current authorized execution; assigned pending work cannot be stolen', () => {
  const h = setup(); try {
    const free = h.create(null); h.store.send(h.c.id, { content: '@codex claim optional work', requestId: randomUUID() }); const i = h.run();
    assert.throws(() => h.store.tasks.update(free.id, { ...version(free), status: 'done' }, i.id));
    h.store.tasks.update(free.id, { ...version(free), status: 'doing' }, i.id);
    assert.equal(h.get(free).ownerMemberId, 'codex'); assert.equal(h.get(free).executionRef?.invocationId, i.id);
    const queued = h.create(); assert.throws(() => h.store.tasks.update(queued.id, { ...version(queued), status: 'doing' }, i.id));
    h.store.tasks.update(free.id, { ...version(h.get(free)), status: 'done' }, i.id); h.finish(i.id);
  } finally { h.owner.close(); }
});

test('N4: tool identity cannot be supplied, policy is frozen, and one call ID cannot mutate a second task', () => {
  const h = setup(); try {
    h.store.send(h.c.id, { content: 'manage tasks', requestId: randomUUID() }); const i = h.run();
    for (const args of [{ actor: { kind: 'user' } }, { conversationId: h.c.id }, { fence: 'forged' }]) assert.throws(() => h.store.tasks.tool(i.id, 'task_list', args, 'read'));
    const args = { title: 'Agent-created', description: '', ownerMemberId: 'codex' };
    const created = h.store.tasks.tool(i.id, 'task_create', args, 'same-call') as { task: OrdinaryTask };
    assert.equal(h.store.tasks.tool(i.id, 'task_create', args, 'same-call').tasks, undefined);
    assert.throws(() => h.store.tasks.tool(i.id, 'task_create', { ...args, title: 'different' }, 'same-call'));
    assert.throws(() => h.store.tasks.tool(i.id, 'task_update', { taskId: created.task.id, expectedRevision: created.task.revision, expectedOwnerRevision: created.task.ownerRevision, status: 'done' }, 'same-call'), /request|幂等/i);
    assert.equal(h.store.tasks.list(h.c.id).length, 1); assert.equal(created.task.executionRef?.invocationId, i.id);
    assert.throws(() => h.store.tasks.create(h.c.id, { requestId: randomUUID(), title: 'Other owner', description: '', ownerMemberId: 'claude' }, i.id));
    const contract = h.store.contract(i.id); contract.toolPolicyVersion = 'readonly-v1'; h.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE id=?').run(JSON.stringify(contract), contract.id);
    assert.throws(() => h.store.tasks.tool(i.id, 'task_list', {}, 'legacy'));
    assert.equal(runtimeTools({ toolPolicyVersion: 'readonly-v1' }).length, 3); assert.equal(runtimeTools({ toolPolicyVersion: 'readonly-tasks-v1' }).length, 7);
  } finally { h.owner.close(); }
});

for (const actor of ['agent', 'user'] as const) test(`N4: stop intent keeps ownership until release; ${actor} handoff has its own cancellation authority`, () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(); h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Transfer', stopCurrent: true }, actor === 'agent' ? a.id : undefined);
    h.store.cancel(a.id); h.store.tasks.reconcile();
    assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.get(t).executionRef?.invocationId, a.id);
    assert.equal(h.store.tasks.handoffs(h.c.id)[0]!.state, actor === 'agent' ? 'refused' : 'waiting');
    h.exit(a.id); h.store.finish(a.id, 'cancelled', 'stop confirmed');
    assert.equal(h.get(t).ownerMemberId, actor === 'agent' ? 'codex' : 'claude');
  } finally { h.owner.close(); }
});

test('N4: cancel handoff withdraws its source; replays and stale versions cannot create duplicate transfers', () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(), input = { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Transfer' };
    const first = h.store.tasks.handoff(t.id, input); assert.equal(h.store.tasks.handoff(t.id, input).handoff.id, first.handoff.id);
    assert.throws(() => h.store.tasks.handoff(t.id, { ...input, requestId: randomUUID() }));
    const cancel = version(h.get(t)); h.store.tasks.cancelHandoff(t.id, cancel); assert.equal(h.store.tasks.cancelHandoff(t.id, cancel).replayed, true);
    h.finish(a.id); assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.store.admitNext(), undefined);
    assert.equal(h.store.detail(h.c.id).deliveries.find(d => d.sourceId === first.handoff.sourceId)?.status, 'withdrawn');
  } finally { h.owner.close(); }
});

for (const invalidation of ['target', 'source', 'original-source', 'fence'] as const) test(`N4: ${invalidation} invalidation prevents stale handoff from acquiring new owner`, () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(), result = h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Review' }, a.id);
    if (invalidation === 'target') h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, enabled: false });
    else if (invalidation === 'fence') { const task = h.get(t); task.executionRef!.fence = 'a-new-owner-fence'; h.owner.db.prepare('UPDATE cc_ordinary_tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id); }
    else { const source = h.store.detail(h.c.id).sources.find(s => s.id === (invalidation === 'source' ? result.handoff.sourceId : t.currentSourceId))!; source.content += ' changed without matching digest'; h.owner.db.prepare('UPDATE cc_sources SET value=? WHERE id=?').run(JSON.stringify(source), source.id); }
    h.finish(a.id); assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.store.tasks.handoffs(h.c.id)[0]!.state, 'refused'); assert.equal(h.store.admitNext(), undefined);
  } finally { h.owner.close(); }
});

test('N4: no-execution handoff applies immediately; busy target waits independently and owner is not a global lock', () => {
  const h = setup(); try {
    h.store.send(h.c.id, { content: '@claude unrelated work', requestId: randomUUID() }); const busy = h.run();
    const t = h.create(null); const result = h.store.tasks.handoff(t.id, { ...version(t), targetMemberId: 'claude', reason: 'Assign' });
    assert.equal(result.handoff.state, 'applied'); assert.equal(h.get(t).ownerMemberId, 'claude'); assert.equal(h.get(t).executionRef, undefined);
    const other = h.create(); const a = h.run(); assert.equal(h.get(other).executionRef?.invocationId, a.id);
    assert.equal(h.store.admitNext(), undefined); h.finish(busy.id); const b = h.run(); assert.equal(h.get(t).executionRef?.invocationId, b.id);
    h.finish(a.id); h.finish(b.id);
  } finally { h.owner.close(); }
});

for (const ending of ['done', 'frozen', 'degraded', 'abandoned'] as const) test(`N4: explicit ${ending} withdraws pending handoff without fabricating runtime release`, () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(); h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Transfer' });
    h.store.tasks.update(t.id, { ...version(h.get(t)), ...(ending === 'done' ? { status: ending } : { disposition: ending }), reason: 'Explicit end' });
    assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(h.get(t).executionRef?.invocationId, a.id); assert.equal(h.store.tasks.handoffs(h.c.id)[0]!.state, 'cancelled');
    assert.equal(h.store.tasks.projection(h.c.id)[0]!.state, 'resolved'); assert.throws(() => h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'doing' }, a.id));
    h.finish(a.id); assert.equal(h.store.admitNext(), undefined);
    h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'doing' }); const b = h.run(); assert.notEqual(b.id, a.id); h.finish(b.id);
  } finally { h.owner.close(); }
});

test('N4: projections are pure diagnostics, zombie never releases; failed task is dead, new messages remain active', () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(), events = h.store.events().length;
    assert.equal(h.store.tasks.projection(h.c.id, Date.now() + 360_000)[0]!.diagnostic, 'zombie'); assert.equal(h.store.events().length, events);
    assert.equal(h.get(t).executionRef?.invocationId, a.id); h.finish(a.id, 'Failed', 'failed'); assert.equal(h.store.tasks.projection(h.c.id)[0]!.diagnostic, 'dead');
    h.store.send(h.c.id, { content: '@claude New input', requestId: randomUUID() }); const b = h.run();
    assert.ok(h.store.tasks.projection(h.c.id).some(r => r.kind === 'message' && r.invocationId === b.id && r.state === 'active')); h.finish(b.id);
  } finally { h.owner.close(); }
});

test('N4: normalized exact recovery releases task execution even when raw exit events are unavailable', () => {
  const h = setup(); try {
    const t = h.create(), a = h.run(); h.store.finish(a.id, 'succeeded', 'Known result but missing exit');
    assert.ok(h.get(t).executionRef);
    const i = h.store.invocation(a.id);
    h.store.resolveRecovery(i.id, { requestId: randomUUID(), expectedInvocationRevision: i.invocationRevision!, expectedCancelRevision: i.cancelRevision!, expectedInputRevision: 1 }, {
      invocationId: i.id, carrier: i.member.carrier, state: 'settled', acceptance: 'accepted', teardown: 'confirmed', observedAt: new Date().toISOString(), reason: 'Normalized server adapter observation', evidence: [],
    });
    assert.equal(h.get(t).executionRef, undefined); assert.equal(h.get(t).status, 'todo');
    h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'doing' }); assert.ok(h.store.admitNext());
  } finally { h.owner.close(); }
});

test('N4: task callbacks cannot cross conversations or operate after member permission is revoked', () => {
  const h = setup(); try {
    const t = h.create(), a = h.run();
    const other = h.store.create({ title: 'Other', memberIds: ['codex'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
    const foreign = h.store.tasks.create(other.id, { requestId: randomUUID(), title: 'Foreign', description: '' }).task;
    assert.throws(() => h.store.tasks.update(foreign.id, { ...version(foreign), status: 'doing' }, a.id), /不属于/);
    assert.throws(() => h.store.updateConversation(h.c.id, { memberIds: ['claude'], defaultMemberId: 'claude' }), /pending or active/);
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'codex')!, enabled: false });
    assert.throws(() => h.store.tasks.update(t.id, { ...version(h.get(t)), status: 'done' }, a.id), /当前会话/);
    h.finish(a.id); assert.equal(h.get(t).status, 'todo');
  } finally { h.owner.close(); }
});

test('N4: source/owner/command/event mutations roll back together on storage failure', () => {
  const h = setup(); try {
    const t = h.create(null), before = h.store.detail(h.c.id);
    h.owner.db.exec("CREATE TRIGGER fail_task_owner BEFORE UPDATE ON cc_ordinary_tasks BEGIN SELECT RAISE(ABORT, 'injected task failure'); END");
    const input = { ...version(t), targetMemberId: 'claude', reason: 'Transfer' };
    assert.throws(() => h.store.tasks.handoff(t.id, input), /injected/); assert.deepEqual(h.store.detail(h.c.id), before); assert.equal(h.store.tasks.handoffs(h.c.id).length, 0);
    h.owner.db.exec('DROP TRIGGER fail_task_owner'); assert.equal(h.store.tasks.handoff(t.id, input).handoff.state, 'applied');
  } finally { h.owner.close(); }
});

test('N4: persisted handoff survives restart but unknown exit remains held, then exact evidence applies original source once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n4-restart-')); let owner: Store | undefined;
  try {
    const h = setup(join(dir, 'db')); owner = h.owner; const t = h.create(), a = h.run();
    const handoff = h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Continue after release' }); owner.close();
    owner = new Store(join(dir, 'db')); const store = new CollaborationStore(owner); store.recover(); store.tasks.reconcile();
    assert.equal(store.tasks.getTask(t.id).ownerMemberId, 'codex'); assert.equal(store.admitNext(), undefined);
    store.recordEvidence(a.id, { kind: 'process_exit', detail: { confirmed: true } }); store.tasks.reconcile();
    assert.equal(store.tasks.getTask(t.id).ownerMemberId, 'claude'); assert.equal(store.tasks.getTask(t.id).currentSourceId, handoff.handoff.sourceId);
    store.tasks.reconcile(); assert.equal(store.tasks.getTask(t.id).ownerRevision, 2);
    assert.equal(store.detail(h.c.id).sources.length, 2);
  } finally { owner?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N4: schema 3 upgrade preserves old contracts and does not fabricate tasks; old tool policy stays restricted', () => {
  const h = setup(); try {
    h.store.send(h.c.id, { content: 'old prepared', requestId: randomUUID() }); const i = h.store.admitNext()!.invocations[0]!;
    const c = h.store.contract(i.id); c.behaviorVersion = '0.4.0'; c.toolPolicyVersion = 'readonly-v1'; c.contextPolicyVersion = 'bounded-public-context-v1';
    h.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE id=?').run(JSON.stringify(c), c.id);
    h.owner.db.exec('DROP TABLE cc_task_handoffs; DROP TABLE cc_ordinary_tasks; UPDATE cc_schema SET version=3');
    const store = new CollaborationStore(h.owner); assert.deepEqual(store.contract(i.id), c); assert.deepEqual(store.tasks.list(h.c.id), []);
    assert.equal((h.owner.db.prepare('SELECT version FROM cc_schema').get() as any).version, 5);
    store.startInvocation(i.id); assert.throws(() => store.tasks.tool(i.id, 'task_list', {}, 'old-policy'));
  } finally { h.owner.close(); }
});

test('N4: engine recovers durable stop intent and hands off only after the cancelled adapter really exits', async () => {
  const h = setup(); const calls: RuntimeRequest[] = []; let release: (() => void) | undefined;
  const engine = new CollaborationEngine(h.store, { probe: async () => [], invoke: async r => {
    calls.push(r); r.onEvent({ kind: 'accepted', detail: {} });
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'Complete', continuity: 'fresh' };
  } }, { workspace: '/synthetic' });
  const until = async (fn: () => boolean) => { const end = Date.now() + 3000; while (!fn()) { if (Date.now() > end) throw new Error('Engine deadline'); await new Promise(r => setTimeout(r, 10)); } };
  try {
    const t = h.create(); engine.start(); await until(() => !!release);
    h.store.tasks.handoff(t.id, { ...version(h.get(t)), targetMemberId: 'claude', reason: 'Stop old work', stopCurrent: true }); engine.kick();
    assert.ok(calls[0]!.signal.aborted); assert.equal(h.get(t).ownerMemberId, 'codex'); assert.equal(calls.length, 1);
    release!(); await until(() => calls.length === 2 && !h.get(t).executionRef); assert.equal(h.get(t).ownerMemberId, 'claude'); assert.equal(h.get(t).status, 'todo');
  } finally { release?.(); await engine.stop(); h.owner.close(); }
});
