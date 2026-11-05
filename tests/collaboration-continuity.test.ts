import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { verifyClaudeHistory, describeNativeSession } from '../server/collaboration/runtime-session.js';
import type { RuntimeEvent, RuntimeRequest, NativeSessionIdentity } from '../shared/collaboration.js';

const identity: NativeSessionIdentity = { supported: true, version: 'fixture 1', fingerprint: 'fixture-runtime-account-workspace', reason: 'fixture' };
function setup(path = ':memory:', workspace = '/synthetic/workspace') {
  const owner = new Store(path), store = new CollaborationStore(owner, { workspace });
  for (const m of store.members()) store.saveMember({ ...m, model: 'fixture-model' });
  const conversation = store.create({ title: 'N3 fixture', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
  return { owner, store, conversation };
}
function prepare(store: CollaborationStore, cid: string, content = '@codex next', descriptor = identity) {
  store.send(cid, { content, requestId: randomUUID() });
  const i = store.admitNext()!.invocations[0]!;
  store.prepareSession(i.id, descriptor); return store.invocation(i.id);
}
function success(store: CollaborationStore, id: string, sid: string, anchor: string, continuity: 'fresh' | 'resumed' = 'fresh') {
  store.startInvocation(id);
  store.recordEvidence(id, { kind: 'session', detail: { nativeSessionId: sid, continuity, anchor, historyVerified: true } });
  store.recordEvidence(id, { kind: 'accepted', detail: { nativeSessionId: sid } });
  store.recordEvidence(id, { kind: 'process_exit', detail: { confirmed: true, code: 0 } });
  store.finish(id, 'succeeded', 'OK');
}

test('N3: durable same-member native binding survives restart; different members and conversations cannot share it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n3-binding-')); let owner: Store | undefined;
  try {
    const h = setup(join(dir, 'db')); owner = h.owner;
    const first = prepare(h.store, h.conversation.id); success(h.store, first.id, 'session-codex', 'turn-1');
    const other = prepare(h.store, h.conversation.id, '@claude next'); assert.equal(other.sessionPlan?.mode, 'fresh');
    success(h.store, other.id, 'session-claude', 'message-1');
    owner.close(); owner = new Store(join(dir, 'db')); const reopened = new CollaborationStore(owner, { workspace: '/synthetic/workspace' });
    const next = prepare(reopened, h.conversation.id);
    assert.equal(next.sessionPlan?.mode, 'resume'); assert.equal(next.sessionPlan?.nativeSessionId, 'session-codex'); assert.equal(next.sessionPlan?.previousAnchor, 'turn-1');
    assert.equal(next.sessionPlan?.bindingId, first.sessionPlan?.bindingId);
    assert.deepEqual(reopened.prepareSession(next.id, identity), next.sessionPlan, 'Plan replay does not reserve a second binding.');
    success(reopened, next.id, 'session-codex', 'turn-2', 'resumed');
    const c2 = reopened.create({ title: 'separate', memberIds: ['codex'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
    assert.equal(prepare(reopened, c2.id).sessionPlan?.mode, 'fresh');
    assert.equal(reopened.nativeSessions(h.conversation.id).length, 2);
    assert.equal(reopened.nativeSessions(h.conversation.id).find(s => s.memberId === 'codex')?.anchor, 'turn-2');
  } finally { owner?.close(); await rm(dir, { recursive: true, force: true }); }
});

for (const change of ['account', 'model', 'instructions', 'workspace', 'runtime_identity', 'permissions'] as const) test(`N3: ${change} changes seal previous generation before a fresh execution`, () => {
  const h = setup();
  try {
    const first = prepare(h.store, h.conversation.id); success(h.store, first.id, 'old-session', 'old-turn');
    const m = h.store.members().find(m => m.id === 'codex')!;
    if (change === 'account') h.store.saveAccount({ ...h.store.accounts()[0]!, name: 'Changed account metadata' });
    if (change === 'model') h.store.saveMember({ ...m, model: 'new-model' });
    if (change === 'instructions') h.store.saveMember({ ...m, instructions: 'New responsibilities' });
    const store = change === 'workspace' ? new CollaborationStore(h.owner, { workspace: '/other/workspace' }) : h.store;
    store.send(h.conversation.id, { content: '@codex next', requestId: randomUUID() }); const run = store.admitNext()!.invocations[0]!;
    if (change === 'permissions') { const c = store.contract(run.id); c.toolPolicyVersion = 'future-policy'; h.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE id=?').run(JSON.stringify(c), c.id); }
    const plan = store.prepareSession(run.id, change === 'runtime_identity' ? { ...identity, fingerprint: 'rotated-credential-or-version' } : identity);
    assert.equal(plan.mode, 'replace'); assert.equal(plan.nativeSessionId, undefined);
    const chain = store.nativeSessions(h.conversation.id); assert.equal(chain[0]!.status, 'sealed'); assert.equal(chain[1]!.previousBindingId, chain[0]!.id); assert.equal(chain[1]!.sequence, 2);
  } finally { h.owner.close(); }
});

test('N3: only positive history evidence makes bindings reusable; usage is validated and unknown stays unknown', () => {
  const h = setup();
  try {
    const i = prepare(h.store, h.conversation.id); h.store.startInvocation(i.id);
    h.store.recordEvidence(i.id, { kind: 'session', detail: { nativeSessionId: 'echo-id', continuity: 'unknown' } });
    h.store.recordEvidence(i.id, { kind: 'usage', detail: { source: 'fixture', scope: 'invocation', inputTokens: 12, outputTokens: -3, costUsd: null } });
    h.store.recordEvidence(i.id, { kind: 'accepted', detail: {} }); h.store.recordEvidence(i.id, { kind: 'process_exit', detail: { confirmed: true } }); h.store.finish(i.id, 'succeeded', 'No history proof');
    assert.equal(h.store.nativeSessions(h.conversation.id)[0]!.status, 'sealed');
    assert.deepEqual(h.store.invocation(i.id).usage, { source: 'fixture', scope: 'invocation', inputTokens: 12 });
    assert.equal(prepare(h.store, h.conversation.id).sessionPlan?.mode, 'replace');
  } finally { h.owner.close(); }
});

test('N3: cancellation and unknown execution cannot be bypassed with a new session; late proof cannot make ready', () => {
  const h = setup();
  try {
    const i = prepare(h.store, h.conversation.id); h.store.startInvocation(i.id); h.store.cancel(i.id);
    h.store.recordEvidence(i.id, { kind: 'session', detail: { nativeSessionId: 'late', anchor: 'late-turn', continuity: 'fresh', historyVerified: true } });
    h.store.finish(i.id, 'succeeded', 'late success');
    assert.equal(h.store.nativeSessions(h.conversation.id)[0]!.status, 'sealed');
    h.store.send(h.conversation.id, { content: 'next', requestId: randomUUID() }); assert.equal(h.store.admitNext(), undefined);
    assert.equal(h.store.invocation(i.id).status, 'interrupted');
  } finally { h.owner.close(); }
});

test('N3: session replacement before runtime input retains one invocation; after exposure or with wrong identity it is rejected atomically', () => {
  const h = setup();
  try {
    const first = prepare(h.store, h.conversation.id); success(h.store, first.id, 'session-a', 'turn-a');
    const next = prepare(h.store, h.conversation.id); h.store.startInvocation(next.id);
    assert.throws(() => h.store.recordEvidence(next.id, { kind: 'session_replaced', detail: { beforeInput: true, previousSessionId: 'wrong' } }));
    h.store.recordEvidence(next.id, { kind: 'exposed', detail: { source: 'platform_prompt' } });
    h.store.recordEvidence(next.id, { kind: 'session_replaced', detail: { beforeInput: true, previousSessionId: 'session-a', reason: 'missing native history' } });
    assert.equal(h.store.invocation(next.id).sessionPlan?.mode, 'replace'); assert.equal(h.store.invocations().length, 2);
    assert.equal(h.store.nativeSessions(h.conversation.id).length, 2);
    h.store.recordEvidence(next.id, { kind: 'exposed', detail: { nativeSessionId: 'new-session' } });
    assert.throws(() => h.store.recordEvidence(next.id, { kind: 'session_replaced', detail: { beforeInput: true, previousSessionId: 'new-session' } }));
    assert.equal(h.store.nativeSessions(h.conversation.id).length, 2);
  } finally { h.owner.close(); }
});

test('N3: schema v2 upgrades without rewriting old contracts or fabricating native bindings', () => {
  const h = setup();
  try {
    h.store.send(h.conversation.id, { content: 'prepared legacy', requestId: randomUUID() }); const i = h.store.admitNext()!.invocations[0]!;
    const c = h.store.contract(i.id); c.behaviorVersion = '0.3.0'; c.adapterCapabilityVersion = 'native-fresh-v1';
    h.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE id=?').run(JSON.stringify(c), c.id);
    h.owner.db.exec('DROP TABLE cc_native_sessions; UPDATE cc_schema SET version=2');
    const store = new CollaborationStore(h.owner);
    assert.equal((h.owner.db.prepare('SELECT version FROM cc_schema').get() as any).version, 5);
    assert.deepEqual(store.contract(i.id), c); assert.deepEqual(store.nativeSessions(h.conversation.id), []);
    assert.equal(store.prepareSession(i.id, identity).mode, 'unsupported');
  } finally { h.owner.close(); }
});

test('N3: engine passes frozen native plan to adapter and API/non-native runtimes remain fresh', async () => {
  const h = setup(); const calls: RuntimeRequest[] = [];
  const runtime = { probe: async () => [], sessionIdentity: async () => identity, invoke: async (r: RuntimeRequest) => {
    calls.push(r); const sid = r.nativeSessionId || randomUUID();
    r.onEvent({ kind: 'session', detail: { nativeSessionId: sid, continuity: r.nativeSessionId ? 'resumed' : 'fresh', anchor: r.invocationId, historyVerified: true } });
    r.onEvent({ kind: 'accepted', detail: {} }); r.onEvent({ kind: 'process_exit', detail: { confirmed: true } });
    return { text: 'OK', nativeSessionId: sid, continuity: r.nativeSessionId ? 'resumed' as const : 'fresh' as const };
  } };
  const engine = new CollaborationEngine(h.store, runtime, { workspace: '/synthetic/workspace' });
  try {
    engine.start();
    for (let turn = 1; turn <= 2; turn++) {
      h.store.send(h.conversation.id, { content: 'next', requestId: randomUUID() }); engine.kick();
      const end = Date.now() + 2000;
      while (h.store.invocations().filter(i => i.status === 'succeeded').length < turn) { if (Date.now() > end) throw new Error('Engine timeout'); await new Promise(r => setTimeout(r, 10)); }
    }
    assert.equal(calls.length, 2); assert.equal(calls[1]!.nativeSessionId, h.store.invocations()[0]!.nativeSessionId);
    assert.equal(calls[1]!.sessionPlan?.mode, 'resume'); assert.equal(calls[1]!.sessionPlan?.previousAnchor, calls[0]!.invocationId);
  } finally { await engine.stop(); h.owner.close(); }
});

test('N3: Claude proof requires exact input plus new assistant ancestry to prior anchor, not an echoed session ID', () => {
  const rows = [
    { uuid: 'old', parentUuid: undefined, sessionId: 's', type: 'assistant' },
    { uuid: 'input', parentUuid: 'old', sessionId: 's', type: 'user', message: { content: 'Exact request' } },
    { uuid: 'new', parentUuid: 'input', sessionId: 's', type: 'assistant' },
  ];
  assert.equal(verifyClaudeHistory(rows, 'Exact request', 'new', 'old'), true);
  assert.equal(verifyClaudeHistory(rows, 'Other request', 'new', 'old'), false);
  assert.equal(verifyClaudeHistory(rows, 'Exact request', 'old', 'old'), false);
  assert.equal(verifyClaudeHistory(rows, 'Exact request', 'new', 'someone-else'), false);
  assert.equal(verifyClaudeHistory(rows.map(r => r.uuid === 'input' ? { ...r, parentUuid: 'new' } : r), 'Exact request', 'new', 'old'), false);
});

test('N3: API credential rotation and executable version participate in runtime identity without exposing secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n3-identity-')); const key = 'N3_SYNTHETIC_TEST_KEY';
  try {
    const command = join(dir, 'codex'); await writeFile(command, `#!${process.execPath}\nconsole.log('fixture-version-1');`); await chmod(command, 0o700);
    const input = { cwd: dir, member: { id: 'm', name: 'm', enabled: true, instructions: '', accountId: 'a', carrier: 'codex-app-server' as const, model: 'm' }, account: { id: 'a', name: 'a', provider: 'codex' as const, auth: 'api' as const, apiKeyEnv: key } };
    process.env[key] = 'synthetic-secret-first'; const first = await describeNativeSession(input, command);
    process.env[key] = 'synthetic-secret-second'; const second = await describeNativeSession(input, command);
    assert.ok(first.supported && second.supported); assert.notEqual(first.fingerprint, second.fingerprint);
    assert.doesNotMatch(JSON.stringify([first, second]), /synthetic-secret/);
    await writeFile(command, `#!${process.execPath}\nconsole.log('fixture-version-2');`);
    assert.notEqual((await describeNativeSession(input, command)).fingerprint, second.fingerprint);
  } finally { delete process.env[key]; await rm(dir, { recursive: true, force: true }); }
});
