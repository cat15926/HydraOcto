import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { compareSources } from '../server/collaboration/cooperation.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import type { AppendObservation, CollaborationInvocation, InputHandoff, SourceWork } from '../shared/collaboration.js';

import type { Obligation } from '../shared/obligations.js';

const rid = () => randomUUID();
function setup(persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'n6-cooperation-'));
  let time = Date.now(), owner = new Store(persistent ? join(dir, 'test.sqlite') : ':memory:');
  let s = new CollaborationStore(owner, { artifactDir: join(dir, 'objects'), clock: () => time });
  s.saveMember({ ...s.members()[0]!, id: 'reviewer', name: 'Reviewer' });
  const c = s.create({ title: 'N6', memberIds: ['codex', 'claude', 'reviewer'], defaultMemberId: 'codex', requestId: rid() }).conversation;
  const send = (content: string, extra = {}) => s.send(c.id, { content, requestId: rid(), deliveryMode: 'next_turn', ...extra }).source;
  const admit = () => s.admitNext()!;
  const start = (i: CollaborationInvocation) => { s.startInvocation(i.id); s.recordEvidence(i.id, { kind: 'accepted', detail: {} }); s.recordEvidence(i.id, { kind: 'session', detail: { nativeSessionId: 'thread-' + i.id, nativeTurnId: 'turn-' + i.id } }); return s.invocation(i.id); };
  const run = (member = 'codex') => { send('@' + member + ' primary-' + rid()); return start(admit().invocations[0]!); };
  const end = (i: CollaborationInvocation, status: 'succeeded' | 'failed' = 'succeeded', text = 'Finished') => { s.recordEvidence(i.id, { kind: 'process_exit', detail: { confirmed: true } }); s.finish(i.id, status, text); };
  return { dir, c, send, admit, start, run, end, get s() { return s; }, get owner() { return owner; }, advance(ms: number) { time += ms; },
    restart() { owner.close(); owner = new Store(join(dir, 'test.sqlite')); s = new CollaborationStore(owner, { artifactDir: join(dir, 'objects'), clock: () => time }); s.recover(); s.cooperation.recover(); },
    close() { owner.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function observation(h: InputHandoff, state: AppendObservation['state']): AppendObservation { return { state, nativeSessionId: h.nativeSessionId, nativeTurnId: h.nativeTurnId, nativeDeliveryId: h.nativeDeliveryId, reason: 'exact synthetic observation', observedAt: new Date().toISOString() }; }

test('N6A: stable source sorting, queue CAS, priority and content revision independent from reorder', () => {
  const h = setup(); try {
    const a = h.send('@codex first'), b = h.send('@claude second'), q = h.s.cooperation.queue(h.c.id);
    h.s.cooperation.priority(b.id, { requestId: rid(), expectedRevision: q.revision, priority: 'urgent' });
    assert.equal(h.s.cooperation.queue(h.c.id).sources[0]!.id, b.id);
    assert.throws(() => h.s.cooperation.reorder(h.c.id, { requestId: rid(), expectedRevision: q.revision, sourceIds: [a.id, b.id] }));
    h.s.cooperation.reorder(h.c.id, { requestId: rid(), expectedRevision: h.s.cooperation.revision(h.c.id), sourceIds: [a.id, b.id] });
    assert.equal(h.admit().batch.sourceId, a.id); assert.equal(h.s.detail(h.c.id).sources[0]!.revision, a.revision);
    const sample = { ...a, enqueuedAt: '2026-01-01' };
    assert.ok(compareSources({ ...sample, id: 'a' }, { ...sample, id: 'b' }) < 0);
    assert.ok(compareSources({ ...sample, position: 3 }, { ...sample, priority: 'urgent' }) < 0);
  } finally { h.close(); }
});

test('N6A: unresolved targetless user source blocks later sources until idle and resolves exactly once', () => {
  const h = setup(); try {
    const i = h.run(), unbound = h.send('defer routing', { resolveWhenIdle: true }); h.send('@claude later');
    assert.equal(unbound.bindingState, 'unresolved'); assert.equal(h.admit(), undefined);
    h.end(i); const next = h.admit(); assert.equal(next.batch.sourceId, unbound.id);
    const bound = h.s.detail(h.c.id).sources.find(s => s.id === unbound.id)!;
    assert.equal(bound.bindingState, 'bound'); assert.equal(bound.revision, 2);
    assert.equal(h.s.cooperation.resolveUnbound(bound), false);
    assert.equal(h.s.detail(h.c.id).deliveries.filter(d => d.sourceId === bound.id).length, 1);
  } finally { h.close(); }
});

test('N6A: preflight backoff keeps exact prepared IDs, doubles to a cap, and restart removes only ephemeral delay', () => {
  const h = setup(true); try {
    h.send('@codex queued'); const i = h.admit().invocations[0]!;
    h.s.cooperation.defer(i); let b = h.s.cooperation.queue(h.c.id).backoffs[0]!;
    assert.equal(h.s.cooperation.canLaunch(i), false); h.advance(10000); assert.equal(h.s.cooperation.canLaunch(i), true);
    h.s.cooperation.defer(i); assert.equal(Date.parse(h.s.cooperation.queue(h.c.id).backoffs[0]!.until) - Date.parse(b.until), 20000);
    for (let n = 0; n < 20; n++) h.s.cooperation.defer(i);
    b = h.s.cooperation.queue(h.c.id).backoffs[0]!; assert.ok(b.attempts === 22);
    h.restart(); assert.equal(h.s.cooperation.canLaunch(h.s.invocation(i.id)), true); assert.equal(h.s.invocations().length, 1);
  } finally { h.close(); }
});

test('N6A: cancel-all exact fences clear per targeted new input, expire, and idempotent replay does not rearm', () => {
  const h = setup(true); try {
    const a = h.run(), b = h.run('claude'), id = rid(); const stopped = h.s.cooperation.cancelAll(h.c.id, id);
    assert.deepEqual(new Set(stopped.invocationIds), new Set([a.id, b.id]));
    assert.equal(h.s.cooperation.queue(h.c.id).suppressions.length, 2);
    h.send('@codex new work'); assert.equal(h.s.cooperation.suppressed(h.c.id, 'codex'), false); assert.equal(h.s.cooperation.suppressed(h.c.id, 'claude'), true);
    h.s.cooperation.cancelAll(h.c.id, id); assert.equal(h.s.cooperation.suppressed(h.c.id, 'codex'), false);
    h.advance(60000); assert.equal(h.s.cooperation.suppressed(h.c.id, 'claude'), false);
    assert.equal(h.admit(), undefined, 'TTL never proves that old processes exited');
    h.restart(); assert.equal(h.s.cooperation.queue(h.c.id).suppressions.length, 0); assert.equal(h.admit(), undefined);
  } finally { h.close(); }
});

test('N6A: exact same-content bounce to ancestor rejected; new work remains legal', () => {
  const h = setup(); try {
    const a = h.run(); h.s.requestCollaboration(a.id, 'a', { targets: ['claude'], content: 'same request' }); h.end(a);
    const b = h.start(h.admit().invocations[0]!);
    assert.throws(() => h.s.requestCollaboration(b.id, 'bounce', { targets: ['codex'], content: 'same request' }), /祖先/);
    assert.ok(h.s.requestCollaboration(b.id, 'new', { targets: ['codex'], content: 'new result requires a decision' }).sourceId);
  } finally { h.close(); }
});

test('N6B: first prompt full coverage consumes only this member and leaves sibling delivery pending', () => {
  const h = setup(); try {
    h.send('@codex primary'); const extra = h.send('@codex @claude second request'), i = h.admit().invocations[0]!;
    h.start(i); const d = h.s.detail(h.c.id), r = h.s.response(i.responseId);
    assert.ok(r.inputSourceIds.includes(extra.id)); assert.equal(r.inputRevision, 2);
    assert.equal(d.deliveries.find(x => x.sourceId === extra.id && x.memberId === 'codex')!.status, 'consumed');
    assert.equal(d.deliveries.find(x => x.sourceId === extra.id && x.memberId === 'claude')!.status, 'pending');
    const exposure = d.inputExposures![0]!; assert.equal(exposure.content, extra.content); assert.equal(exposure.kind, 'prompt');
    assert.ok(h.s.input(i.id)!.manifest.items.some(m => m.kind === 'request' && m.reference === 'source:' + extra.id + '@1'));
  } finally { h.close(); }
});

test('N6B: omitted background creates no consumption; exact tool reads remain scoped and versioned', () => {
  const h = setup(); try {
    h.send('@codex primary');
    const sources = Array.from({ length: 9 }, (_, n) => h.send('@codex ' + n + ' ' + 'x'.repeat(18000)));
    const i = h.start(h.admit().invocations[0]!), before = h.s.response(i.responseId);
    const available = h.s.cooperation.pending(i.id); assert.ok(available.length > 0);
    const omitted = sources.filter(s => !before.inputSourceIds.includes(s.id)); assert.equal(available.length, omitted.length);
    const target = available[0]!, sibling = h.send('@claude private target');
    assert.throws(() => h.s.cooperation.read(i.id, { sourceIds: [target.id, sibling.id] }, 'bad'));
    assert.deepEqual(h.s.response(i.responseId), before, 'rejected multi-read consumes nothing');
    const input = { sourceIds: [target.id] }, result = h.s.cooperation.read(i.id, input, 'read');
    assert.equal(result.inputRevision, before.inputRevision + 1); assert.equal(result.sources[0]!.content, target.content);
    h.s.cooperation.read(i.id, input, 'read'); assert.equal(h.s.response(i.responseId).inputRevision, result.inputRevision);
    assert.throws(() => h.s.cooperation.read(i.id, { sourceIds: [sibling.id] }, 'read'));
  } finally { h.close(); }
});

test('N6B: one failed response returns once to every accurately consumed caller and respects input CAS', () => {
  const h = setup(); try {
    const a = h.run(), b = h.run('reviewer');
    h.s.requestCollaboration(a.id, 'one', { targets: ['claude'], content: 'A request' });
    const child = h.start(h.admit().invocations[0]!);
    const extra = h.s.requestCollaboration(b.id, 'two', { targets: ['claude', 'codex'], content: 'B request' });
    const original = h.s.response(child.responseId).inputRevision;
    h.s.cooperation.read(child.id, { sourceIds: [extra.sourceId] }, 'read');
    assert.throws(() => h.s.finish(child.id, 'failed', 'failed', original));
    assert.equal(h.s.invocation(child.id).status, 'running');
    h.end(child, 'failed', 'both inputs failed'); h.s.finish(child.id, 'failed', 'both inputs failed');
    const d = h.s.detail(h.c.id), failures = d.sources.filter(s => s.kind === 'a2a_failure');
    assert.equal(failures.length, 1); assert.deepEqual(new Set(failures[0]!.requestedTargets), new Set(['codex', 'reviewer']));
    assert.equal(d.deliveries.find(d => d.sourceId === extra.sourceId && d.memberId === 'codex')!.status, 'pending');
  } finally { h.close(); }
});

test('N6B: exact receipt repairs an unretired delivery without admitting a duplicate run', () => {
  const h = setup(); try {
    const i = h.run(); h.end(i); const d = h.s.detail(h.c.id).deliveries[0]!;
    d.status = 'pending'; delete d.responseId;
    h.owner.db.prepare('UPDATE cc_deliveries SET status=?,response_id=NULL,value=? WHERE id=?').run('pending', JSON.stringify(d), d.id);
    assert.equal(h.admit(), undefined); assert.equal(h.s.invocations().length, 1); assert.equal(h.s.detail(h.c.id).deliveries[0]!.status, 'consumed');
  } finally { h.close(); }
});

test('N6B: additional generic inputs retain primary task authority; task/review/group inputs never merge', () => {
  const h = setup(); try {
    const task = h.s.tasks.create(h.c.id, { requestId: rid(), title: 'owned', description: '', ownerMemberId: 'codex' }).task;
    const extra = h.send('@codex supplemental requirement');
    const i = h.start(h.admit().invocations[0]!);
    assert.ok(h.s.response(i.responseId).inputSourceIds.includes(extra.id));
    let current = h.s.tasks.getTask(task.id); assert.equal(current.executionRef?.inputRevision, h.s.response(i.responseId).inputRevision);
    const pendingTask = h.s.tasks.create(h.c.id, { requestId: rid(), title: 'separate', description: '', ownerMemberId: 'codex' }).task;
    const group = h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['codex', 'claude'], question: 'distinct group' }).group;
    assert.ok(!h.s.cooperation.pending(i.id).some(s => s.taskRef || s.groupId || s.reviewRef));
    assert.throws(() => h.s.cooperation.read(i.id, { sourceIds: [group.sourceId] }, 'forbidden'));
    current = h.s.tasks.getTask(task.id);
    h.s.tasks.update(task.id, { requestId: rid(), expectedRevision: current.revision, expectedOwnerRevision: current.ownerRevision, status: 'done' }, i.id);
    assert.equal(h.s.tasks.getTask(task.id).status, 'done'); assert.equal(h.s.tasks.getTask(pendingTask.id).status, 'todo');
  } finally { h.close(); }
});

