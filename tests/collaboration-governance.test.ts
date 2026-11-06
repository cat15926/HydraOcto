import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import type { RuntimeRequest } from '../shared/collaboration.js';

function setup(path = ':memory:') {
  const owner = new Store(path); const store = new CollaborationStore(owner, { workspace: '/synthetic/governance-workspace' });
  const conversation = store.create({ title: '治理验收', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: 'conversation' }).conversation;
  return { owner, store, conversation };
}
function alter<T extends { id: string }>(owner: Store, table: string, record: T, change: (value: T) => void) {
  const next = structuredClone(record); change(next);
  owner.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(next), next.id);
}
function finish(store: CollaborationStore, invocationId: string, content: string) {
  store.startInvocation(invocationId);
  store.recordEvidence(invocationId, { kind: 'accepted', detail: { nativeTurnId: 'test-turn' } });
  store.recordEvidence(invocationId, { kind: 'process_exit', detail: { code: 0, confirmed: true, fixture: true } });
  store.finish(invocationId, 'succeeded', content);
}
function snapshotIds(store: CollaborationStore, conversationId: string) {
  const detail = store.detail(conversationId);
  return { conversation: detail.conversation.id, sources: detail.sources.map(x => x.id), deliveries: detail.deliveries.map(x => x.id), batches: detail.batches.map(x => x.id), invocations: detail.invocations.map(x => x.id), responses: detail.responses.map(x => x.id), consumptions: detail.consumptions.map(x => x.id), messages: detail.messages.map(x => x.id) };
}

/** Remove only v2 additions to make a persisted v1 fixture, retaining real core rows and FKs. */
function downgradeFixture(owner: Store) {
  const fields: Record<string, string[]> = {
    cc_accounts: ['revision'], cc_members: ['revision'], cc_conversations: ['revision', 'preferredMemberIds', 'routingMode'],
    cc_sources: ['routingDecisionId'], cc_batches: ['historyCutoff'], cc_messages: ['sequence'],
    cc_invocations: ['contractId', 'invocationRevision', 'cancelRevision', 'interruptionCause', 'recoveryState', 'resolutionId', 'blockedReason'],
  };
  for (const [table, removed] of Object.entries(fields)) {
    for (const row of owner.db.prepare(`SELECT id,value FROM ${table}`).all() as { id: string; value: string }[]) {
      const value = JSON.parse(row.value) as Record<string, unknown>; for (const key of removed) delete value[key];
      owner.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), row.id);
    }
  }
  for (const row of owner.db.prepare('SELECT request_id,result FROM cc_commands').all() as { request_id: string; result: string }[]) {
    const value = JSON.parse(row.result) as Record<string, unknown>; delete value.routingDecisionId;
    owner.db.prepare('UPDATE cc_commands SET result=? WHERE request_id=?').run(JSON.stringify(value), row.request_id);
  }
  owner.db.exec('DROP TABLE cc_contracts; DROP TABLE cc_routing; DROP TABLE cc_manifests; DROP TABLE cc_payloads; DROP TABLE cc_recovery_checks; DROP TABLE cc_hold_rechecks; DROP TABLE cc_meta; DROP TABLE cc_schema;');
}

