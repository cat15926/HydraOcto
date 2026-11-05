import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RecoveryRequest, RuntimeInspection } from '../shared/collaboration.js';
import { AppError, Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';

function setup(path = ':memory:') {
  const owner = new Store(path), store = new CollaborationStore(owner, { workspace: tmpdir() });
  const conversation = store.create({ title: '恢复专项测试', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
  return { owner, store, conversation };
}
function running(store: CollaborationStore, conversationId: string, content = '@codex 开始任务') {
  store.send(conversationId, { content, requestId: randomUUID() });
  const admitted = store.admitNext()!;
  assert.ok(admitted); assert.equal(admitted.invocations.length, 1);
  const id = admitted.invocations[0]!.id; store.startInvocation(id);
  accepted(store, id); return id;
}
function accepted(store: CollaborationStore, id: string) {
  store.recordEvidence(id, { kind: 'session', detail: { nativeSessionId: `session-${id}`, nativeTurnId: `turn-${id}`, continuity: 'fresh' } });
  store.recordEvidence(id, { kind: 'accepted', detail: { nativeSessionId: `session-${id}`, nativeTurnId: `turn-${id}`, evidence: 'controlled-native-fixture' } });
}
function recoveryRequest(store: CollaborationStore, id: string, requestId = randomUUID()): RecoveryRequest {
  const i = store.invocation(id);
  return { requestId, expectedInvocationRevision: i.invocationRevision!, expectedCancelRevision: i.cancelRevision!, expectedInputRevision: store.response(i.responseId).inputRevision };
}
function observation(store: CollaborationStore, id: string, resultStatus: 'succeeded' | 'failed' = 'succeeded'): RuntimeInspection {
  const i = store.invocation(id);
  return { invocationId: id, carrier: i.member.carrier, nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId,
    state: 'settled', acceptance: 'accepted', teardown: 'confirmed', result: { status: resultStatus, content: resultStatus === 'succeeded' ? '准确核查的成功结果。' : '准确核查的失败结果。' },
    reason: '受控准确终态及退出回执。', observedAt: new Date().toISOString(), evidence: [{ kind: 'process_exit', detail: { code: resultStatus === 'succeeded' ? 0 : 1, confirmed: true, transport: 'stdio' } }],
  };
}
function code(expected: string) { return (error: unknown) => error instanceof AppError && error.code === expected; }

test('N2: real store restart resolves a service interruption once, retains old result audit and normal finish fencing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-recovery-store-'));
  const path = join(dir, 'db.sqlite'); const h = setup(path);
  let owner = h.owner, store = h.store;
  try {
    const id = running(store, h.conversation.id);
    owner.close(); owner = new Store(path); store = new CollaborationStore(owner, { workspace: tmpdir() });
    store.recover();
    const interrupted = store.invocation(id);
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.interruptionCause, 'service_restart');
    const before = store.detail(h.conversation.id), oldResult = store.response(interrupted.responseId).content;
    const originalMessage = before.messages.find(m => m.responseId === interrupted.responseId)!;
    assert.throws(() => store.finish(id, 'succeeded', '不得通过普通 finish 覆盖'), code('terminal_conflict'));
    const input = recoveryRequest(store, id);
    assert.equal(store.recoveryReplay(id, input), undefined);
    const first = store.resolveRecovery(id, input, observation(store, id));
    assert.equal(first.check.resolution, 'resolved'); assert.equal(first.invocation.status, 'succeeded');
    assert.equal(first.invocation.recoveryState, 'resolved'); assert.equal(first.invocation.teardown, 'confirmed');
    const after = store.detail(h.conversation.id);
    assert.equal(after.sources.length, before.sources.length, 'Ordinary success must not wake a caller.');
    assert.equal(after.messages.length, before.messages.length, 'Replace the existing recovery-visible response, do not duplicate it.');
    assert.equal(after.messages.find(m => m.responseId === interrupted.responseId)!.id, originalMessage.id);
    assert.equal(after.responses.find(r => r.id === interrupted.responseId)!.content, '准确核查的成功结果。');
    const audit = after.events.filter(e => e.type === 'recovery.previous_result');
    assert.equal(audit.length, 1); assert.equal(audit[0]!.data.content, oldResult);
    assert.equal(after.recoveryChecks?.length, 1);
    const replay = store.recoveryReplay(id, input)!;
    assert.equal(replay.replayed, true); assert.equal(replay.check.id, first.check.id);
    assert.equal(store.resolveRecovery(id, input, { ...observation(store, id), result: { status: 'failed', content: '后续冲突观察' } }).check.id, first.check.id);
    assert.deepEqual(store.detail(h.conversation.id), after);
    assert.throws(() => store.recoveryReplay(id, { ...input, expectedInvocationRevision: input.expectedInvocationRevision + 1 }), code('idempotency_conflict'));
    assert.throws(() => store.finish(id, 'failed', '后来的失败'), code('terminal_conflict'));
  } finally { owner.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N2: user cancellation and legacy unknown interruptions are never rewritten by late success', () => {
  for (const mode of ['cancel', 'legacy'] as const) {
    const h = setup();
    try {
      const id = running(h.store, h.conversation.id);
      if (mode === 'cancel') h.store.cancel(id);
      h.store.recover();
      if (mode === 'legacy') {
        const i = h.store.invocation(id); i.interruptionCause = 'legacy_unknown';
        h.owner.db.prepare('UPDATE cc_invocations SET value=? WHERE id=?').run(JSON.stringify(i), id);
      }
      const prior = h.store.invocation(id), priorContent = h.store.response(prior.responseId).content;
      const result = h.store.resolveRecovery(id, recoveryRequest(h.store, id), observation(h.store, id));
      assert.equal(result.invocation.status, 'interrupted'); assert.equal(result.invocation.interruptionCause, mode === 'cancel' ? 'user_cancel' : 'legacy_unknown');
      assert.equal(result.check.resolution, 'closed_result_unknown'); assert.equal(result.invocation.teardown, 'confirmed');
      assert.equal(h.store.response(prior.responseId).content, priorContent);
      assert.equal(h.store.detail(h.conversation.id).events.filter(e => e.type === 'recovery.previous_result').length, 0);
    } finally { h.owner.close(); }
  }
});