test('N6B: new policy exposes 16 tools while old frozen policies remain unchanged', () => {
  assert.equal(runtimeTools({ toolPolicyVersion: 'cooperation-v2' }).length, 16);
  assert.equal(runtimeTools({ toolPolicyVersion: 'managed-artifacts-v1' }).length, 13);
  assert.equal(runtimeTools({ toolPolicyVersion: 'readonly-tasks-v1' }).length, 7);
});

test('N6B: sorted source selection governs prompt and tool coverage, independently of history or argument order', () => {
  for (const method of ['prompt', 'tool'] as const) {
    const h = setup(); try {
      h.send('@codex first'); const active = method === 'tool' ? h.start(h.admit().invocations[0]!) : undefined;
      const second = h.send('@codex second'), third = h.send('@codex third');
      const q = h.s.cooperation.queue(h.c.id), ids = q.sources.map(s => s.id);
      h.s.cooperation.reorder(h.c.id, { requestId: rid(), expectedRevision: q.revision, sourceIds: method === 'prompt' ? [ids[0], third.id, second.id] : [third.id, second.id] });
      const i = active ?? h.start(h.admit().invocations[0]!);
      if (method === 'tool') assert.deepEqual(h.s.cooperation.read(i.id, { sourceIds: [second.id, third.id] }, 'read').sources.map(s => s.id), [third.id, second.id]);
      assert.deepEqual(h.s.cooperation.exposures(h.c.id).map(e => e.sourceId), [third.id, second.id]);
    } finally { h.close(); }
  }
});

