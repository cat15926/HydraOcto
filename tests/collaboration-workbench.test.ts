import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { verifyWorkspace } from '../server/collaboration/workbench.js';
import { executeTool } from '../server/collaboration/runtime-common.js';
import type { AccountObservation, CollaborationAccount, RuntimeRequest } from '../shared/collaboration.js';
const rid = () => randomUUID();
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'n7-state-')); const workspace = join(root, 'project'); mkdirSync(workspace);
  const db = join(root, 'private', 'state.sqlite'), owner = new Store(db), store = new CollaborationStore(owner, { workspace, artifactDir: join(root, 'private', 'artifacts') });
  const c = store.create({ title: 'N7', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: rid() }).conversation;
  return { root, workspace, db, owner, store, w: store.workbench, c, close() { owner.close(); rmSync(root, { recursive: true, force: true }); } };
}
function observe(store: CollaborationStore, id: string, models = ['m1', 'm2']) {
  const { account, ticket } = store.workbench.beginProbe(id);
  store.workbench.finishProbe(account, ticket, observation(account, models));
}
const observation = (a: CollaborationAccount, models = ['m1']): AccountObservation => ({ accountId: a.id, accountRevision: a.revision ?? 1, checkedAt: new Date().toISOString(), configured: true, installed: true, connection: 'reachable', identity: { state: 'unknown' }, models: models.map(id => ({ id, name: id, efforts: ['low', 'high'] })), catalogSource: 'synthetic-test-only', quota: { state: 'unknown' } });
const upload = (h: ReturnType<typeof setup>, content: string, cid = h.c.id) => h.w.upload(cid, { requestId: rid(), name: 'data.txt', base64: Buffer.from(content).toString('base64'), mediaType: 'text/plain' }).result;
function settle(h: ReturnType<typeof setup>, id: string) { h.store.startInvocation(id); h.store.recordEvidence(id, { kind: 'accepted', detail: {} }); h.store.recordEvidence(id, { kind: 'process_exit', detail: { confirmed: true } }); h.store.finish(id, 'succeeded', 'done'); }

