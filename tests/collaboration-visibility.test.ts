import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { textDigest } from '../server/collaboration/visibility.js';
import { sessionFingerprint } from '../server/collaboration/continuity.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import type { ConversationMessage, MessageExcerpt } from '../shared/collaboration.js';
const rid = () => randomUUID();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'n8-visibility-')), workspace = join(root, 'project'); mkdirSync(workspace);
  const db = join(root, 'private', 'state.sqlite'), owner = new Store(db), store = new CollaborationStore(owner, { workspace, artifactDir: join(root, 'private', 'artifacts') });
  const c = store.create({ title: 'N8 project', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: rid() }).conversation;
  return { root, workspace, db, owner, store, c, close() { owner.close(); rmSync(root, { recursive: true, force: true }); } };
}
function start(h: ReturnType<typeof fixture>) { const i = h.store.admitNext()!.invocations[0]!; h.store.startInvocation(i.id); h.store.recordEvidence(i.id, { kind: 'accepted', detail: {} }); return i; }
function end(h: ReturnType<typeof fixture>, id: string, content = 'done') { h.store.recordEvidence(id, { kind: 'process_exit', detail: { confirmed: true } }); h.store.finish(id, 'succeeded', content); }
function excerpt(m: ConversationMessage, start = 0, end = m.content.length): MessageExcerpt { return { messageId: m.id, revision: m.revision ?? 1, digest: textDigest(m.content), start, end }; }

test('N8: private delivery, replies, input audit, public follow-up and native fingerprints enforce independent scopes', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'PRIVATE_RANDOM_X @claude', privateTo: ['codex'], requestId: rid() }); const first = start(h);
    assert.equal(first.memberId, 'codex'); assert.match(h.store.prompt(first.id), /PRIVATE_RANDOM_X/); end(h, first.id, 'PRIVATE_REPLY_X\n@claude please inspect');
    assert.equal(h.store.detail(h.c.id).sources.length, 1, 'private final mention cannot create public work');
    assert.ok(h.store.visibility.view(h.c.id, 'codex').messages.some(m => m.content.includes('PRIVATE_REPLY_X')));
    const unauthorized = JSON.stringify(h.store.visibility.view(h.c.id, 'claude')); assert.equal(unauthorized.includes('PRIVATE_'), false);
    assert.equal(h.store.visibility.export(h.c.id, 'claude').messages.length, 0);
    const route = h.store.previewRoute(h.c.id, '继续'); assert.deepEqual(route.targets, ['codex'], 'private @claude does not affect public routing');
    h.store.send(h.c.id, { content: '@codex public follow-up', requestId: rid() }); const second = start(h);
    assert.equal(h.store.prompt(second.id).includes('PRIVATE_RANDOM_X'), false); assert.equal(h.store.prompt(second.id).includes('PRIVATE_REPLY_X'), false);
    const identity = { supported: true, fingerprint: 'same', reason: 'test' };
    assert.notEqual(sessionFingerprint(h.store.contract(first.id), identity), sessionFingerprint(h.store.contract(second.id), identity));
    const result = await h.store.memory.search({ query: 'PRIVATE_', invocationId: second.id }); assert.equal(result.hits.length, 0);
    end(h, second.id);
    h.store.send(h.c.id, { content: '@claude public', requestId: rid() }); const third = start(h); assert.equal(h.store.prompt(third.id).includes('PRIVATE_'), false); end(h, third.id);
  } finally { h.close(); }
});