test('N6C: accepted append preserves acceptance but late reads after cancellation or binding drift remain audit-only', () => {
  for (const change of ['cancel', 'withdraw', 'input', 'member', 'ended'] as const) {
    const h = setup(); try {
      const i = h.run(), s = h.send('@codex append', { deliveryMode: 'continue_current' }), x = h.s.cooperation.prepareAppend(new Set([i.id]))!;
      h.s.cooperation.appendResult(x.id, observation(x, 'accepted'));
      if (change === 'cancel') h.s.cancel(i.id);
      if (change === 'withdraw') h.s.cooperation.withdraw(s.id, { requestId: rid(), expectedRevision: s.revision });
      if (change === 'input') { const r = h.s.response(i.responseId); r.inputRevision++; h.owner.db.prepare('UPDATE cc_responses SET value=? WHERE id=?').run(JSON.stringify(r), r.id); }
      if (change === 'member') h.s.saveMember({ ...i.member, enabled: false });
      if (change === 'ended') h.end(i);
      const result = h.s.cooperation.appendResult(x.id, observation(x, 'read'));
      assert.equal(result.state, 'accepted'); assert.equal(result.evidence!.at(-1)!.state, 'read'); assert.match(result.reason!, /仅保留审计/);
      assert.equal(h.s.detail(h.c.id).consumptions.filter(c => c.sourceId === s.id).length, 1);
    } finally { h.close(); }
  }
});