test('N2: recovery version, native identity and incomplete strong-identity evidence are fenced before mutation', () => {
  const h = setup();
  try {
    const id = running(h.store, h.conversation.id); h.store.recover();
    const input = recoveryRequest(h.store, id), valid = observation(h.store, id), before = h.store.detail(h.conversation.id);
    for (const field of ['expectedInvocationRevision', 'expectedCancelRevision', 'expectedInputRevision'] as const) {
      assert.throws(() => h.store.resolveRecovery(id, { ...input, requestId: randomUUID(), [field]: input[field] + 1 }, valid), code('recovery_version_conflict'));
    }
    for (const invalid of [
      { ...valid, invocationId: 'another-invocation' },
      { ...valid, carrier: 'claude-cli' as const },
      { ...valid, nativeSessionId: 'another-session' },
      { ...valid, nativeTurnId: 'another-turn' },
      { ...valid, nativeSessionId: undefined },
      { ...valid, nativeTurnId: undefined },
    ]) assert.throws(() => h.store.resolveRecovery(id, { ...input, requestId: randomUUID() }, invalid), code('recovery_identity_conflict'));
    assert.deepEqual(h.store.detail(h.conversation.id), before);
  } finally { h.owner.close(); }
});

test('N2: exact recovered A2A failure and control source commit atomically and do not repeat', () => {
  const h = setup();
  try {
    const callerId = running(h.store, h.conversation.id);
    h.store.requestCollaboration(callerId, 'review-call', { targets: ['claude'], content: '请复核准确材料。' });
    h.store.recordEvidence(callerId, { kind: 'process_exit', detail: { code: 0, confirmed: true } });
    h.store.finish(callerId, 'succeeded', '已提交复核请求。');
    const childId = h.store.admitNext()!.invocations[0]!.id; h.store.startInvocation(childId); accepted(h.store, childId);
    h.store.recover();
    const input = recoveryRequest(h.store, childId), failed = observation(h.store, childId, 'failed'), before = h.store.detail(h.conversation.id);
    h.owner.db.exec("CREATE TRIGGER recovery_fail_control BEFORE INSERT ON cc_sources WHEN json_extract(NEW.value,'$.kind')='a2a_failure' BEGIN SELECT RAISE(ABORT,'controlled recovery rollback'); END");
    assert.throws(() => h.store.resolveRecovery(childId, input, failed), /controlled recovery rollback/);
    assert.deepEqual(h.store.detail(h.conversation.id), before, 'Failure must roll back status, result, evidence, check, audit and control source together.');
    assert.equal(h.store.recoveryReplay(childId, input), undefined);
    h.owner.db.exec('DROP TRIGGER recovery_fail_control');
    const first = h.store.resolveRecovery(childId, input, failed);
    assert.equal(first.check.resolution, 'resolved'); assert.equal(first.invocation.status, 'failed');
    const detail = h.store.detail(h.conversation.id), control = detail.sources.filter(s => s.kind === 'a2a_failure');
    assert.equal(control.length, 1); assert.deepEqual(control[0]!.requestedTargets, ['codex']);
    assert.equal(detail.recoveryChecks?.length, 1); assert.equal(detail.events.filter(e => e.type === 'recovery.previous_result').length, 1);
    assert.equal(h.store.resolveRecovery(childId, input, failed).replayed, true);
    const newer = h.store.resolveRecovery(childId, recoveryRequest(h.store, childId), failed);
    assert.equal(newer.check.resolution, 'already_settled');
    assert.equal(h.store.detail(h.conversation.id).sources.filter(s => s.kind === 'a2a_failure').length, 1);
  } finally { h.owner.close(); }
});