test('N8: pending reads and activity append never cross scopes; private tools cannot publish tasks, artifacts, groups or A2A', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'private', privateTo: ['codex'], requestId: rid() }); const i = start(h);
    const pub = h.store.send(h.c.id, { content: 'PUBLIC_OTHER', requestId: rid() }).source;
    const same = h.store.send(h.c.id, { content: 'PRIVATE_SECOND', privateTo: ['codex'], requestId: rid(), deliveryMode: 'next_turn' }).source;
    assert.equal(h.store.detail(h.c.id).deliveries.find(d => d.sourceId === pub.id)!.continuation, undefined);
    assert.deepEqual(h.store.cooperation.pending(i.id).map(s => s.id), [same.id]);
    assert.throws(() => h.store.cooperation.read(i.id, { sourceIds: [pub.id] }, rid()));
    h.store.cooperation.read(i.id, { sourceIds: [same.id] }, rid());
    assert.deepEqual(h.store.response(i.responseId).inputSourceIds.length, 2);
    for (const tool of ['collaboration_request', 'multi_mention', 'task_create', 'artifact_propose']) assert.throws(() => h.store.visibility.assertTool(i.id, tool), /私聊/);
    assert.throws(() => h.store.requestCollaboration(i.id, rid(), { targets: ['claude'], content: 'PRIVATE' }), /私聊/);
    assert.throws(() => h.store.tasks.create(h.c.id, { requestId: rid(), title: 'PRIVATE', description: '' }, i.id), /私聊/);
    assert.throws(() => h.store.cooperation.createGroup(h.c.id, { requestId: rid(), targets: ['claude', 'codex'], question: 'PRIVATE' }, i.id), /私聊/);
    const tools = runtimeTools({ toolPolicyVersion: 'visibility-memory-v1', visibility: h.store.contract(i.id).visibility }).map(t => t.name);
    assert.ok(tools.includes('memory_read')); assert.ok(tools.includes('user_question')); assert.equal(tools.includes('artifact_propose'), false); end(h, i.id);
  } finally { h.close(); }
});

test('N8: public reply and attachment reuse cannot widen private material; private native questions remain usable', () => {
  const h = fixture(); try {
    const file = h.store.workbench.upload(h.c.id, { name: 'private.txt', base64: Buffer.from('FILE_PRIVATE').toString('base64'), requestId: rid() }).result;
    h.store.send(h.c.id, { content: 'SECRET', privateTo: ['codex'], attachmentIds: [file.id], requestId: rid() });
    const m = h.store.detail(h.c.id).messages[0]!;
    assert.throws(() => h.store.send(h.c.id, { content: 'public quote', replyTo: m.id, requestId: rid() }), /引用不能公开/);
    assert.throws(() => h.store.send(h.c.id, { content: 'public file', attachmentIds: [file.id], requestId: rid() }), /私密附件/);
    const i = start(h);
    const q = h.store.interactions.create(i.id, { providerRequestId: rid(), kind: 'question', operation: 'user_question', questions: [{ id: 'q', question: 'Private question?' }], payload: {} }, 'platform');
    assert.equal(q.state, 'pending'); h.store.interactions.answer(q.id, { requestId: rid(), expectedRevision: q.revision, payloadDigest: q.payloadDigest, answers: { q: 'yes' } }); end(h, i.id);
  } finally { h.close(); }
});

test('N8: refs-only sharing grants only selected bytes, rejects forged offsets/digest, and revalidates before actual dispatch', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'HIDDEN_LEFT SELECTED_TOKEN HIDDEN_RIGHT', privateTo: ['codex'], requestId: rid() }); const first = start(h); end(h, first.id);
    const m = h.store.detail(h.c.id).messages[0]!, ref = excerpt(m, 12, 26);
    for (const forged of [{ ...ref, digest: 'forged' }, { ...ref, end: 1000 }, { ...ref, revision: 999 }]) assert.throws(() => h.store.send(h.c.id, { content: '', excerptRefs: [forged], excerptTargets: ['claude'], requestId: rid() }));
    const input = { content: '', excerptRefs: [ref], excerptTargets: ['claude'], requestId: rid() }, s = h.store.send(h.c.id, input).source;
    assert.equal(h.store.send(h.c.id, input).source.id, s.id); assert.equal(s.content.includes('SELECTED_TOKEN'), false);
    assert.equal(h.store.detail(h.c.id).messages.at(-1)!.content, '', 'carrier does not cache selected content');
    const second = h.store.admitNext()!.invocations[0]!; const prompt = h.store.prepareInput(second.id).prompt;
    assert.match(prompt, /SELECTED_TOKEN/); assert.equal(prompt.includes('HIDDEN_LEFT'), false); assert.equal(prompt.includes('HIDDEN_RIGHT'), false);
    // Source integrity drift between preparation and start must not reuse the saved payload.
    const changed = { ...m, revision: 2 }; h.store.visibility.put('cc_messages', changed);
    assert.throws(() => h.store.startInvocation(second.id), /材料已变化/);
    assert.equal(h.store.invocation(second.id).dispatchStarted, false);
  } finally { h.close(); }
});

