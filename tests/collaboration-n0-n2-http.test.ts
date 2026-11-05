import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import { withRuntimeInspection } from '../server/collaboration/inspection.js';
import type { CollaborationBootstrap, CollaborationRuntime, ConversationDetail, RecoveryRequest, RuntimeInspection, RuntimeInspectionRequest, RuntimeRequest } from '../shared/collaboration.js';

const probe: CollaborationRuntime['probe'] = async () => [
  { carrier: 'codex-app-server', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested' },
  { carrier: 'claude-cli', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested' },
];
const noInvoke: CollaborationRuntime['invoke'] = async () => { throw new Error('This HTTP fixture must not dispatch a model.'); };
async function harness(runtime: CollaborationRuntime = { probe, invoke: noInvoke }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'collab-n0-n2-http-'));
  let app = await createApplication({ dataDir, port: 0, collaborationRuntime: runtime, startWorker: false });
  let address = await app.start();
  let bootstrap = await (await fetch(address.url + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
  const api = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(address.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrfToken, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() as any };
  };
  const conversation = async () => {
    const result = await api('/api/conversations', { title: 'N0–N2 HTTP 验收', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() });
    assert.equal(result.status, 201); return result.data.conversation.id as string;
  };
  return {
    get app() { return app; }, api, get bootstrap() { return bootstrap; }, conversation,
    detail: async (id: string) => (await api(`/api/conversations/${id}`)).data as ConversationDetail,
    restart: async (nextRuntime: CollaborationRuntime) => {
      await app.close();
      app = await createApplication({ dataDir, port: 0, collaborationRuntime: nextRuntime, startWorker: false });
      address = await app.start();
      bootstrap = await (await fetch(address.url + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
      app.collaborationEngine.start();
    },
    close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function running(h: Harness, conversationId: string) {
  const sent = await h.api(`/api/conversations/${conversationId}/messages`, { content: '@codex 请处理准确输入。', requestId: randomUUID() });
  assert.equal(sent.status, 201);
  const i = h.app.collaborationStore.admitNext()!.invocations[0]!;
  h.app.collaborationStore.startInvocation(i.id);
  h.app.collaborationStore.recordEvidence(i.id, { kind: 'session', detail: { nativeSessionId: `session-${i.id}`, nativeTurnId: `turn-${i.id}`, continuity: 'fresh' } });
  h.app.collaborationStore.recordEvidence(i.id, { kind: 'accepted', detail: { nativeSessionId: `session-${i.id}`, nativeTurnId: `turn-${i.id}`, evidence: 'controlled-http-fixture' } });
  return i.id;
}
function recovery(h: Harness, id: string): RecoveryRequest {
  const i = h.app.collaborationStore.invocation(id);
  return { requestId: randomUUID(), expectedInvocationRevision: i.invocationRevision!, expectedCancelRevision: i.cancelRevision!, expectedInputRevision: h.app.collaborationStore.response(i.responseId).inputRevision };
}
function settled(request: RuntimeInspectionRequest): RuntimeInspection {
  return {
    invocationId: request.invocationId, carrier: request.member.carrier, nativeSessionId: request.nativeSessionId, nativeTurnId: request.nativeTurnId,
    state: 'settled', acceptance: 'accepted', teardown: 'confirmed', result: { status: 'succeeded', content: '来自服务端承载的真实测试结果。' },
    reason: '受控承载确认准确终态和退出。', observedAt: new Date().toISOString(), evidence: [{ kind: 'process_exit', detail: { code: 0, confirmed: true, transport: 'stdio' } }],
  };
}
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await read(); if (match(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('The controlled HTTP fixture did not reach its expected state.');
}

test('N0 HTTP: preview has no effects, send computes authoritative routing, replay is stable and CSRF is required', async () => {
  const h = await harness();
  try {
    const id = await h.conversation(), path = `/api/conversations/${id}`, content = '@claude 请复核本次方案。';
    const before = await h.detail(id);
    for (const route of ['/route-preview', '/messages']) {
      for (const headers of [{ 'x-csrf-token': '' }, { origin: 'https://foreign.example' }]) {
        assert.equal((await h.api(path + route, { content, requestId: randomUUID() }, headers)).status, 403);
      }
    }
    const preview = await h.api(path + '/route-preview', { content });
    assert.equal(preview.status, 200); assert.deepEqual(preview.data.routing.targets, ['claude']);
    assert.equal(preview.data.routing.reason, 'explicit_mention');
    assert.deepEqual(await h.detail(id), before, 'Preview and rejected requests cannot create a source or event.');
    const body = { content, requestId: randomUUID(), targets: ['codex'], routing: { ...preview.data.routing, targets: ['codex'] } };
    const sent = await h.api(path + '/messages', body);
    assert.equal(sent.status, 201); assert.deepEqual(sent.data.source.requestedTargets, ['claude']);
    for (const key of ['targets', 'reason', 'policyVersion', 'historyCursor', 'configurationRevision']) assert.deepEqual(sent.data.routing[key], preview.data.routing[key]);
    const replay = await h.api(path + '/messages', body);
    assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.source.id, sent.data.source.id);
    assert.deepEqual(replay.data.routing, sent.data.routing);
    assert.equal((await h.api(path + '/messages', { ...body, content: '@codex 不同的消息' })).status, 409);
    const detail = await h.detail(id);
    assert.equal(detail.messages.length, 1); assert.equal(detail.sources.length, 1); assert.equal(detail.routingDecisions!.length, 1);

    const changedId = await h.conversation(), changedPath = `/api/conversations/${changedId}`;
    const oldPreview = await h.api(changedPath + '/route-preview', { content: '开始任务。' });
    assert.deepEqual(oldPreview.data.routing.targets, ['codex']);
    assert.equal((await h.api(changedPath + '/settings', { memberIds: ['codex', 'claude'], defaultMemberId: 'claude' })).status, 200);
    const changedSend = await h.api(changedPath + '/messages', { content: '开始任务。', requestId: randomUUID(), routing: oldPreview.data.routing });
    assert.deepEqual(changedSend.data.routing.targets, ['claude'], 'A stale client preview never overrides current server routing.');
    assert.ok(changedSend.data.routing.configurationRevision > oldPreview.data.routing.configurationRevision);
  } finally { await h.close(); }
});

test('N1 HTTP: input GET reports uncaptured facts, then returns the exact frozen prompt actually sent to the adapter', async () => {
  const calls: RuntimeRequest[] = [];
  const h = await harness({ probe, async invoke(request) {
    calls.push(request);
    request.onEvent({ kind: 'session', detail: { nativeSessionId: 'http-native-session', nativeTurnId: 'http-native-turn', continuity: 'fresh' } });
    request.onEvent({ kind: 'accepted', detail: { nativeSessionId: 'http-native-session', nativeTurnId: 'http-native-turn' } });
    request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true } });
    return { text: '输入验收完成。', continuity: 'fresh' };
  } });
  try {
    const id = await h.conversation();
    await h.api(`/api/conversations/${id}/messages`, { content: '@codex 当前请求：需要保存准确输入。', requestId: randomUUID() });
    const i = h.app.collaborationStore.admitNext()!.invocations[0]!, path = `/api/invocations/${i.id}/input`;
    const before = await h.detail(id), uncaptured = await h.api(path);
    assert.equal(uncaptured.status, 200); assert.equal(uncaptured.data.manifest, null); assert.equal(uncaptured.data.prompt, null);
    assert.match(uncaptured.data.reason, /未捕获/); assert.deepEqual(await h.detail(id), before, 'Reading never reconstructs an alleged historical input.');
    assert.equal((await h.api('/api/invocations/no-such-invocation/input')).status, 404);
    const oldMember = h.app.collaborationStore.members().find(member => member.id === 'codex')!;
    assert.equal((await h.api('/api/members', { ...oldMember, instructions: 'CHANGED_AFTER_ADMISSION' })).status, 200);
    h.app.collaborationEngine.start();
    await until(() => h.detail(id), d => d.responses[0]?.status === 'succeeded');
    const input = await h.api(path);
    assert.equal(input.status, 200); assert.equal(calls.length, 1);
    assert.equal(input.data.prompt, calls[0]!.prompt); assert.equal(calls[0]!.member.instructions, oldMember.instructions);
    assert.ok(!input.data.prompt.includes('CHANGED_AFTER_ADMISSION'));
    assert.equal(input.data.manifest.renderDigest, createHash('sha256').update(calls[0]!.prompt).digest('hex'));
    assert.equal(input.data.manifest.digestStage, 'platform_prompt'); assert.equal(input.data.manifest.invocationId, i.id);
    assert.deepEqual((await h.api(path)).data, input.data, 'Repeated input reads retain the same manifest and bytes.');
    const detail = await h.detail(id);
    assert.equal(detail.inputManifests!.length, 1);
    assert.equal(detail.contracts![0]!.id, input.data.manifest.contractId);
    assert.equal(detail.evidence.filter(event => event.kind === 'exposed').some(event => event.detail.manifestId === input.data.manifest.id), true);
    h.app.store.db.prepare('UPDATE cc_payloads SET prompt=? WHERE id=?').run('tampered test payload', input.data.manifest.payloadRef);
    const tampered = await h.api(path);
    assert.equal(tampered.status, 409); assert.equal(tampered.data.code, 'input_digest_conflict');
  } finally { await h.close(); }
});

test('N2 HTTP: reconciliation accepts only server inspection, fences versions, preserves replay and never dispatches', async () => {
  const inspections: RuntimeInspectionRequest[] = []; let supported = false, invocations = 0;
  const h = await harness({ probe, async invoke() { invocations++; throw new Error('Unexpected provider dispatch.'); }, async inspect(request) {
    inspections.push(request);
    return supported ? settled(request) : { invocationId: request.invocationId, carrier: request.member.carrier, state: 'unsupported', acceptance: 'unknown', teardown: 'unknown', reason: 'This new process has no native observation.', observedAt: new Date().toISOString(), evidence: [] };
  } });
  try {
    const id = await h.conversation(), invocationId = await running(h, id), path = `/api/invocations/${invocationId}/reconcile`;
    const contract = h.app.collaborationStore.contract(invocationId);
    h.app.collaborationStore.recover();
    const before = await h.detail(id), request = recovery(h, invocationId);
    const forged = { invocationId, carrier: 'codex-app-server', nativeSessionId: `session-${invocationId}`, nativeTurnId: `turn-${invocationId}`, state: 'settled', acceptance: 'accepted', teardown: 'confirmed', result: { status: 'succeeded', content: 'FORGED_CLIENT_RESULT' }, evidence: [{ kind: 'process_exit', detail: { confirmed: true } }] };
    for (const headers of [{ 'x-csrf-token': '' }, { origin: 'https://foreign.example' }]) assert.equal((await h.api(path, request, headers)).status, 403);
    for (const key of ['expectedInvocationRevision', 'expectedCancelRevision', 'expectedInputRevision'] as const) {
      const stale = await h.api(path, { ...request, requestId: randomUUID(), [key]: request[key] + 1 });
      assert.equal(stale.status, 409); assert.equal(stale.data.code, 'recovery_version_conflict');
    }
    assert.equal((await h.api(path, { ...request, expectedInputRevision: '1' })).status, 400);
    assert.equal(inspections.length, 0, 'CSRF and stale versions are checked before external inspection.');
    const unknown = await h.api(path, { ...request, ...forged, observation: forged });
    assert.equal(unknown.status, 200); assert.equal(unknown.data.check.resolution, 'unresolved');
    assert.equal(unknown.data.check.observation.state, 'unsupported'); assert.equal(unknown.data.invocation.status, 'interrupted');
    assert.equal(unknown.data.invocation.teardown, 'unknown');
    const afterUnknown = await h.detail(id);
    assert.equal(afterUnknown.responses[0]!.content, before.responses[0]!.content);
    assert.ok(!JSON.stringify(afterUnknown).includes('FORGED_CLIENT_RESULT')); assert.equal(invocations, 0);
    const replay = await h.api(path, { ...request, observation: { ...forged, result: { status: 'failed', content: 'OTHER_FORGERY' } } });
    assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.check.id, unknown.data.check.id); assert.equal(inspections.length, 1);
    const conflictingReplay = await h.api(path, { ...request, expectedCancelRevision: request.expectedCancelRevision + 1 });
    assert.equal(conflictingReplay.status, 409); assert.equal(conflictingReplay.data.code, 'idempotency_conflict');
    await h.api('/api/members', { ...contract.memberSnapshot, instructions: 'NEW_LIVE_CONFIGURATION' });
    await h.api('/api/accounts', { ...contract.accountMetadataSnapshot, name: 'New account display name' });
    supported = true;
    const fresh = recovery(h, invocationId), resolved = await h.api(path, { ...fresh, observation: forged });
    assert.equal(resolved.status, 200); assert.equal(resolved.data.check.resolution, 'resolved'); assert.equal(resolved.data.invocation.status, 'succeeded');
    assert.deepEqual(inspections[1]!.member, contract.memberSnapshot); assert.deepEqual(inspections[1]!.account, contract.accountMetadataSnapshot);
    assert.equal(inspections[1]!.workspaceScope, contract.workspaceScope);
    assert.equal(inspections[1]!.nativeSessionId, `session-${invocationId}`); assert.equal(inspections[1]!.nativeTurnId, `turn-${invocationId}`);
    const final = await h.detail(id);
    assert.equal(final.responses[0]!.content, '来自服务端承载的真实测试结果。'); assert.equal(final.sources.length, before.sources.length);
    assert.equal(final.messages.length, before.messages.length); assert.equal(final.recoveryChecks!.length, 2); assert.equal(invocations, 0);
    assert.equal((await h.api(path, fresh)).data.replayed, true); assert.equal(inspections.length, 2);
  } finally { await h.close(); }
});

test('N2 HTTP: cancellation while inspection is pending returns 409 and late success cannot overwrite cancellation', async () => {
  for (const restarted of [false, true]) {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const h = await harness({ probe, invoke: noInvoke, async inspect(request) { entered(); await gate; return settled(request); } });
    try {
      const id = await h.conversation(), invocationId = await running(h, id), path = `/api/invocations/${invocationId}`;
      if (restarted) h.app.collaborationStore.recover();
      const oldContent = (await h.detail(id)).responses[0]!.content;
      const inFlight = h.api(path + '/reconcile', recovery(h, invocationId));
      await started;
      assert.equal((await h.api(path + '/cancel', {})).status, 200);
      release();
      const stale = await inFlight;
      assert.equal(stale.status, 409); assert.equal(stale.data.code, 'recovery_version_conflict');
      const cancelled = await h.detail(id);
      assert.equal(cancelled.invocations[0]!.status, restarted ? 'interrupted' : 'cancel_requested'); assert.equal(cancelled.recoveryChecks!.length, 0);
      assert.equal(cancelled.invocations[0]!.interruptionCause, 'user_cancel'); assert.equal(cancelled.invocations[0]!.cancelRevision, 1);
      const checked = await h.api(path + '/reconcile', recovery(h, invocationId));
      assert.equal(checked.status, 200); assert.equal(checked.data.invocation.status, restarted ? 'interrupted' : 'cancelled');
      assert.equal(checked.data.invocation.teardown, 'confirmed');
      const finalContent = (await h.detail(id)).responses[0]!.content;
      assert.notEqual(finalContent, '来自服务端承载的真实测试结果。');
      if (restarted) assert.equal(finalContent, oldContent);
    } finally { release(); await h.close(); }
  }
});

test('N2 HTTP: held recheck validates the original delivery, requires CSRF and versions, and does not duplicate work', async () => {
  const h = await harness();
  try {
    const id = await h.conversation();
    const sent = await h.api(`/api/conversations/${id}/messages`, { content: '@claude 稍后复核。', requestId: randomUUID() });
    const member = h.app.collaborationStore.members().find(m => m.id === 'claude')!;
    assert.equal((await h.api('/api/members', { ...member, enabled: false })).status, 200);
    assert.equal(h.app.collaborationStore.admitNext(), undefined);
    const original = (await h.detail(id)).deliveries[0]!, path = `/api/deliveries/${original.id}/recheck`;
    assert.equal(original.status, 'held');
    const request = { requestId: randomUUID(), expectedDeliveryRevision: original.revision, expectedSourceRevision: sent.data.source.revision };
    for (const headers of [{ 'x-csrf-token': '' }, { origin: 'https://foreign.example' }]) assert.equal((await h.api(path, request, headers)).status, 403);
    for (const key of ['expectedDeliveryRevision', 'expectedSourceRevision'] as const) {
      const conflict = await h.api(path, { ...request, [key]: request[key] + 1 });
      assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'delivery_version_conflict');
    }
    assert.equal((await h.api(path, { ...request, expectedDeliveryRevision: -1 })).status, 400);
    const held = await h.api(path, request);
    assert.equal(held.status, 200); assert.equal(held.data.check.outcome, 'held'); assert.equal(held.data.delivery.id, original.id);
    assert.equal((await h.api('/api/members', { ...member, enabled: true })).status, 200);
    assert.equal(h.app.collaborationStore.admitNext(), undefined, 'Enabling a member is not revalidation of held work.');
    const stillHeld = (await h.detail(id)).deliveries[0]!;
    const retry = { ...request, requestId: randomUUID(), expectedDeliveryRevision: stillHeld.revision };
    const pending = await h.api(path, retry);
    assert.equal(pending.status, 200); assert.equal(pending.data.check.outcome, 'pending');
    assert.equal(pending.data.delivery.id, original.id); assert.equal(pending.data.delivery.sourceId, sent.data.source.id); assert.equal(pending.data.delivery.memberId, 'claude');
    const replay = await h.api(path, retry);
    assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.equal(replay.data.check.id, pending.data.check.id);
    const conflict = await h.api(path, { ...retry, expectedDeliveryRevision: retry.expectedDeliveryRevision + 1 });
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'idempotency_conflict');
    const detail = await h.detail(id);
    assert.equal(detail.sources.length, 1); assert.equal(detail.messages.length, 1); assert.equal(detail.deliveries.length, 1); assert.equal(detail.holdRechecks!.length, 2);
    const admitted = h.app.collaborationStore.admitNext()!;
    assert.equal(admitted.invocations.length, 1); assert.equal(admitted.invocations[0]!.memberId, 'claude'); assert.equal(admitted.batch.sourceId, sent.data.source.id);
    assert.equal(h.app.collaborationStore.admitNext(), undefined);
  } finally { await h.close(); }
});