test('N2: unsupported inspection preserves an unknown execution and does not create a new invocation', () => {
  const h = setup();
  try {
    const id = running(h.store, h.conversation.id); h.store.recover();
    h.store.send(h.conversation.id, { content: '@codex 排队中的新工作', requestId: randomUUID() });
    const input = recoveryRequest(h.store, id);
    const check: RuntimeInspection = { invocationId: id, carrier: 'codex-app-server', state: 'unsupported', acceptance: 'unknown', teardown: 'unknown', reason: '本进程没有观察记录。', observedAt: new Date().toISOString(), evidence: [] };
    const result = h.store.resolveRecovery(id, input, check);
    assert.equal(result.check.resolution, 'unresolved'); assert.equal(result.invocation.status, 'interrupted'); assert.equal(result.invocation.teardown, 'unknown');
    assert.equal(h.store.admitNext(), undefined);
    assert.equal(h.store.invocations(h.conversation.id).length, 1);
    assert.equal(h.store.detail(h.conversation.id).deliveries.filter(d => d.status === 'pending').length, 1);
  } finally { h.owner.close(); }
});

test('N2: close plus exact result finishes a live call, close without a result interrupts without resending', () => {
  for (const hasResult of [true, false]) {
    const h = setup();
    try {
      const id = running(h.store, h.conversation.id), observed = observation(h.store, id);
      if (!hasResult) delete observed.result;
      const result = h.store.resolveRecovery(id, recoveryRequest(h.store, id), observed);
      assert.equal(result.invocation.status, hasResult ? 'succeeded' : 'interrupted');
      assert.equal(result.invocation.teardown, 'confirmed');
      assert.equal(result.check.resolution, hasResult ? 'resolved' : 'closed_result_unknown');
      assert.equal(h.store.invocations(h.conversation.id).length, 1);
    } finally { h.owner.close(); }
  }
});

test('N2: cancellation during an external inspection rejects stale observation before any result update', () => {
  const h = setup();
  try {
    const id = running(h.store, h.conversation.id), input = recoveryRequest(h.store, id), observed = observation(h.store, id);
    h.store.cancel(id);
    assert.throws(() => h.store.resolveRecovery(id, input, observed), code('recovery_version_conflict'));
    assert.equal(h.store.invocation(id).status, 'cancel_requested');
    const fresh = h.store.resolveRecovery(id, recoveryRequest(h.store, id), observed);
    assert.equal(fresh.invocation.status, 'cancelled');
    assert.notEqual(h.store.response(fresh.invocation.responseId).content, observed.result!.content);
  } finally { h.owner.close(); }
});

test('N2: held delivery recheck is exact, versioned, idempotent and does not auto-release on member enable', () => {
  const h = setup();
  try {
    const source = h.store.send(h.conversation.id, { content: '@claude 等待复核', requestId: randomUUID() }).source;
    const member = h.store.members().find(m => m.id === 'claude')!;
    h.store.saveMember({ ...member, enabled: false });
    assert.equal(h.store.admitNext(), undefined);
    let d = h.store.detail(h.conversation.id).deliveries.find(x => x.sourceId === source.id)!;
    assert.equal(d.status, 'held'); const originalId = d.id;
    const request = { requestId: randomUUID(), expectedDeliveryRevision: d.revision, expectedSourceRevision: source.revision };
    assert.throws(() => h.store.recheckDelivery(d.id, { ...request, expectedSourceRevision: source.revision + 1 }), code('delivery_version_conflict'));
    const blocked = h.store.recheckDelivery(d.id, request);
    assert.equal(blocked.check.outcome, 'held'); assert.equal(blocked.delivery.id, originalId);
    h.store.saveMember({ ...member, enabled: true });
    assert.equal(h.store.admitNext(), undefined, 'Enabling the member is not explicit delivery revalidation.');
    d = h.store.detail(h.conversation.id).deliveries.find(x => x.id === originalId)!;
    const retry = { requestId: randomUUID(), expectedDeliveryRevision: d.revision, expectedSourceRevision: source.revision };
    const first = h.store.recheckDelivery(d.id, retry);
    assert.equal(first.check.outcome, 'pending'); assert.equal(first.delivery.id, originalId);
    assert.equal(first.delivery.sourceId, source.id); assert.equal(first.delivery.memberId, 'claude');
    assert.equal(h.store.recheckDelivery(d.id, retry).check.id, first.check.id);
    assert.throws(() => h.store.recheckDelivery(d.id, { ...retry, expectedDeliveryRevision: retry.expectedDeliveryRevision + 1 }), code('idempotency_conflict'));
    const detail = h.store.detail(h.conversation.id);
    assert.equal(detail.sources.length, 1); assert.equal(detail.messages.length, 1); assert.equal(detail.holdRechecks?.length, 2);
    const next = h.store.admitNext()!; assert.equal(next.invocations[0]!.memberId, 'claude'); assert.equal(next.batch.sourceId, source.id);
    assert.equal(h.store.invocations(h.conversation.id).length, 1);
  } finally { h.owner.close(); }
});