test('N0 migration preserves real v1 identities/account references, fences historical unknown input, and is restart-idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-governance-v1-')); const path = join(dir, 'db.sqlite');
  let owner: Store | undefined;
  try {
    const first = setup(path); owner = first.owner;
    first.store.saveAccount({ id: 'migration-account', name: 'Synthetic API reference', provider: 'codex', auth: 'api', apiKeyEnv: 'N0_SYNTHETIC_KEY', baseUrl: 'https://example.invalid' });
    first.store.saveMember({ ...first.store.members().find(m => m.id === 'codex')!, accountId: 'migration-account', model: 'synthetic-model' });
    const sent = first.store.send(first.conversation.id, { content: '@codex @claude 旧数据', requestId: 'old-message' });
    const batch = first.store.admitNext()!;
    const historical = batch.invocations.find(i => i.memberId === 'claude')!;
    alter(owner, 'cc_invocations', historical, i => { i.status = 'interrupted'; i.dispatchStarted = true; i.nativeSessionId = 'legacy-session'; });
    alter(owner, 'cc_responses', first.store.response(historical.responseId), r => { r.status = 'interrupted'; r.content = '旧版本保存的中断'; });
    const ids = snapshotIds(first.store, first.conversation.id);
    downgradeFixture(owner); owner.close(); owner = undefined;

    owner = new Store(path); const migrated = new CollaborationStore(owner, { workspace: '/synthetic/governance-workspace' });
    assert.deepEqual(snapshotIds(migrated, first.conversation.id), ids);
    assert.equal((owner.db.prepare('SELECT version FROM cc_schema').get() as { version: number }).version, 7);
    assert.equal(migrated.accounts().find(a => a.id === 'migration-account')?.apiKeyEnv, 'N0_SYNTHETIC_KEY');
    assert.equal(migrated.invocation(historical.id).nativeSessionId, 'legacy-session');
    assert.equal(migrated.invocation(historical.id).interruptionCause, 'legacy_unknown');
    assert.equal(migrated.invocation(historical.id).recoveryState, 'pending');
    assert.equal(migrated.detail(first.conversation.id).inputManifests?.length, 0);
    assert.throws(() => migrated.prepareInput(historical.id), { code: 'input_not_captured' });
    assert.ok(migrated.detail(first.conversation.id).messages.every(m => Number.isSafeInteger(m.sequence)));
    assert.ok(migrated.detail(first.conversation.id).contracts!.every(c => c.behaviorVersion === '0.2.1' && c.snapshotOrigin === 'legacy_reconstructed'));
    const replay = migrated.send(first.conversation.id, { content: '@codex @claude 旧数据', requestId: 'old-message' });
    assert.equal(replay.source.id, sent.source.id); assert.equal(replay.replayed, true);
    const prepared = migrated.invocations().find(i => i.status === 'prepared')!;
    const originalInput = migrated.prepareInput(prepared.id);
    const contractIds = migrated.detail(first.conversation.id).contracts!.map(c => c.id);
    const metadata = JSON.stringify(migrated.detail(first.conversation.id).contracts);
    assert.match(metadata, /N0_SYNTHETIC_KEY/);
    assert.doesNotMatch(metadata, /"apiKey"\s*:|"secret"\s*:|"password"\s*:/);
    owner.close(); owner = undefined;

    owner = new Store(path); const reopened = new CollaborationStore(owner, { workspace: '/synthetic/changed-workspace' });
    assert.deepEqual(reopened.detail(first.conversation.id).contracts!.map(c => c.id), contractIds);
    assert.deepEqual(reopened.prepareInput(prepared.id), originalInput);
    assert.deepEqual(snapshotIds(reopened, first.conversation.id), ids);
  } finally { owner?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('N0 admission freezes member/account/roster/history while later configuration applies only to new executions', () => {
  const h = setup(); try {
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, instructions: 'FROZEN_REVIEW_ROLE' });
    h.store.send(h.conversation.id, { content: '@codex 用户约束 OLD_PUBLIC_CONSTRAINT', requestId: 'constraint' });
    const first = h.store.admitNext()!; finish(h.store, first.invocations[0]!.id, 'OLD_PUBLIC_RESULT');
    h.store.send(h.conversation.id, { content: '@claude 精确请求 REQUEST_BEFORE_CHANGE', requestId: 'next' });
    const next = h.store.admitNext()!.invocations[0]!;
    const frozen = h.store.contract(next.id);
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, instructions: 'NEW_REVIEW_ROLE', name: '新的名字' });
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'codex')!, instructions: 'NEW_PEER_ROLE' });
    h.store.saveAccount({ ...h.store.accounts().find(a => a.id === 'claude-cli')!, name: 'NEW_ACCOUNT_NAME' });
    h.store.send(h.conversation.id, { content: 'LATER_USER_MESSAGE', requestId: 'later' });
    const oldHistory = h.store.detail(h.conversation.id).messages.find(m => m.content.includes('OLD_PUBLIC_CONSTRAINT'))!;
    alter(h.owner, 'cc_messages', oldHistory, m => { m.content = 'MUTATED_HISTORY'; });
    const prepared = h.store.prepareInput(next.id);
    assert.deepEqual(h.store.contract(next.id), frozen);
    assert.match(prepared.prompt, /FROZEN_REVIEW_ROLE|OLD_PUBLIC_CONSTRAINT/);
    assert.match(prepared.prompt, /OLD_PUBLIC_CONSTRAINT/); assert.match(prepared.prompt, /OLD_PUBLIC_RESULT/); assert.match(prepared.prompt, /REQUEST_BEFORE_CHANGE/);
    assert.doesNotMatch(prepared.prompt, /NEW_REVIEW_ROLE|NEW_PEER_ROLE|NEW_ACCOUNT_NAME|LATER_USER_MESSAGE|MUTATED_HISTORY/);
    assert.notEqual(h.store.accountFor(next.id).name, 'NEW_ACCOUNT_NAME');
    assert.equal(prepared.manifest.contractId, frozen.id);
    assert.equal(prepared.manifest.historyCutoff, frozen.historyCutoff);
    assert.equal(h.store.startInvocation(next.id).dispatchStarted, true);
    assert.deepEqual(h.store.prepareInput(next.id), prepared, 'Started executions use the captured input, never rebuild current history.');
  } finally { h.owner.close(); }
});