test('N6A: recovered preflight retries same prepared invocation once and clears transient backoff after launch', async () => {
  const h = setup(); let probes = 0, calls = 0, codexProbes = 0;
  const engine = new CollaborationEngine(h.s, { probe: async () => [], sessionIdentity: async input => { probes++; if (input.member.id === 'codex' && ++codexProbes === 1) throw new Error('temporary'); return { supported: false, reason: 'synthetic' }; }, invoke: async r => { calls++; r.onEvent({ kind: 'accepted', detail: {} }); r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: 'done', continuity: 'fresh' }; } }, { workspace: h.dir });
  const until = async (f: () => boolean) => { const deadline = Date.now() + 2000; while (!f()) { if (Date.now() > deadline) throw new Error('Engine test timeout'); await new Promise(r => setTimeout(r, 5)); } };
  try {
    h.send('@codex @claude once'); engine.start(); await until(() => h.s.invocations().some(i => i.memberId === 'claude' && i.status === 'succeeded'));
    assert.equal(h.s.cooperation.queue(h.c.id).backoffs.length, 1, 'A successful sibling must not clear the failing member preflight delay');
    const original = h.s.invocations().find(i => i.memberId === 'codex')!.id; h.advance(10000); engine.kick(); await until(() => h.s.invocation(original).status === 'succeeded');
    assert.equal(calls, 2); assert.equal(probes, 3); assert.equal(h.s.invocations().length, 2); assert.equal(h.s.cooperation.queue(h.c.id).backoffs.length, 0);
  } finally { await engine.stop(); h.close(); }
});