test('NEXT08 HTTP: accepted connection loss survives a file-backed service restart and unsupported inspection never redispatches', async () => {
  const calls: string[] = [];
  const newProcessRuntime = () => withRuntimeInspection({ probe, async invoke(request) {
    calls.push(request.invocationId);
    request.onEvent({ kind: 'session', detail: { nativeSessionId: `session-${request.invocationId}`, nativeTurnId: `turn-${request.invocationId}`, continuity: 'fresh' } });
    request.onEvent({ kind: 'accepted', detail: { nativeSessionId: `session-${request.invocationId}`, nativeTurnId: `turn-${request.invocationId}`, evidence: 'controlled-native-acceptance' } });
    throw new Error('Controlled connection loss after acceptance; no process exit or native result receipt.');
  } });
  const h = await harness(newProcessRuntime());
  try {
    const id = await h.conversation(); h.app.collaborationEngine.start();
    const first = await h.api(`/api/conversations/${id}/messages`, { content: '@codex 外部已接受但连接随后丢失。', requestId: randomUUID() });
    const disconnected = await until(() => h.detail(id), d => d.responses[0]?.status === 'failed');
    const original = disconnected.invocations[0]!;
    assert.deepEqual(calls, [original.id]); assert.equal(original.acceptance, 'accepted'); assert.equal(original.teardown, 'unknown');
    const queued = await h.api(`/api/conversations/${id}/messages`, { content: '@codex 后续请求必须等原占用核实。', requestId: randomUUID() });
    assert.equal(queued.status, 201); assert.equal((await h.detail(id)).invocations.length, 1);
    await h.restart(newProcessRuntime());
    const restored = await h.detail(id);
    assert.equal(restored.invocations.length, 1); assert.equal(restored.invocations[0]!.id, original.id);
    assert.equal(restored.invocations[0]!.acceptance, 'accepted'); assert.equal(restored.invocations[0]!.teardown, 'unknown');
    const input = recovery(h, original.id), path = `/api/invocations/${original.id}/reconcile`;
    const checked = await h.api(path, input);
    assert.equal(checked.status, 200); assert.equal(checked.data.check.resolution, 'unresolved');
    assert.equal(checked.data.check.observation.state, 'unsupported'); assert.equal(checked.data.check.observation.result, undefined);
    assert.equal(checked.data.invocation.acceptance, 'accepted'); assert.equal(checked.data.invocation.teardown, 'unknown');
    assert.equal((await h.api(path, input)).data.replayed, true);
    h.app.collaborationEngine.kick();
    const after = await h.detail(id);
    assert.deepEqual(calls, [original.id], 'Reopening storage, reconciliation, replay and scheduler ticks cannot make another external call.');
    assert.equal(after.invocations.length, 1); assert.equal(after.sources.length, 2);
    assert.equal(after.deliveries.find(d => d.sourceId === first.data.source.id)!.status, 'consumed');
    assert.equal(after.deliveries.find(d => d.sourceId === queued.data.source.id)!.status, 'pending');
    assert.equal(after.responses[0]!.content, disconnected.responses[0]!.content);
  } finally { await h.close(); }
});