test('N0 unsupported frozen behavior/context policy and input tampering block before dispatch', () => {
  for (const field of ['behaviorVersion', 'contextPolicyVersion'] as const) {
    const h = setup(); try {
      h.store.send(h.conversation.id, { content: '版本测试', requestId: 'version' }); const i = h.store.admitNext()!.invocations[0]!;
      alter(h.owner, 'cc_contracts', h.store.contract(i.id), c => { c[field] = 'future-unsupported-v99'; });
      assert.throws(() => h.store.startInvocation(i.id), { code: 'contract_not_supported', status: 503 });
      assert.equal(h.store.invocation(i.id).dispatchStarted, false); assert.equal(h.store.invocation(i.id).status, 'prepared');
      assert.equal(h.store.detail(h.conversation.id).inputManifests?.length, 0);
    } finally { h.owner.close(); }
  }
  const h = setup(); try {
    h.store.send(h.conversation.id, { content: '输入篡改测试', requestId: 'tamper' }); const i = h.store.admitNext()!.invocations[0]!;
    const input = h.store.prepareInput(i.id);
    h.owner.db.prepare('UPDATE cc_payloads SET prompt=? WHERE id=?').run('MODIFIED_PLATFORM_PAYLOAD', input.manifest.payloadRef);
    assert.throws(() => h.store.startInvocation(i.id), { code: 'input_digest_conflict' });
    assert.equal(h.store.invocation(i.id).dispatchStarted, false);
  } finally { h.owner.close(); }
});

test('N0 source mutation before assembly fails and rollback leaves no synthetic captured input', () => {
  const h = setup(); try {
    const sent = h.store.send(h.conversation.id, { content: '原始准确请求', requestId: 'original' }); const i = h.store.admitNext()!.invocations[0]!;
    alter(h.owner, 'cc_sources', sent.source, s => { s.content = '已修改请求'; s.revision++; });
    assert.throws(() => h.store.prepareInput(i.id), { code: 'inputs_changed' });
    assert.equal(h.store.detail(h.conversation.id).inputManifests?.length, 0);
    assert.equal(h.store.invocation(i.id).dispatchStarted, false);
  } finally { h.owner.close(); }
});

test('N0 a captured input is revalidated against source and input revisions immediately before dispatch', () => {
  for (const changed of ['source', 'response'] as const) {
    const h = setup(); try {
      const sent = h.store.send(h.conversation.id, { content: '捕获后发送前的准确请求', requestId: 'captured' }); const i = h.store.admitNext()!.invocations[0]!;
      const captured = h.store.prepareInput(i.id);
      if (changed === 'source') alter(h.owner, 'cc_sources', sent.source, s => { s.content = '已失效的来源版本'; s.revision++; });
      else alter(h.owner, 'cc_responses', h.store.response(i.responseId), r => { r.inputRevision++; });
      assert.throws(() => h.store.startInvocation(i.id), { code: 'inputs_changed' });
      assert.equal(h.store.invocation(i.id).dispatchStarted, false);
      assert.equal(h.store.input(i.id)!.manifest.id, captured.manifest.id, 'Do not silently overwrite the previously captured audit record.');
    } finally { h.owner.close(); }
  }
});