test('N6B: reordered unresolved barrier also blocks optional prompt coverage from a previously frozen history', () => {
  const h = setup(); try {
    h.send('@codex primary'); const extra = h.send('@codex full background'), i = h.admit().invocations[0]!;
    const unbound = h.send('bind only when idle', { resolveWhenIdle: true });
    h.s.cooperation.reorder(h.c.id, { requestId: rid(), expectedRevision: h.s.cooperation.revision(h.c.id), sourceIds: [unbound.id, extra.id] });
    h.start(i);
    assert.equal(h.s.response(i.responseId).inputSourceIds.includes(extra.id), false);
    assert.deepEqual(h.s.cooperation.pending(i.id), []);
  } finally { h.close(); }
});

test('N6C: unknown append cannot be invalidated by a competing tool-read input revision', () => {
  const h = setup(); try {
    const i = h.run(); h.send('@codex append', { deliveryMode: 'continue_current' });
    const x = h.s.cooperation.prepareAppend(new Set([i.id]))!;
    h.s.cooperation.appendResult(x.id, observation(x, 'unknown'));
    const extra = h.send('@codex ordinary next turn');
    assert.throws(() => h.s.cooperation.read(i.id, { sourceIds: [extra.id] }, 'competing'));
    h.s.cooperation.appendResult(x.id, observation(x, 'read'));
    h.s.cooperation.read(i.id, { sourceIds: [extra.id] }, 'after-resolution');
    assert.equal(h.s.response(i.responseId).inputRevision, 3);
  } finally { h.close(); }
});

test('N6C: exact accepted then read retires original target once without completing business work', () => {
  const h = setup(); try {
    const i = h.run(), s = h.send('@codex continue', { deliveryMode: 'continue_current' });
    const x = h.s.cooperation.prepareAppend(new Set([i.id]))!;
    assert.equal(x.sourceId, s.id); assert.equal(x.requiresCompletion, false);
    assert.equal(h.s.detail(h.c.id).deliveries.find(d => d.sourceId === s.id)!.status, 'held');
    assert.throws(() => h.s.cooperation.appendResult(x.id, { ...observation(x, 'accepted'), nativeTurnId: 'foreign' }));
    h.s.cooperation.appendResult(x.id, observation(x, 'accepted')); h.s.cooperation.appendResult(x.id, observation(x, 'read'));
    h.s.cooperation.appendResult(x.id, observation(x, 'accepted'));
    assert.equal(h.s.cooperation.handoffs()[0]!.state, 'read'); assert.equal(h.s.invocation(i.id).status, 'running');
    assert.equal(h.s.response(i.responseId).inputRevision, 2);
    assert.equal(h.s.detail(h.c.id).consumptions.filter(c => c.sourceId === s.id).length, 1);
    assert.equal(h.s.cooperation.prepareAppend(new Set([i.id])), undefined);
  } finally { h.close(); }
});

test('N6C: unknown stays held across restart, no retry or generic recheck; read-before-ACK consumes once', () => {
  for (const state of ['unknown', 'read'] as const) {
    const h = setup(true); try {
      const i = h.run(), s = h.send('@codex added', { deliveryMode: 'continue_current' }), x = h.s.cooperation.prepareAppend(new Set([i.id]))!;
      h.s.cooperation.appendResult(x.id, observation(x, state));
      if (state === 'read') { h.s.cooperation.appendResult(x.id, observation(x, 'accepted')); assert.equal(h.s.response(i.responseId).inputRevision, 2); }
      else { const d = h.s.detail(h.c.id).deliveries.find(d => d.sourceId === s.id)!; assert.throws(() => h.s.recheckDelivery(d.id, { requestId: rid(), expectedDeliveryRevision: d.revision, expectedSourceRevision: 1 })); }
      h.restart(); assert.equal(h.s.cooperation.prepareAppend(new Set([i.id])), undefined);
      assert.equal(h.s.cooperation.handoffs()[0]!.state, state); assert.equal(h.s.invocations().length, 1);
    } finally { h.close(); }
  }
});