test('N7: actual attachment-only input and reply snapshots enter prompts; @ in attachment/reference never routes', () => {
  const h = setup(); try {
    const a = upload(h, 'UNIQUE_FILE_PAYLOAD @claude');
    const input = { content: '', attachmentIds: [a.id], requestId: rid() };
    const s = h.store.send(h.c.id, input).source;
    assert.deepEqual(s.requestedTargets, ['codex']); assert.match(s.content, /UNIQUE_FILE_PAYLOAD/);
    assert.equal(h.store.send(h.c.id, input).source.id, s.id);
    const i = h.store.admitNext()!.invocations[0]!; const prompt = h.store.prepareInput(i.id).prompt;
    assert.ok(prompt.includes('UNIQUE_FILE_PAYLOAD')); assert.ok(prompt.includes(a.digest));
    settle(h, i.id);
    const message = h.store.detail(h.c.id).messages.find(m => m.sourceId === s.id)!;
    assert.equal(message.content, ''); assert.deepEqual(message.attachmentIds, [a.id]);
    h.store.send(h.c.id, { content: '继续分析', replyTo: message.id, requestId: rid() });
    const next = h.store.admitNext()!.invocations[0]!;
    assert.ok(h.store.prepareInput(next.id).prompt.includes('UNIQUE_FILE_PAYLOAD'), 'fresh invocation retains actual attachment context');
    assert.deepEqual(h.store.response(next.responseId).inputSourceIds.length, 1);
  } finally { h.close(); }
});
test('N7: upload and send reject binary, false MIME, invalid UTF8, path names, oversize and foreign/corrupted material atomically', () => {
  const h = setup(); try {
    const base = { requestId: rid(), name: 'x.txt', mediaType: 'text/plain', base64: Buffer.from('ok').toString('base64') };
    for (const input of [{ ...base, base64: 'not-base64' }, { ...base, name: '../x.txt' }, { ...base, mediaType: 'image/png' }, { ...base, base64: Buffer.from([0xff, 0xfe]).toString('base64') }, { ...base, base64: Buffer.from([0]).toString('base64') }, { ...base, base64: Buffer.alloc(32769, 65).toString('base64') }]) assert.throws(() => h.w.upload(h.c.id, input));
    assert.equal(h.w.attachments(h.c.id).length, 0);
    const foreign = h.store.create({ title: 'other', memberIds: ['codex'], defaultMemberId: 'codex', requestId: rid() }).conversation;
    const a = upload(h, 'foreign', foreign.id);
    assert.throws(() => h.store.send(h.c.id, { content: 'x', attachmentIds: [a.id], requestId: rid() }), /当前会话/);
    h.store.send(foreign.id, { content: '@claude reference', requestId: rid() });
    const m = h.store.detail(foreign.id).messages[0]!;
    assert.throws(() => h.store.send(h.c.id, { content: 'x', replyTo: m.id, requestId: rid() }), /当前会话/);
    const b = upload(h, 'exact'); h.owner.db.prepare('UPDATE cc_attachment_contents SET content=? WHERE attachment_id=?').run('modified', b.id);
    assert.throws(() => h.store.send(h.c.id, { content: '', attachmentIds: [b.id], requestId: rid() }), /摘要/);
    assert.equal(h.store.detail(h.c.id).sources.length, 0);
    const x = upload(h, 'x'.repeat(30000)), y = upload(h, 'y'.repeat(30000));
    assert.throws(() => h.store.send(h.c.id, { content: '', attachmentIds: [x.id, y.id], requestId: rid() }), /48 KiB/);
  } finally { h.close(); }
});
test('N7: conversation organization CAS, archive blocks new messages without changing pending responsibility, idempotent restore', () => {
  const h = setup(); try {
    const s = h.store.send(h.c.id, { content: 'pending', requestId: rid() }).source;
    const input = { requestId: rid(), expectedRevision: 1, action: 'archive' };
    assert.ok(h.w.organize(h.c.id, input).result.archivedAt); assert.equal(h.w.organize(h.c.id, input).replayed, true);
    assert.throws(() => h.w.organize(h.c.id, { ...input, requestId: rid(), action: 'rename', title: 'stale' }), /已变化/);
    assert.throws(() => h.store.send(h.c.id, { content: 'new', requestId: rid() }), /恢复/);
    assert.equal(h.store.detail(h.c.id).deliveries[0]!.sourceId, s.id);
    h.w.organize(h.c.id, { expectedRevision: 2, requestId: rid(), action: 'restore' });
    h.w.organize(h.c.id, { expectedRevision: 3, requestId: rid(), action: 'pin' });
    const c = h.w.organize(h.c.id, { expectedRevision: 4, requestId: rid(), action: 'rename', title: 'renamed' }).result;
    assert.equal(c.title, 'renamed'); assert.equal(c.pinned, true); assert.equal(c.archivedAt, undefined);
  } finally { h.close(); }
});
test('N7: aliases route to stable member; rename/delete preserves history and frozen identity; alias reservation survives deletion', () => {
  const h = setup(); try {
    const member = h.store.members()[0]!;
    const saved = h.w.saveMember({ ...member, aliases: ['reviewer'], name: '评审员' }, 1, rid()).result;
    const source = h.store.send(h.c.id, { content: '@reviewer 请检查', requestId: rid() }).source;
    assert.deepEqual(source.requestedTargets, ['codex']);
    const run = h.store.admitNext()!.invocations[0]!;
    assert.throws(() => h.w.saveMember({ ...saved, name: 'stale' }, 1, rid()), /已变化/);
    h.w.remove('members', saved.id, { expectedRevision: saved.revision, requestId: rid() });
    assert.equal(h.store.invocation(run.id).member.name, '评审员');
    assert.equal(h.store.contract(run.id).memberSnapshot.enabled, true);
    assert.throws(() => h.store.saveMember({ ...h.store.members()[1]!, aliases: ['REVIEWER'] }), /冲突/);
    assert.throws(() => h.store.saveMember({ ...saved, aliases: ['all'] }), /删除/);
    assert.equal(h.store.detail(h.c.id).sources[0]!.requestedTargets[0], saved.id);
  } finally { h.close(); }
});
test('N7: default preview affects only followers, stale preview rejected, admitted runs freeze effective account/model/effort', () => {
  const h = setup(); try {
    for (const id of ['a1', 'a2']) { h.store.saveAccount({ id, name: id, provider: 'codex', auth: 'api', apiKeyEnv: 'N7_TEST_KEY', baseUrl: 'https://example.invalid/v1' }); observe(h.store, id); }
    let p = h.w.previewDefault({ carrier: 'codex-app-server', accountId: 'a1', model: 'm1', effort: 'low' }); h.w.applyPreview({ previewId: p.id, requestId: rid() });
    const member = h.store.members()[0]!; h.w.saveMember({ ...member, accountId: 'a1', accountBinding: 'follow', modelBinding: 'follow' }, member.revision, rid());
    h.store.saveMember({ ...member, id: 'fixed', name: 'fixed', accountId: 'a1', model: 'm1', accountBinding: 'override' });
    h.store.send(h.c.id, { content: 'first', requestId: rid() }); const first = h.store.admitNext()!.invocations[0]!;
    p = h.w.previewDefault({ carrier: 'codex-app-server', accountId: 'a2', model: 'm2', effort: 'high' });
    assert.deepEqual(p.affectedMemberIds, ['codex']); assert.deepEqual(p.unaffectedMemberIds, ['fixed']);
    h.store.saveAccount({ ...h.w.account('a2'), name: 'changed' });
    assert.throws(() => h.w.applyPreview({ previewId: p.id, requestId: rid() }), /失效/);
    observe(h.store, 'a2'); p = h.w.previewDefault({ carrier: 'codex-app-server', accountId: 'a2', model: 'm2', effort: 'high' });
    const apply = { previewId: p.id, requestId: rid() }; h.w.applyPreview(apply); assert.equal(h.w.applyPreview(apply).replayed, true);
    assert.equal(first.member.accountId, 'a1'); assert.equal(h.store.accountFor(first.id).id, 'a1'); assert.equal(first.member.effort, 'low');
    assert.equal(h.w.resolveMember(h.store.members().find(m => m.id === 'fixed')!).accountId, 'a1');
    settle(h, first.id); h.store.send(h.c.id, { content: 'next', requestId: rid() }); const next = h.store.admitNext()!.invocations[0]!;
    assert.equal(next.member.accountId, 'a2'); assert.equal(next.member.model, 'm2'); assert.equal(next.member.effort, 'high');
    assert.throws(() => h.w.remove('accounts', 'a1', { expectedRevision: 1, requestId: rid() }), /引用/);
  } finally { h.close(); }
});
test('N7: model/effort require actual selected-account catalog; latest probe wins and changed account rejects stale result', () => {
  const h = setup(); try {
    const m = h.store.members()[0]!;
    assert.throws(() => h.w.saveMember({ ...m, model: 'invented' }, m.revision, rid()), /目录/);
    const early = h.w.beginProbe(m.accountId), latest = h.w.beginProbe(m.accountId);
    assert.throws(() => h.w.finishProbe(early.account, early.ticket, observation(early.account)), /旧结果/);
    h.w.finishProbe(latest.account, latest.ticket, observation(latest.account));
    assert.throws(() => h.w.saveMember({ ...m, model: 'm1', effort: 'imaginary' }, m.revision, rid()), /强度/);
    const old = h.w.beginProbe(m.accountId); h.store.saveAccount({ ...old.account, name: 'new label' });
    assert.throws(() => h.w.finishProbe(old.account, old.ticket, observation(old.account)), /旧结果/);
    assert.deepEqual(h.w.observations().find(o => o.accountId === m.accountId)?.models, []);
    assert.equal(h.w.observations().find(o => o.accountId === m.accountId)?.identity.state, 'unknown');
  } finally { h.close(); }
});
test('N7: workspace preview grants no access; exact apply, idle constraint, stale revision and private root checks', () => {
  const h = setup(); try {
    const project = join(h.root, 'second'); mkdirSync(project);
    const p = h.w.previewWorkspace(h.c.id, { path: project });
    assert.equal(h.w.conversation(h.c.id).workspaceGrant, undefined);
    h.w.applyPreview({ previewId: p.id, requestId: rid() }, h.c.id);
    const g = h.w.conversation(h.c.id).workspaceGrant!; verifyWorkspace(g);
    assert.throws(() => h.w.previewWorkspace(h.c.id, { path: join(h.root, 'private') }), /私有/);
    assert.throws(() => h.w.previewWorkspace(h.c.id, { path: h.root }), /私有/);
    h.store.send(h.c.id, { content: 'work', requestId: rid() });
    assert.throws(() => h.w.previewWorkspace(h.c.id, { path: h.workspace }), /待投递/);
    const run = h.store.admitNext()!.invocations[0]!;
    assert.equal(h.store.contract(run.id).workspaceScope, realpathSync(project));
    assert.throws(() => h.w.previewWorkspace(h.c.id, { path: h.workspace }), /未释放/);
    settle(h, run.id);
    const stale = h.w.previewWorkspace(h.c.id, { path: h.workspace }); h.w.organize(h.c.id, { requestId: rid(), expectedRevision: 2, action: 'pin' });
    assert.throws(() => h.w.applyPreview({ previewId: stale.id, requestId: rid() }, h.c.id), /会话已变化/);
    renameSync(project, join(h.root, 'old')); mkdirSync(project); assert.throws(() => verifyWorkspace(g), /目录身份/);
  } finally { h.close(); }
});
test('N7: workspace tool rechecks directory grant on every read, including after successful earlier read', async () => {
  const h = setup(); try {
    writeFileSync(join(h.workspace, 'file.txt'), 'ORIGINAL'); const p = h.w.previewWorkspace(h.c.id, { path: h.workspace }); h.w.applyPreview({ previewId: p.id, requestId: rid() }, h.c.id);
    const r = { cwd: h.workspace, workspaceGrant: h.w.conversation(h.c.id).workspaceGrant, signal: new AbortController().signal, onEvent() {} } as unknown as RuntimeRequest;
    assert.equal(await executeTool(r, 'workspace_read', { path: 'file.txt' }, '1'), 'ORIGINAL');
    renameSync(h.workspace, join(h.root, 'old')); mkdirSync(h.workspace); writeFileSync(join(h.workspace, 'file.txt'), 'REPLACED');
    await assert.rejects(executeTool(r, 'workspace_read', { path: 'file.txt' }, '2'), /目录身份/);
  } finally { h.close(); }
});
test('N7: schema 6 upgrade keeps existing business JSON byte-for-byte and restores attachments/defaults on reopen', () => {
  const h = setup(); try {
    upload(h, 'persistent'); const before = h.owner.db.prepare('SELECT value FROM cc_conversations').all();
    h.owner.db.exec('UPDATE cc_schema SET version=6'); h.owner.close();
    const owner = new Store(h.db); try { const store = new CollaborationStore(owner, { workspace: h.workspace, artifactDir: join(h.root, 'private', 'artifacts') });
      assert.deepEqual(owner.db.prepare('SELECT value FROM cc_conversations').all(), before);
      assert.equal((owner.db.prepare('SELECT version FROM cc_schema').get() as any).version, 7);
      assert.equal(store.workbench.attachmentContent(store.workbench.attachments(h.c.id)[0]!.id).content, 'persistent');
    } finally { owner.close(); }
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test('N7: follow binding releases the obsolete account reference; default references prevent protocol changes even without members', () => {
  const h = setup(); try {
    const first = h.store.saveAccount({ id: 'first', name: 'first', provider: 'codex', auth: 'cli' });
    const second = h.store.saveAccount({ id: 'second', name: 'second', provider: 'codex', auth: 'cli' });
    let p = h.w.previewDefault({ carrier: 'codex-app-server', accountId: first.id }); h.w.applyPreview({ previewId: p.id, requestId: rid() });
    const m = h.store.members()[0]!; h.w.saveMember({ ...m, accountId: first.id, accountBinding: 'follow' }, m.revision, rid());
    p = h.w.previewDefault({ carrier: 'codex-app-server', accountId: second.id }); h.w.applyPreview({ previewId: p.id, requestId: rid() });
    assert.ok(h.w.remove('accounts', first.id, { requestId: rid(), expectedRevision: first.revision }).result.deletedAt);
    assert.equal(h.w.resolveMember(h.store.members()[0]!).accountId, second.id);
    h.w.remove('members', m.id, { requestId: rid(), expectedRevision: h.store.members()[0]!.revision });
    assert.throws(() => h.store.saveAccount({ ...second, provider: 'claude' }), /Referenced account/);
  } finally { h.close(); }
});