test('N1 shared batch cutoff keeps early sibling output out of the later member input and retains public user constraints', () => {
  const h = setup(); try {
    h.store.send(h.conversation.id, { content: '@codex 公共用户约束 KEEP_PUBLIC_REQUIREMENT', requestId: 'constraint' });
    finish(h.store, h.store.admitNext()!.invocations[0]!.id, 'Prior completed reply');
    h.store.send(h.conversation.id, { content: '@codex @claude 分别核查', requestId: 'parallel' }); const batch = h.store.admitNext()!;
    assert.equal(batch.batch.mode, 'parallel');
    const first = batch.invocations.find(i => i.memberId === 'codex')!; const second = batch.invocations.find(i => i.memberId === 'claude')!;
    finish(h.store, first.id, 'EARLY_SIBLING_CONCLUSION');
    const input = h.store.prepareInput(second.id);
    assert.match(input.prompt, /KEEP_PUBLIC_REQUIREMENT/);
    assert.doesNotMatch(input.prompt, /EARLY_SIBLING_CONCLUSION/);
    assert.equal(h.store.contract(first.id).historyCutoff, h.store.contract(second.id).historyCutoff);
    assert.ok(h.store.contract(second.id).historyMessageIds.every(id => h.store.detail(h.conversation.id).messages.find(m => m.id === id)!.sequence! <= batch.batch.historyCutoff!));
  } finally { h.owner.close(); }
});

test('N1 preview/send share resolution, replay preserves old identity after history changes, and rename preserves historical mention', () => {
  const h = setup(); try {
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, name: '旧评审名' });
    const preview = h.store.previewRoute(h.conversation.id, '@旧评审名 请处理');
    const sent = h.store.send(h.conversation.id, { content: '@旧评审名 请处理', requestId: 'named' });
    assert.deepEqual(sent.routing?.targets, preview.targets); assert.equal(sent.routing?.reason, preview.reason);
    assert.equal(sent.routing?.historyCursor, preview.historyCursor); assert.equal(sent.routing?.configurationRevision, preview.configurationRevision);
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, name: '完全不同的新名称' });
    assert.deepEqual(h.store.previewRoute(h.conversation.id, '继续').targets, ['claude']);
    const following = h.store.send(h.conversation.id, { content: '继续', requestId: 'follow' });
    h.store.send(h.conversation.id, { content: '@codex 新方向', requestId: 'changed-history' });
    assert.deepEqual(h.store.previewRoute(h.conversation.id, '继续').targets, ['codex']);
    const replay = h.store.send(h.conversation.id, { content: '继续', requestId: 'follow' });
    assert.equal(replay.source.id, following.source.id); assert.deepEqual(replay.routing, following.routing);
    assert.deepEqual(replay.source.requestedTargets, ['claude']); assert.equal(replay.replayed, true);
  } finally { h.owner.close(); }
});