test('N6C: explicit rejection can queue again; cancellation and source drift make late receipt audit-only', () => {
  for (const state of ['not_accepted', 'cancel', 'withdraw', 'input', 'disabled'] as const) {
    const h = setup(); try {
      const i = h.run(), s = h.send('@codex added', { deliveryMode: 'continue_current' }), x = h.s.cooperation.prepareAppend(new Set([i.id]))!;
      if (state === 'cancel') h.s.cancel(i.id);
      if (state === 'withdraw') h.s.cooperation.withdraw(s.id, { requestId: rid(), expectedRevision: s.revision });
      if (state === 'input') { const r = h.s.response(i.responseId); r.inputRevision++; h.owner.db.prepare('UPDATE cc_responses SET value=? WHERE id=?').run(JSON.stringify(r), r.id); }
      if (state === 'disabled') h.s.saveMember({ ...i.member, enabled: false });
      h.s.cooperation.appendResult(x.id, observation(x, state === 'not_accepted' ? state : 'accepted'));
      const d = h.s.detail(h.c.id).deliveries.find(d => d.sourceId === s.id)!;
      assert.equal(h.s.cooperation.handoffs()[0]!.state, state === 'not_accepted' ? state : 'unknown');
      assert.equal(d.status, state === 'not_accepted' ? 'pending' : state === 'withdraw' ? 'withdrawn' : 'held');
      assert.equal(h.s.response(i.responseId).inputSourceIds.includes(s.id), false);
    } finally { h.close(); }
  }
});

test('N6C: preparing exact parent waits; finished parent never rebinds to later run; unsupported Claude queues', () => {
  const h = setup(); try {
    h.send('@codex initial'); const i = h.admit().invocations[0]!;
    const s = h.send('@codex additional', { deliveryMode: 'continue_current' });
    assert.equal(h.s.cooperation.prepareAppend(new Set()), undefined);
    assert.equal(h.s.detail(h.c.id).deliveries.find(d => d.sourceId === s.id)!.continuation?.invocationId, i.id);
    h.start(i); h.end(i); assert.equal(h.s.cooperation.prepareAppend(new Set()), undefined);
    const next = h.admit().invocations[0]!; assert.notEqual(next.id, i.id); assert.equal(h.s.cooperation.handoffs().length, 0);
    const claude = h.run('claude'), extra = h.send('@claude while running', { deliveryMode: 'continue_current' });
    const delivery = h.s.detail(h.c.id).deliveries.find(d => d.sourceId === extra.id)!;
    assert.equal(delivery.continuation?.fallback, true); assert.equal(delivery.continuation?.invocationId, claude.id);
  } finally { h.close(); }
});

test('N6D: all results, including failure, publish one ordinary summary with no caller wake or mention routing', () => {
  const h = setup(); try {
    const g = h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['codex', 'claude'], question: 'compare options' }).group;
    const runs = h.admit().invocations; assert.equal(runs.length, 2);
    for (const i of runs) h.start(i);
    h.end(runs[0]!, 'failed', 'dispatch-error'); h.s.cooperation.groupTick(); assert.equal(h.s.cooperation.groups()[0]!.state, 'collecting');
    h.end(runs[1]!, 'succeeded', '@reviewer answer'); h.s.cooperation.groupTick(); h.s.cooperation.groupTick();
    const d = h.s.detail(h.c.id); assert.equal(d.groups![0]!.state, 'done'); assert.equal(d.groups![0]!.results!.length, 2);
    assert.equal(d.sources.length, 1); assert.equal(d.sources[0]!.id, g.sourceId); assert.equal(d.messages.filter(m => m.author === 'system' && m.content.startsWith('多人征询结果')).length, 1);
    assert.equal(h.admit(), undefined);
  } finally { h.close(); }
});

test('N6D: active participant anti-cascade, timeout no partial summary, late result cannot reopen', () => {
  const h = setup(); try {
    h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['codex', 'claude'], question: 'deadline', timeoutMs: 1000 });
    const runs = h.admit().invocations; runs.forEach(h.start);
    assert.throws(() => h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['claude', 'reviewer'], question: 'cascade' }, runs[0]!.id));
    h.end(runs[0]!); h.s.cooperation.groupTick(); h.advance(1000); h.s.cooperation.groupTick();
    assert.equal(h.s.cooperation.groups()[0]!.state, 'timeout'); assert.equal(h.s.cooperation.groups()[0]!.results!.length, 1);
    h.end(runs[1]!); h.s.cooperation.groupTick(); assert.equal(h.s.cooperation.groups()[0]!.state, 'timeout');
    assert.equal(h.s.detail(h.c.id).messages.filter(m => m.author === 'system').length, 0);
  } finally { h.close(); }
});