test('N8: explicit reveal affects only that message and blocks while any original execution is not released', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'REVEAL_ME', privateTo: ['codex'], requestId: rid() }); const m = h.store.detail(h.c.id).messages[0]!, i = start(h);
    const cmd = { requestId: rid(), expectedRevision: 1, action: 'reveal' };
    assert.throws(() => h.store.visibility.messageCommand(h.c.id, m.id, cmd), /释放/); end(h, i.id, 'KEEP_PRIVATE');
    h.store.visibility.messageCommand(h.c.id, m.id, cmd); assert.equal(h.store.visibility.messageCommand(h.c.id, m.id, cmd).replayed, true);
    const view = h.store.visibility.view(h.c.id, 'claude'); assert.deepEqual(view.messages.map(m => m.content), ['REVEAL_ME']);
    assert.equal((await h.store.memory.search({ query: 'KEEP_PRIVATE', conversationId: h.c.id, memberId: 'claude' })).hits.length, 0);
    h.store.send(h.c.id, { content: '@claude now public', requestId: rid() }); const next = start(h); assert.match(h.store.prompt(next.id), /REVEAL_ME/); assert.equal(h.store.prompt(next.id).includes('KEEP_PRIVATE'), false); end(h, next.id);
  } finally { h.close(); }
});

test('N8: deletion invalidates pending excerpt, hides it from history/search/export, preserves audit', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'TO_DELETE', privateTo: ['codex'], requestId: rid() }); const i = start(h); end(h, i.id);
    const m = h.store.detail(h.c.id).messages[0]!;
    const s = h.store.send(h.c.id, { content: '', excerptRefs: [excerpt(m)], excerptTargets: ['claude'], requestId: rid() }).source;
    h.store.visibility.messageCommand(h.c.id, m.id, { action: 'delete', requestId: rid(), expectedRevision: 1 });
    assert.equal(h.store.admitNext(), undefined); const d = h.store.detail(h.c.id).deliveries.find(d => d.sourceId === s.id)!; assert.equal(d.status, 'held');
    assert.throws(() => h.store.visibility.resolveRefs(h.c.id, [excerpt(m)]));
    assert.equal((await h.store.memory.search({ query: 'TO_DELETE', conversationId: h.c.id })).hits.length, 0);
    assert.equal(JSON.stringify(h.store.visibility.export(h.c.id)).includes('TO_DELETE'), false);
    assert.match(h.store.input(i.id)!.prompt, /TO_DELETE/, 'owner audit is retained as historical fact');
  } finally { h.close(); }
});

test('N8: revealing a reply cannot publish an unrevealed private quote; original must be explicitly revealed first', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'ORIGINAL_PRIVATE_QUOTE', privateTo: ['codex'], requestId: rid() }); const first = start(h); end(h, first.id);
    const original = h.store.detail(h.c.id).messages[0]!;
    h.store.send(h.c.id, { content: 'Only this comment', replyTo: original.id, privateTo: ['codex'], requestId: rid() }); const second = start(h); end(h, second.id);
    const reply = h.store.detail(h.c.id).messages.find(m => m.replyTo)!;
    const reveal = { requestId: rid(), action: 'reveal', expectedRevision: 1 };
    assert.throws(() => h.store.visibility.messageCommand(h.c.id, reply.id, reveal), /被引用消息仍是私聊/);
    assert.equal(h.store.visibility.view(h.c.id, 'claude').messages.length, 0);
    h.store.send(h.c.id, { content: '@claude public history', requestId: rid() }); const third = start(h); assert.equal(h.store.prompt(third.id).includes('ORIGINAL_PRIVATE_QUOTE'), false); end(h, third.id);
    h.store.visibility.messageCommand(h.c.id, original.id, { requestId: rid(), action: 'reveal', expectedRevision: 1 });
    h.store.visibility.messageCommand(h.c.id, reply.id, reveal);
    h.store.send(h.c.id, { content: '@claude authorized history', requestId: rid() }); const last = start(h); assert.match(h.store.prompt(last.id), /ORIGINAL_PRIVATE_QUOTE/); end(h, last.id);
  } finally { h.close(); }
});