test('N1 pending and held public background freezes original delivery responsibility without consuming or merging it', () => {
  const h = setup(); try {
    h.store.saveMember({ id: 'third', name: '第三成员', instructions: '第三成员职责', carrier: 'codex-app-server', accountId: 'codex-cli', enabled: true });
    h.store.updateConversation(h.conversation.id, { memberIds: ['codex', 'claude', 'third'], defaultMemberId: 'codex' });
    const activeSource = h.store.send(h.conversation.id, { content: '@codex 正在处理的公开请求', requestId: 'active' }).source;
    const active = h.store.admitNext()!.invocations[0]!; h.store.startInvocation(active.id);
    const pendingSource = h.store.send(h.conversation.id, { content: '@codex PENDING_PUBLIC_CONSTRAINT', requestId: 'pending' }).source;
    const heldSource = h.store.send(h.conversation.id, { content: '@third HELD_PUBLIC_CONSTRAINT', requestId: 'held' }).source;
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'third')!, enabled: false });
    const currentSource = h.store.send(h.conversation.id, { content: '@claude 只处理本轮独立请求', requestId: 'current' }).source;
    const current = h.store.admitNext()!.invocations[0]!; assert.equal(current.memberId, 'claude');
    const frozen = h.store.contract(current.id);
    const pending = frozen.historySourceSnapshots!.find(s => s.sourceId === pendingSource.id)!;
    const held = frozen.historySourceSnapshots!.find(s => s.sourceId === heldSource.id)!;
    const previous = frozen.historySourceSnapshots!.find(s => s.sourceId === activeSource.id)!;
    assert.equal(pending.sourceRevision, pendingSource.revision); assert.deepEqual(pending.requestedTargets, ['codex']);
    assert.equal(held.sourceRevision, heldSource.revision); assert.deepEqual(held.requestedTargets, ['third']);
    assert.equal(pending.visibilityOnly, true); assert.equal(held.visibilityOnly, true);
    assert.deepEqual(pending.deliveries.map(d => d.status), ['pending']); assert.deepEqual(held.deliveries.map(d => d.status), ['held']);
    assert.deepEqual(pending.deliveries[0]!.consumptions, []); assert.deepEqual(held.deliveries[0]!.consumptions, []);
    assert.equal(previous.deliveries[0]!.status, 'consumed'); assert.equal(previous.deliveries[0]!.responseId, active.responseId);
    assert.equal(previous.deliveries[0]!.consumptions[0]!.responseId, active.responseId);
    const beforeAssembly = h.store.detail(h.conversation.id);
    assert.equal(beforeAssembly.consumptions.filter(c => [pendingSource.id, heldSource.id].includes(c.sourceId)).length, 0);

    // Change the live responsibility before the first prompt is assembled: it must still render admission-time facts.
    h.store.recordEvidence(active.id, { kind: 'process_exit', detail: { code: 0, confirmed: true } });
    h.store.finish(active.id, 'succeeded', '先前请求已结束');
    const pendingRun = h.store.admitNext()!.invocations[0]!; assert.equal(pendingRun.memberId, 'codex');
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'third')!, enabled: true });
    const heldDelivery = h.store.detail(h.conversation.id).deliveries.find(d => d.sourceId === heldSource.id)!;
    h.store.recheckDelivery(heldDelivery.id, { requestId: 'recheck-held', expectedDeliveryRevision: heldDelivery.revision, expectedSourceRevision: heldSource.revision });
    const heldRun = h.store.admitNext()!.invocations[0]!; assert.equal(heldRun.memberId, 'third');
    const live = h.store.detail(h.conversation.id);
    assert.ok(live.deliveries.filter(d => [pendingSource.id, heldSource.id].includes(d.sourceId)).every(d => d.status === 'consumed'));
    const input = h.store.prepareInput(current.id);
    assert.match(input.prompt, /PENDING_PUBLIC_CONSTRAINT/); assert.match(input.prompt, /HELD_PUBLIC_CONSTRAINT/);
    assert.match(input.prompt, /pending\/held 仍由原投递负责/); assert.match(input.prompt, /不主动合并背景待办/);
    for (const snapshot of [pending, held, previous]) {
      const item = input.manifest.items.find(item => item.sourceResponsibility?.sourceId === snapshot.sourceId)!;
      assert.equal(item.kind, 'background'); assert.equal(item.representation, 'full');
      assert.equal(item.visibilityOnly, true); assert.equal(item.responsibilityEvidence, 'frozen');
      assert.deepEqual(item.sourceResponsibility, snapshot);
      const line = input.prompt.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(value => value?.sourceResponsibility?.sourceId === snapshot.sourceId);
      assert.deepEqual(line.sourceResponsibility, snapshot);
    }
    const after = h.store.detail(h.conversation.id);
    assert.deepEqual(after.sources, live.sources); assert.deepEqual(after.deliveries, live.deliveries); assert.deepEqual(after.consumptions, live.consumptions);
    assert.deepEqual(h.store.response(current.responseId).inputSourceIds, [currentSource.id]);
    assert.deepEqual(h.store.contract(current.id), frozen);
    finish(h.store, pendingRun.id, 'LATER_PENDING_SOURCE_RESULT');
    assert.deepEqual(h.store.prepareInput(current.id), input);
    assert.doesNotMatch(input.prompt, /LATER_PENDING_SOURCE_RESULT/);
  } finally { h.owner.close(); }
});