test('N6D: restart loses collector without dropping pending targets; cancellation affects only group executions', () => {
  const h = setup(true); try {
    const unrelated = h.run('reviewer');
    const g = h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['codex', 'claude'], question: 'restart' }).group;
    h.restart(); assert.equal(h.s.cooperation.groups()[0]!.state, 'lost');
    assert.equal(h.s.detail(h.c.id).deliveries.filter(d => d.sourceId === g.sourceId && d.status === 'pending').length, 2);
    const g2 = h.s.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['codex', 'claude'], question: 'cancel' }).group;
    h.s.cooperation.cancelGroup(g2.id, { requestId: rid(), expectedRevision: g2.revision });
    assert.equal(h.s.detail(h.c.id).deliveries.filter(d => d.sourceId === g2.sourceId && d.status === 'withdrawn').length, 2);
    assert.equal(h.s.invocation(unrelated.id).cancelRevision, 0);
    assert.equal(h.admit().batch.sourceId, g.sourceId);
  } finally { h.close(); }
});


function collection(h: ReturnType<typeof setup>) {
  const host = h.run();
  const {obligation} = h.s.obligations.tool(host.id,'obligation_open',{goal:'收集成员意见，最后交付'},rid()) as {obligation:Obligation};
  const input = {targets:['reviewer','claude'],question:'分别提交意见',timeoutMs:2000,obligationId:obligation.id,requestId:rid()};
  const first = h.s.cooperation.createGroup(h.c.id,input,host.id);
  assert.equal(h.s.cooperation.createGroup(h.c.id,input,host.id).group.id,first.group.id);
  assert.throws(()=>h.s.cooperation.createGroup(h.c.id,{...input,requestId:rid()}));
  h.end(host);
  const runs = h.admit().invocations.map(h.start);
  const read = () => h.s.cooperation.groups(h.c.id).find(g => g.id === first.group.id)!;
  const root = () => h.s.obligations.list(h.c.id).find(o => o.id === obligation.id)!;
  return {host,group:first.group,runs,read,root};
}

test('durable collection recovers completed receipts at restart and returns failures and opinions exactly once', () => {
  const h = setup(true);
  try {
    const {group,runs,root,read} = collection(h);
    h.end(runs[0]!,'failed','资料不可用');
    assert.equal(read().results?.length,1);
    assert.equal(root().state,'waiting');
    h.end(runs[1]!,'succeeded','我建议方案二。');
    assert.equal(read().state,'collecting');
    assert.equal(read().results?.length,2);
    h.advance(3000);
    h.restart();
    h.s.cooperation.groupTick();
    assert.equal(read().state,'done');
    const wake = h.s.detail(h.c.id).sources.find(s => s.id === read().contract?.wakeSourceId)!;
    assert.equal(wake.id,root().currentSourceId);
    assert.match(wake.content,/执行失败/);
    assert.match(wake.content,/方案二/);
    assert.equal(h.s.detail(h.c.id).sources.filter(s=>s.kind==='job_result' || s.kind==='a2a_failure').length,1);
    const author = h.start(h.admit().invocations[0]!);
    const next = h.s.cooperation.createGroup(h.c.id,{requestId:rid(),targets:group.targets,question:'核实第二项资料',obligationId:root().id},author.id).group;
    h.s.cooperation.observeGroupFinish(h.s.artifacts.get('cc_sources',group.sourceId),h.s.invocation(runs[0]!.id));
    assert.deepEqual(next.results,[]);
    assert.equal(root().activeGroupId,next.id);
    h.s.cooperation.groupTick();
    assert.equal(h.s.cooperation.groups(h.c.id).find(g => g.id===next.id)?.state,'collecting');
  } finally {h.close();}
});

test('timed out durable collection returns partial evidence once and cannot accept a late reply', () => {
  const h = setup();
  try {
    const {runs,root,read} = collection(h);
    h.end(runs[0]!); h.advance(2000); h.end(runs[1]!);
    h.s.cooperation.groupTick();
    assert.equal(read().state,'timeout');
    assert.deepEqual(read().missing,[runs[1]!.memberId]);
    assert.equal(read().results?.length,1);
    h.s.cooperation.groupTick();
    const wake = h.s.detail(h.c.id).sources.filter(s=>s.kind==='job_result');
    assert.equal(wake.length,1);
    assert.match(wake[0]!.content,/已到期/); assert.equal(root().state,'open');
  } finally {h.close();}
});