test('N8: deleted quote cannot survive through cached history or a pending reply source', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'DELETE_QUOTED_MARKER', requestId: rid() }); const first = start(h); end(h, first.id);
    const original = h.store.detail(h.c.id).messages[0]!;
    h.store.send(h.c.id, { content: 'Consumed reply', replyTo: original.id, requestId: rid() }); const second = start(h); end(h, second.id);
    const pending = h.store.send(h.c.id, { content: 'Pending reply', replyTo: original.id, requestId: rid() }).source;
    h.store.visibility.messageCommand(h.c.id, original.id, { requestId: rid(), action: 'delete', expectedRevision: 1 });
    assert.throws(() => h.store.visibility.sourceContent(pending), /引用来源已删除/);
    assert.equal(h.store.admitNext(), undefined);
    assert.equal(h.store.detail(h.c.id).deliveries.find(d => d.sourceId === pending.id)!.status, 'held');
    assert.equal(JSON.stringify(h.store.visibility.history(h.c.id, 'codex', 'public')).includes('DELETE_QUOTED_MARKER'), false);
    assert.equal(JSON.stringify(h.store.visibility.export(h.c.id)).includes(original.id), false);
    h.store.cooperation.withdraw(pending.id, { requestId: rid(), expectedRevision: pending.revision });
    h.store.send(h.c.id, { content: 'Fresh execution', requestId: rid() }); const last = start(h); assert.equal(h.store.prompt(last.id).includes('DELETE_QUOTED_MARKER'), false); end(h, last.id);
  } finally { h.close(); }
});

test('N8: branch preserves reply dependency instead of flattening private quotes into a revealable body', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'BRANCH_PRIVATE_QUOTE', privateTo: ['codex'], requestId: rid() }); const first = start(h); end(h, first.id);
    const original = h.store.detail(h.c.id).messages[0]!;
    h.store.send(h.c.id, { content: 'Branch comment', replyTo: original.id, privateTo: ['codex'], requestId: rid() }); const second = start(h); end(h, second.id);
    const anchor = h.store.detail(h.c.id).messages.find(m => m.replyTo)!;
    const b = h.store.visibility.branch(h.c.id, { requestId: rid(), title: 'Quotes branch', messageId: anchor.id, expectedRevision: 1 }).result;
    const d = h.store.detail(b.id), reply = d.messages.find(m => m.replyTo)!, copiedOriginal = d.messages.find(m => m.id === reply.replyTo)!;
    assert.equal(reply.content, 'Branch comment'); assert.notEqual(reply.replyTo, original.id);
    assert.throws(() => h.store.visibility.messageCommand(b.id, reply.id, { requestId: rid(), action: 'reveal', expectedRevision: 1 }), /被引用消息仍是私聊/);
    assert.equal(JSON.stringify(h.store.visibility.view(b.id, 'claude')).includes('BRANCH_PRIVATE_QUOTE'), false);
    assert.match(JSON.stringify(h.store.visibility.history(b.id, 'codex', 'private:codex')), /BRANCH_PRIVATE_QUOTE/);
    h.store.visibility.messageCommand(b.id, copiedOriginal.id, { requestId: rid(), action: 'delete', expectedRevision: 1 });
    assert.equal(JSON.stringify(h.store.visibility.history(b.id, 'codex', 'private:codex')).includes('BRANCH_PRIVATE_QUOTE'), false);
    assert.equal(JSON.stringify(h.store.visibility.export(b.id)).includes(copiedOriginal.id), false);
  } finally { h.close(); }
});

test('N8: branch snapshots cutoff and audience without queues, sessions or later history; public branch starts with inherited background', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'BEFORE_BRANCH', requestId: rid() }); const first = start(h); end(h, first.id);
    const at = h.store.detail(h.c.id).messages.at(-1)!;
    h.store.send(h.c.id, { content: 'AFTER_BRANCH_PRIVATE', privateTo: ['codex'], requestId: rid() }); const second = start(h); end(h, second.id);
    const b = h.store.visibility.branch(h.c.id, { requestId: rid(), title: 'branch', messageId: at.id, expectedRevision: 1, memberIds: ['claude'] }).result;
    const detail = h.store.detail(b.id); assert.equal(detail.sources.length, 0); assert.equal(detail.invocations.length, 0); assert.equal(detail.nativeSessions!.length, 0); assert.equal(detail.conversation.workspaceGrant, undefined);
    assert.equal(JSON.stringify(detail).includes('AFTER_BRANCH_PRIVATE'), false);
    h.store.send(b.id, { content: 'continue branch', requestId: rid() }); const third = start(h); assert.match(h.store.prompt(third.id), /BEFORE_BRANCH/); assert.equal(h.store.prompt(third.id).includes('AFTER_BRANCH'), false); end(h, third.id);
    const last = h.store.detail(h.c.id).messages.at(-1)!;
    const priv = h.store.visibility.branch(h.c.id, { requestId: rid(), title: 'private branch', messageId: last.id, expectedRevision: 1, memberIds: ['claude'] }).result;
    assert.equal(JSON.stringify(h.store.visibility.view(priv.id, 'claude')).includes('AFTER_BRANCH_PRIVATE'), false);
  } finally { h.close(); }
});