test('N0 configuration changes survive a real file restart while prepared uses its frozen contract and dispatched unknown is never resent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-governance-frozen-restart-')); const path = join(dir, 'db.sqlite');
  let owner: Store | undefined; let engine: CollaborationEngine | undefined;
  try {
    const h = setup(path); owner = h.owner;
    h.store.saveAccount({ id: 'frozen-claude-api', provider: 'claude', auth: 'api', name: 'OLD_FROZEN_ACCOUNT', apiKeyEnv: 'N0_RESTART_SYNTHETIC_KEY', baseUrl: 'https://old.example.invalid' });
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, accountId: 'frozen-claude-api', instructions: 'OLD_FROZEN_MEMBER_RULE', model: 'old-fixture-model' });
    h.store.send(h.conversation.id, { content: '@codex @claude FROZEN_PARALLEL_REQUEST', requestId: 'parallel-restart' });
    const batch = h.store.admitNext()!;
    const dispatched = batch.invocations.find(i => i.memberId === 'codex')!;
    const prepared = batch.invocations.find(i => i.memberId === 'claude')!;
    h.store.startInvocation(dispatched.id);
    h.store.recordEvidence(dispatched.id, { kind: 'accepted', detail: { nativeSessionId: 'exact-old-session', nativeTurnId: 'exact-old-turn' } });
    const frozen = h.store.contract(prepared.id); const frozenDispatched = h.store.contract(dispatched.id);
    assert.equal(h.store.input(prepared.id), undefined, 'Prepared input must be first assembled after reopening, not merely read from an old manifest.');
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'claude')!, name: 'NEW_MEMBER_NAME', instructions: 'NEW_MEMBER_RULE', model: 'new-fixture-model' });
    h.store.saveMember({ ...h.store.members().find(m => m.id === 'codex')!, instructions: 'NEW_PEER_RULE' });
    h.store.saveAccount({ ...h.store.accounts().find(a => a.id === 'frozen-claude-api')!, name: 'NEW_ACCOUNT_NAME', apiKeyEnv: 'N0_CHANGED_SYNTHETIC_KEY', baseUrl: 'https://new.example.invalid' });
    h.store.updateConversation(h.conversation.id, { memberIds: ['codex', 'claude'], defaultMemberId: 'claude', preferredMemberIds: ['claude'], routingMode: 'concierge' });
    h.store.send(h.conversation.id, { content: '@codex LATER_QUEUED_REQUEST', requestId: 'waiting-restart' });
    const ids = snapshotIds(h.store, h.conversation.id);
    owner.close(); owner = undefined;

    owner = new Store(path); const reopened = new CollaborationStore(owner, { workspace: '/synthetic/new-workspace' });
    assert.equal(reopened.members().find(m => m.id === 'claude')!.model, 'new-fixture-model');
    assert.equal(reopened.accounts().find(a => a.id === 'frozen-claude-api')!.name, 'NEW_ACCOUNT_NAME');
    assert.deepEqual(reopened.contract(prepared.id), frozen); assert.deepEqual(reopened.contract(dispatched.id), frozenDispatched);
    const calls: RuntimeRequest[] = [];
    engine = new CollaborationEngine(reopened, { probe: async () => [], invoke: async request => {
      calls.push(request);
      request.onEvent({ kind: 'accepted', detail: { nativeSessionId: 'fixture-prepared-session', nativeTurnId: 'fixture-prepared-turn' } });
      request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true } });
      return { text: 'prepared fixture completed', continuity: 'fresh' };
    } }, { workspace: '/synthetic/new-workspace' });
    engine.start();
    const until = Date.now() + 3000;
    while (reopened.invocation(prepared.id).status !== 'succeeded') {
      if (Date.now() > until) throw new Error('Prepared invocation did not complete after restart.');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(calls.length, 1); assert.equal(calls[0]!.invocationId, prepared.id);
    assert.deepEqual(calls[0]!.member, frozen.memberSnapshot); assert.deepEqual(calls[0]!.account, frozen.accountMetadataSnapshot);
    assert.equal(calls[0]!.cwd, frozen.workspaceScope);
    assert.match(calls[0]!.prompt, /OLD_FROZEN_MEMBER_RULE/); assert.match(calls[0]!.prompt, /FROZEN_PARALLEL_REQUEST/);
    assert.doesNotMatch(calls[0]!.prompt, /NEW_MEMBER_RULE|NEW_PEER_RULE|NEW_ACCOUNT_NAME|LATER_QUEUED_REQUEST/);
    assert.equal(reopened.invocation(dispatched.id).status, 'interrupted');
    assert.equal(reopened.invocation(dispatched.id).interruptionCause, 'service_restart');
    assert.equal(reopened.invocation(dispatched.id).teardown, 'unknown');
    assert.equal(reopened.invocation(dispatched.id).dispatchStarted, true);
    assert.equal(reopened.admitNext(), undefined);
    assert.deepEqual(reopened.invocations().map(i => i.id), ids.invocations);
    assert.equal(reopened.detail(h.conversation.id).deliveries.filter(d => d.status === 'pending').length, 1);
    assert.deepEqual(reopened.contract(prepared.id), frozen);
    await engine.stop(); engine = undefined;
  } finally { await engine?.stop(); owner?.close(); await rm(dir, { recursive: true, force: true }); }
});