test('cancelling the root closes its active collection; cancelling just the collection exposes the outstanding root',async() => {
  for (const cancelRoot of [true,false]) {
    const h=setup();
    try {
      const {root,read} = collection(h);
      if (cancelRoot) await h.s.obligations.decide(h.c.id,root().id,{requestId:rid(),expectedRevision:root().revision,decision:'cancel'});
      else h.s.cooperation.cancelGroup(read().id,{requestId:rid(),expectedRevision:read().revision});
      h.s.cooperation.groupTick(); h.s.obligations.reconcile();
      assert.equal(read().state,'cancelled');
      assert.equal(root().state,cancelRoot?'cancelled':'blocked');
      assert.equal(root().activeGroupId,undefined);
      assert.equal(h.s.detail(h.c.id).sources.filter(s=>s.kind==='job_result').length,0);
    } finally {h.close();}
  }
});


test('a retired participant cannot return through a replacement instance or wake the host', () => {
  const h=setup();
  try {
    const {root,read,runs}=collection(h);
    h.end(runs.find(i=>i.memberId==='claude')!);
    h.s.updateConversation(h.c.id,{memberIds:['codex','reviewer'],defaultMemberId:'codex'});
    h.s.updateConversation(h.c.id,{memberIds:['codex','claude','reviewer'],defaultMemberId:'codex'});
    h.s.cooperation.groupTick();
    assert.equal(read().state,'lost'); assert.equal(root().state,'blocked');
    assert.equal(root().activeGroupId,undefined);
    assert.equal(h.s.detail(h.c.id).sources.filter(s=>s.kind==='job_result').length,0);
  } finally {h.close();}
});

test('sustained collection stops at its per-obligation budget until a user explicitly reopens it', async() => {
  const h=setup();
  try {
    let host=h.run();
    const {obligation} = h.s.obligations.tool(host.id,'obligation_open',{goal:'收集资料后交付'},rid()) as {obligation:Obligation};
    const input={question:'对照证据',targets:['claude','reviewer'],obligationId:obligation.id};
    for (let n=0;n<16;n++) {
      h.s.cooperation.createGroup(h.c.id,{...input,requestId:rid()},host.id);
      h.end(host);
      for (const participant of h.admit().invocations) h.end(h.start(participant));
      h.s.cooperation.groupTick();
      host=h.start(h.admit().invocations[0]!);
    }
    const exhausted={...input,requestId:rid()};
    for(let replay=0;replay<2;replay++) assert.throws(()=>h.s.cooperation.createGroup(h.c.id,exhausted,host.id),/16 次/);
    const [root]=h.s.obligations.list(h.c.id);
    assert.equal(root!.state,'blocked'); assert.match(root!.reason!,/16 次/);
    assert.equal(h.s.cooperation.groups(h.c.id).length,16);
    assert.equal(h.s.detail(h.c.id).sources.filter(s=>s.kind==='job_result').length,16);
    h.end(host);
    await h.s.obligations.decide(h.c.id,root!.id,{requestId:rid(),decision:'retry',expectedRevision:root!.revision});
    const next=h.start(h.admit().invocations[0]!);
    const renewed=h.s.cooperation.createGroup(h.c.id,{...input,requestId:rid()},next.id);
    assert.equal(h.s.obligations.list(h.c.id)[0]!.groupCount,1);
    assert.equal(renewed.group.state,'collecting');
  } finally {h.close();}
});


test('late provider teardown before the deadline seals the result even if the next scheduler tick runs after restart', () => {
  const h=setup(true);
  try {
    const {runs,read} = collection(h);
    const [first,second]=runs;
    h.s.finish(first!.id,'succeeded','等待承载退出');
    assert.equal(read().results!.length,0);
    h.end(second!);
    h.s.recordEvidence(first!.id,{kind:'process_exit',detail:{confirmed:true}});
    assert.equal(read().results!.length,2);
    h.advance(3000); h.restart();
    assert.equal(read().state,'done');
    assert(read().contract?.wakeSourceId);
  } finally {h.close();}
});