test('N8: read cursor is monotonic and never consumes deliveries; favorites/deletion/restoration and group CAS preserve exact targets', () => {
  const h = fixture(); try {
    const cmd = { requestId: rid(), expectedRevision: 1, action: 'groups', groups: [{ name: '设计组', memberIds: ['codex', 'claude'] }] };
    h.store.visibility.organize(h.c.id, cmd);
    const s = h.store.send(h.c.id, { content: '@设计组 analyze', requestId: rid() }).source; assert.deepEqual(s.requestedTargets, ['claude', 'codex']);
    const m = h.store.detail(h.c.id).messages[0]!; h.store.visibility.markRead(h.c.id, m.sequence); h.store.visibility.markRead(h.c.id, 0);
    assert.equal(h.store.visibility.readCursor(h.c.id).sequence, m.sequence); assert.ok(h.store.detail(h.c.id).deliveries.every(d => d.status === 'pending'));
    assert.throws(() => h.store.visibility.organize(h.c.id, { ...cmd, requestId: rid(), expectedRevision: 2, groups: [{ name: 'codex', memberIds: ['claude'] }] }), /冲突/);
    assert.throws(() => h.store.saveMember({ ...h.store.members()[0]!, aliases: ['设计组'] }), /成员组/);
    h.store.visibility.organize(h.c.id, { ...cmd, requestId: rid(), expectedRevision: 2, groups: [] }); assert.deepEqual(s.requestedTargets, ['claude', 'codex']);
    assert.throws(() => h.store.visibility.organize(h.c.id, { requestId: rid(), expectedRevision: 3, action: 'delete' }), /未投递/);
    h.store.cooperation.withdraw(s.id, { expectedRevision: s.revision, requestId: rid() });
    h.store.visibility.organize(h.c.id, { requestId: rid(), expectedRevision: 3, action: 'favorite' });
    h.store.visibility.organize(h.c.id, { requestId: rid(), expectedRevision: 4, action: 'delete' });
    assert.throws(() => h.store.send(h.c.id, { content: 'blocked', requestId: rid() }), /不可访问/);
    h.store.visibility.organize(h.c.id, { requestId: rid(), expectedRevision: 5, action: 'undelete' }); assert.equal(h.store.detail(h.c.id).conversation.favorite, true);
  } finally { h.close(); }
});

test('N8: candidate approval is not recall, materialization validates CAS, replacement/revoke retain immutable evidence', () => {
  const h = fixture(); try {
    const proposed = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'Decision', content: 'MEMORY_V1' }).result;
    const cmd = { requestId: rid(), expectedRevision: 1, expectedEntryRevision: 1, action: 'approve' };
    h.store.memory.transition(proposed.version.id, cmd); assert.equal(h.store.memory.transition(proposed.version.id, cmd).replayed, true);
    assert.equal(h.store.memory.current(h.c.id).length, 0);
    h.store.memory.transition(proposed.version.id, { requestId: rid(), expectedRevision: 2, expectedEntryRevision: 1, action: 'materialize' });
    assert.equal(h.store.memory.current(h.c.id)[0]!.content, 'MEMORY_V1');
    assert.equal(h.owner.db.prepare('SELECT * FROM cc_memory_materializations').all().length, 1);
    const second = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'Decision', content: 'MEMORY_V2', entryId: proposed.entry.id, expectedRevision: 2 }).result;
    h.store.memory.transition(second.version.id, { requestId: rid(), expectedRevision: 1, expectedEntryRevision: 2, action: 'approve' });
    assert.throws(() => h.store.memory.transition(second.version.id, { requestId: rid(), expectedRevision: 2, expectedEntryRevision: 1, action: 'materialize' }));
    h.store.memory.transition(second.version.id, { requestId: rid(), expectedRevision: 2, expectedEntryRevision: 2, action: 'materialize' });
    assert.deepEqual(h.store.memory.current(h.c.id).map(m => m.content), ['MEMORY_V2']);
    h.store.send(h.c.id, { content: 'use memory', requestId: rid() }); const i = start(h); assert.match(h.store.prompt(i.id), /MEMORY_V2/); assert.equal(h.store.prompt(i.id).includes('MEMORY_V1'), false);
    assert.ok(h.store.input(i.id)!.manifest.items.some(m => m.kind === 'memory')); end(h, i.id);
    h.store.memory.transition(second.version.id, { requestId: rid(), expectedRevision: 3, expectedEntryRevision: 3, action: 'revoke' }); assert.equal(h.store.memory.current(h.c.id).length, 0);
    assert.equal(h.store.memory.versions().length, 2); assert.equal(h.owner.db.prepare('SELECT * FROM cc_memory_materializations').all().length, 2);
  } finally { h.close(); }
});