test('NEXT10: one held target recheck cannot bypass earlier overlapping sources or current occupancy', () => {
  const h = setup();
  try {
    const third = { ...h.store.members().find(m => m.id === 'codex')!, id: 'reviewer', name: '独立复核成员' };
    h.store.saveMember(third);
    h.store.updateConversation(h.conversation.id, { memberIds: ['codex', 'claude', 'reviewer'], defaultMemberId: 'codex' });
    const occupied = running(h.store, h.conversation.id);
    const earlier = h.store.send(h.conversation.id, { content: '@codex @claude 先前的共同任务。', requestId: randomUUID() }).source;
    const later = h.store.send(h.conversation.id, { content: '@claude @reviewer 后续的共同任务。', requestId: randomUUID() }).source;
    h.store.saveMember({ ...third, enabled: false });
    assert.equal(h.store.admitNext(), undefined);
    const before = h.store.detail(h.conversation.id), held = before.deliveries.find(d => d.sourceId === later.id && d.memberId === 'reviewer')!;
    assert.equal(held.status, 'held');
    assert.equal(before.deliveries.find(d => d.sourceId === later.id && d.memberId === 'claude')!.status, 'pending');
    h.store.saveMember(third);
    const result = h.store.recheckDelivery(held.id, { requestId: randomUUID(), expectedDeliveryRevision: held.revision, expectedSourceRevision: later.revision });
    assert.equal(result.check.outcome, 'pending'); assert.equal(result.delivery.id, held.id);
    const rechecked = h.store.detail(h.conversation.id);
    assert.deepEqual(rechecked.deliveries.filter(d => d.id !== held.id), before.deliveries.filter(d => d.id !== held.id), 'A delivery recheck changes no sibling or earlier source delivery.');
    assert.equal(rechecked.invocations.length, 1); assert.equal(rechecked.sources.length, 3);
    assert.equal(h.store.admitNext(), undefined, 'The free reviewer must not drag the later overlapping group past the earlier codex/claude source.');
    const finish = (id: string) => {
      if (h.store.invocation(id).status === 'prepared') { h.store.startInvocation(id); accepted(h.store, id); }
      h.store.recordEvidence(id, { kind: 'process_exit', detail: { code: 0, confirmed: true } });
      h.store.finish(id, 'succeeded', '受控工作完成。');
    };
    finish(occupied);
    const first = h.store.admitNext()!;
    assert.equal(first.batch.sourceId, earlier.id); assert.equal(first.batch.mode, 'parallel'); assert.deepEqual(first.batch.targets, ['codex', 'claude']);
    assert.equal(h.store.admitNext(), undefined, 'Admitted work still occupies its original members.');
    finish(first.invocations.find(i => i.memberId === 'codex')!.id);
    assert.equal(h.store.admitNext(), undefined, 'One completed sibling does not release the other member occupancy.');
    finish(first.invocations.find(i => i.memberId === 'claude')!.id);
    const second = h.store.admitNext()!;
    assert.equal(second.batch.sourceId, later.id); assert.equal(second.batch.mode, 'parallel'); assert.deepEqual(second.batch.targets, ['claude', 'reviewer']);
    const final = h.store.detail(h.conversation.id);
    assert.equal(final.deliveries.find(d => d.id === held.id)!.status, 'consumed');
    assert.deepEqual(final.consumptions.filter(c => c.sourceId === later.id).map(c => c.deliveryId).sort(), before.deliveries.filter(d => d.sourceId === later.id).map(d => d.id).sort());
    assert.equal(final.holdRechecks!.length, 1); assert.equal(final.invocations.length, 5); assert.equal(h.store.admitNext(), undefined);
  } finally { h.owner.close(); }
});