test('N8: agent memory owner/scope comes from invocation; private memory never reaches public runs or unauthorized search', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'private instructions', privateTo: ['codex'], requestId: rid() }); const i = start(h);
    assert.throws(() => h.store.memory.propose(h.c.id, { requestId: rid(), key: 'bad', content: 'private', scope: 'library' }, i.id), /当前会话/);
    assert.throws(() => h.store.memory.propose(h.c.id, { requestId: rid(), key: 'bad', content: 'private', privateTo: ['claude'] }, i.id), /绑定/);
    const p = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'Private fact', content: 'MEMORY_SECRET' }, i.id).result;
    assert.equal(p.entry.owner, 'codex'); assert.deepEqual(p.entry.visibility!.memberIds, ['codex']); end(h, i.id);
    h.store.memory.transition(p.version.id, { requestId: rid(), action: 'approve', expectedRevision: 1, expectedEntryRevision: 1 }); h.store.memory.transition(p.version.id, { requestId: rid(), action: 'materialize', expectedRevision: 2, expectedEntryRevision: 1 });
    assert.equal((await h.store.memory.search({ query: 'MEMORY_SECRET', conversationId: h.c.id, memberId: 'claude' })).hits.length, 0);
    h.store.send(h.c.id, { content: 'public followup', requestId: rid() }); const next = start(h); assert.equal(h.store.prompt(next.id).includes('MEMORY_SECRET'), false); assert.deepEqual(h.store.memory.tool(next.id, 'memory_read', {}, rid()), { memories: [], hasMore: false, nextOffset: null }); end(h, next.id);
    h.store.send(h.c.id, { content: 'private followup', privateTo: ['codex'], requestId: rid() }); const last = start(h); assert.match(h.store.prompt(last.id), /MEMORY_SECRET/); end(h, last.id);
  } finally { h.close(); }
});

test('N8: memory source withdrawal invalidates approved version and recall; library respects originating membership', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'SOURCE_MEMORY', requestId: rid() }); const i = start(h); end(h, i.id); const m = h.store.detail(h.c.id).messages[0]!;
    const p = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'Source', content: 'SOURCE_MEMORY', scope: 'library', sourceRefs: [excerpt(m)] }).result;
    h.store.memory.transition(p.version.id, { requestId: rid(), action: 'approve', expectedRevision: 1, expectedEntryRevision: 1 });
    h.store.visibility.messageCommand(h.c.id, m.id, { requestId: rid(), expectedRevision: 1, action: 'delete' });
    assert.throws(() => h.store.memory.transition(p.version.id, { requestId: rid(), action: 'materialize', expectedRevision: 2, expectedEntryRevision: 1 }));
    const p2 = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'Library', content: 'LIBRARY_FACT', scope: 'library' }).result;
    h.store.memory.transition(p2.version.id, { requestId: rid(), action: 'approve', expectedRevision: 1, expectedEntryRevision: 1 }); h.store.memory.transition(p2.version.id, { requestId: rid(), action: 'materialize', expectedRevision: 2, expectedEntryRevision: 1 });
    const b = h.store.create({ title: 'Other project', requestId: rid(), memberIds: ['claude'], defaultMemberId: 'claude' }).conversation;
    assert.equal(h.store.memory.current(b.id, 'claude', 'public').length, 1);
    h.store.updateConversation(h.c.id, { memberIds: ['codex'], defaultMemberId: 'codex' }); assert.equal(h.store.memory.current(b.id, 'claude', 'public').length, 0);
    assert.equal((await h.store.memory.search({ query: 'LIBRARY_FACT', conversationId: b.id, memberId: 'claude' })).hits.length, 0);
  } finally { h.close(); }
});

test('N8: search discloses no private IDs/counts, actual docs and session replies are searchable, unsupported modes and cancellation are explicit', async () => {
  const h = fixture(); try {
    const a = h.store.workbench.upload(h.c.id, { requestId: rid(), name: 'secret-filename.txt', base64: Buffer.from('SEARCH_HIDDEN').toString('base64') }).result;
    h.store.send(h.c.id, { content: 'PRIVATE_SEARCH', attachmentIds: [a.id], privateTo: ['codex'], requestId: rid() }); const privateRun = start(h); end(h, privateRun.id, 'REPLY_HIDDEN');
    const hidden = await h.store.memory.search({ query: 'SEARCH', conversationId: h.c.id, memberId: 'claude' }); assert.equal(hidden.hits.length, 0); assert.equal(hidden.scanned, 0); assert.equal(JSON.stringify(hidden).includes(a.id), false);
    const b = h.store.workbench.upload(h.c.id, { requestId: rid(), name: 'public.txt', base64: Buffer.from('DOCUMENT_VISIBLE').toString('base64') }).result;
    h.store.send(h.c.id, { content: 'public', attachmentIds: [b.id], requestId: rid() }); const pub = start(h); end(h, pub.id, 'SESSION_VISIBLE');
    assert.equal((await h.store.memory.search({ query: 'DOCUMENT_VISIBLE', conversationId: h.c.id, memberId: 'claude', kinds: ['docs'] })).hits.length, 1);
    assert.equal((await h.store.memory.search({ query: 'SESSION_VISIBLE', conversationId: h.c.id, memberId: 'claude', kinds: ['sessions'] })).hits.length, 1);
    await assert.rejects(h.store.memory.search({ query: 'x', mode: 'semantic' }), /未接入/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(h.store.memory.search({ query: 'x', signal: controller.signal }));
    assert.throws(() => h.store.visibility.view(h.c.id, 'unknown'), /不可访问/);
  } finally { h.close(); }
});

test('N8: schema 7 migration preserves every existing JSON row and durable memory/read state on reopen', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'persistent', requestId: rid() }); const m = h.store.detail(h.c.id).messages[0]!; h.store.visibility.markRead(h.c.id, m.sequence);
    h.store.memory.propose(h.c.id, { requestId: rid(), key: 'persist', content: 'candidate' });
    const tables = ['cc_messages','cc_sources','cc_members','cc_accounts','cc_conversations']; const before = tables.map(t => h.owner.db.prepare(`SELECT value FROM ${t} ORDER BY rowid`).all());
    h.owner.db.exec('UPDATE cc_schema SET version=7'); h.owner.close();
    const owner = new Store(h.db); try { const s = new CollaborationStore(owner, { workspace: h.workspace, artifactDir: join(h.root, 'private', 'artifacts') });
      for (let n = 0; n < tables.length; n++) assert.deepEqual(owner.db.prepare(`SELECT value FROM ${tables[n]} ORDER BY rowid`).all(), before[n]);
      assert.equal((owner.db.prepare('SELECT version FROM cc_schema').get() as any).version, 13); assert.equal(s.visibility.readCursor(h.c.id).sequence, m.sequence); assert.equal(s.memory.versions().length, 1);
    } finally { owner.close(); }
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test('N8: failed memory materialization rolls back head and receipt, preserving approved candidate for explicit retry', () => {
  const h = fixture(); try {
    const p = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'atomic', content: 'ATOM' }).result;
    h.store.memory.transition(p.version.id, { requestId: rid(), action: 'approve', expectedRevision: 1, expectedEntryRevision: 1 });
    h.owner.db.exec("CREATE TRIGGER n8_fault BEFORE UPDATE ON cc_memories BEGIN SELECT RAISE(ABORT,'injected-write-failure'); END");
    const cmd = { requestId: rid(), action: 'materialize', expectedRevision: 2, expectedEntryRevision: 1 };
    assert.throws(() => h.store.memory.transition(p.version.id, cmd), /injected/);
    assert.equal(h.store.memory.current(h.c.id).length, 0); assert.equal(h.store.memory.versions()[0]!.state, 'approved'); assert.equal(h.owner.db.prepare('SELECT * FROM cc_memory_materializations').all().length, 0);
    h.owner.db.exec('DROP TRIGGER n8_fault'); h.store.memory.transition(p.version.id, cmd); assert.equal(h.store.memory.current(h.c.id).length, 1);
  } finally { h.close(); }
});

test('N8: permission epoch fences a previously frozen input and search storage failure reports degraded without partial hits', async () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'private first', privateTo: ['codex'], requestId: rid() }); const first = start(h); end(h, first.id);
    h.store.send(h.c.id, { content: 'public prepared', requestId: rid() }); const i = h.store.admitNext()!.invocations[0]!; h.store.prepareInput(i.id);
    h.store.updateConversation(h.c.id, { memberIds: ['codex'], defaultMemberId: 'codex' });
    assert.throws(() => h.store.startInvocation(i.id), /可见性/); h.store.cancel(i.id);
    const a = h.store.workbench.upload(h.c.id, { requestId: rid(), name: 'doc.txt', base64: Buffer.from('DATA').toString('base64') }).result;
    h.store.send(h.c.id, { content: '', attachmentIds: [a.id], requestId: rid() });
    h.owner.db.exec('ALTER TABLE cc_attachment_contents RENAME TO unavailable_attachment_contents');
    await assert.rejects(h.store.memory.search({ query: 'DATA', conversationId: h.c.id }), (e: any) => e.status === 503 || e.statusCode === 503 || e.code === 'search_degraded');
  } finally { h.close(); }
});

test('N8: branch retains share references and original audience without caching private excerpts; source deletion invalidates branched share', () => {
  const h = fixture(); try {
    h.store.send(h.c.id, { content: 'ORIGIN_SECRET SELECTED_PART', privateTo: ['codex'], requestId: rid() }); const run = start(h); end(h, run.id);
    const m = h.store.detail(h.c.id).messages[0]!;
    h.store.send(h.c.id, { content: 'shared', excerptTargets: ['claude'], excerptRefs: [excerpt(m, 14)], requestId: rid() }); const share = start(h); end(h, share.id);
    const anchor = h.store.detail(h.c.id).messages.find(m => m.excerptRefs?.length)!;
    const b = h.store.visibility.branch(h.c.id, { requestId: rid(), title: 'share branch', messageId: anchor.id, expectedRevision: 1, memberIds: ['claude'] }).result;
    assert.equal(h.store.detail(b.id).messages[0]!.content, 'shared');
    assert.match(JSON.stringify(h.store.visibility.export(b.id, 'claude')), /SELECTED_PART/); assert.equal(JSON.stringify(h.store.visibility.export(b.id, 'claude')).includes('ORIGIN_SECRET'), false);
    h.store.send(b.id, { content: 'continue private', privateTo: ['claude'], requestId: rid() }); const third = start(h); assert.match(h.store.prompt(third.id), /SELECTED_PART/); assert.equal(h.store.prompt(third.id).includes('ORIGIN_SECRET'), false); end(h, third.id);
    h.store.visibility.messageCommand(h.c.id, m.id, { requestId: rid(), action: 'delete', expectedRevision: 1 });
    assert.equal(JSON.stringify(h.store.visibility.export(b.id, 'claude')).includes('SELECTED_PART'), false);
  } finally { h.close(); }
});

test('N8: memory_read is bounded, pages only authorized material and rejects identity overrides', () => {
  const h = fixture(); try {
    for (let n = 0; n < 3; n++) {
      const p = h.store.memory.propose(h.c.id, { requestId: rid(), key: 'item-' + n, content: 'value-' + n, ...(n === 2 ? { privateTo: ['claude'] } : {}) }).result;
      h.store.memory.transition(p.version.id, { requestId: rid(), action: 'approve', expectedRevision: 1, expectedEntryRevision: 1 }); h.store.memory.transition(p.version.id, { requestId: rid(), action: 'materialize', expectedRevision: 2, expectedEntryRevision: 1 });
    }
    h.store.send(h.c.id, { content: 'public', requestId: rid() }); const i = start(h);
    const first = h.store.memory.tool(i.id, 'memory_read', { limit: 1 }, rid()) as any; assert.equal(first.memories.length, 1); assert.equal(first.nextOffset, 1);
    const second = h.store.memory.tool(i.id, 'memory_read', { offset: first.nextOffset, limit: 1 }, rid()) as any; assert.equal(second.memories[0].key, 'item-1'); assert.equal(second.hasMore, false);
    assert.throws(() => h.store.memory.tool(i.id, 'memory_read', { memberId: 'claude' }, rid()), /身份/);
    assert.throws(() => h.store.memory.tool(i.id, 'memory_read', { limit: 99 }, rid()), /分页/); end(h, i.id);
  } finally { h.close(); }
});
