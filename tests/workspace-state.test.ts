import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTarget, emptyWorkspace, restoreWorkspace, targetKey, workspaceReducer as reduce, type WorkspaceLayout, type WorkspaceTarget } from '../web/workspace-state.js';
import type { ConversationDetail } from '../shared/collaboration.js';
const task: WorkspaceTarget = { conversationId: 'c1', kind: 'task', taskId: 't1' };
const artifact = (versionId: string, artifactId = 'a1'): WorkspaceTarget => ({ conversationId: 'c1', kind: 'artifact', artifactId, versionId });
const open = (s: WorkspaceLayout, target: WorkspaceTarget, preview = false) => reduce(s, { type: 'open', target, preview });

test('workspace identities separate conversations, same-title objects and fixed artifact versions', () => {
  const s = [artifact('v1'), artifact('v2'), artifact('v1', 'a2')].reduce((s, t) => open(s, t), emptyWorkspace('c1'));
  assert.equal(s.views.length, 3);
  assert.equal(open(s, artifact('v1')).views.length, 3);
  assert.notEqual(targetKey(task), targetKey({ ...task, conversationId: 'c2' }));
  assert.equal(open(s, { ...task, conversationId: 'c2' }), s);
});
test('workspace preview replacement is limited to one declared slot and records closed identity', () => {
  let s = open(emptyWorkspace('c1'), task);
  s = open(open(s, artifact('v1'), true), artifact('v2'), true);
  assert.deepEqual(s.views.map(v => v.key), [targetKey(task), targetKey(artifact('v2'))]);
  assert.equal(s.closed[0]!.key, targetKey(artifact('v1')));
  assert.equal(s.preview, targetKey(artifact('v2')));
});
test('pin and edit promotion protect a preview from later replacement', () => {
  for (const type of ['pin', 'promote'] as const) {
    let s = open(emptyWorkspace('c1'), artifact('v1'), true);
    s = reduce(s, { type, key: targetKey(artifact('v1')) });
    assert.equal(s.preview, null);
    s = open(s, artifact('v2'), true);
    assert.equal(s.views.length, 2);
    s = open(s, artifact('v1'), true);
    assert.equal(s.preview, targetKey(artifact('v2')));
  }
});
test('background opens cannot change focus, tabs or accepted visits', () => {
  const s = open(emptyWorkspace('c1'), task);
  assert.equal(reduce(s, { type: 'open', target: artifact('v1'), cause: 'background' }), s);
  assert.equal(s.active, targetKey(task));
});
test('source origin survives close and restore without recursive/self origin', () => {
  let s = open(emptyWorkspace('c1'), task);
  s = reduce(s, { type: 'open', target: artifact('v1'), origin: { kind: 'view', target: task } });
  s = reduce(s, { type: 'pin', key: targetKey(artifact('v1')) });
  s = reduce(s, { type: 'close', key: targetKey(artifact('v1')) });
  assert.equal(s.active, targetKey(task));
  s = reduce(s, { type: 'restore', key: targetKey(artifact('v1')) });
  assert.deepEqual(s.views.at(-1)!.origin, { kind: 'view', target: task });
  assert.equal(s.views.at(-1)!.pinned, false);
  s = reduce(s, { type: 'open', target: artifact('v1'), origin: { kind: 'view', target: artifact('v1') } });
  assert.deepEqual(s.views.at(-1)!.origin, { kind: 'view', target: task });
});
test('closing preserves explicit recent visit order and bounded restore history', () => {
  let s = emptyWorkspace('c1');
  for (let i = 0; i < 8; i++) { s = open(s, artifact(`v${i}`)); s = reduce(s, { type: 'close', key: targetKey(artifact(`v${i}`)) }); }
  assert.equal(s.closed.length, 5);
  assert.deepEqual(s.recent, ['v7', 'v6', 'v5'].map(v => targetKey(artifact(v))));
  assert.equal(s.active, null);
});
test('restoration whitelists references, rejects cross-scope data and strips content and arbitrary fields', () => {
  const original = open(emptyWorkspace('c1'), artifact('v1'), true);
  const raw = { ...original, secret: 'credential', draft: 'private text', width: 900, views: [{ ...original.views[0], title: 'cached text', target: { ...artifact('v1'), content: 'private material' } }, { target: { ...task, conversationId: 'c2' } }, null, { target: { ...task, taskId: '../fake' } }] };
  const s = restoreWorkspace(raw, 'c1');
  assert.equal(s.views.length, 1); assert.equal(s.width, 74);
  assert.ok(!JSON.stringify(s).includes('private')); assert.ok(!JSON.stringify(s).includes('cached')); assert.ok(!JSON.stringify(s).includes('credential'));
  assert.equal(s.preview, targetKey(artifact('v1')));
  assert.deepEqual(restoreWorkspace(raw, 'c2'), emptyWorkspace('c2'));
});
test('unknown schema, malformed layout and dangling references restore safely', () => {
  for (const raw of [null, [], 'oops', { schema: 99, conversationId: 'c1' }]) assert.deepEqual(restoreWorkspace(raw, 'c1'), emptyWorkspace('c1'));
  const s = restoreWorkspace({ schema: 1, conversationId: 'c1', views: [], active: 'missing', preview: 'missing', recent: ['missing'], width: NaN }, 'c1');
  assert.deepEqual(s, emptyWorkspace('c1'));
});
test('workspace state does not change object targets when material head moves or scope disappears', () => {
  const detail = { conversation: { id: 'c1' }, tasks: [{ id: 't1', title: 'same' }], artifacts: [{ id: 'a1', name: 'design.md', headVersionId: 'v2' }], artifactVersions: [{ id: 'v1', artifactId: 'a1', number: 1 }, { id: 'v2', artifactId: 'a1', number: 2 }], messages: [], invocations: [], memories: [{ id: 'e1', scope: 'conversation', key: 'rule', revokedAt: 'now' }], memoryVersions: [{ id: 'm1', entryId: 'e1', number: 1 }] } as unknown as ConversationDetail;
  assert.equal(describeTarget(artifact('v1'), detail).title, 'design.md · v1');
  assert.ok(describeTarget({ conversationId: 'c1', kind: 'memory', entryId: 'e1', versionId: 'm1' }, detail).unavailable);
  assert.ok(describeTarget(task, { ...detail, conversation: { ...detail.conversation, deletedAt: 'now' } }).unavailable);
  assert.ok(describeTarget(artifact('missing'), detail).unavailable);
});
test('bounded active workspace refuses overflow without evicting pinned or edited objects', () => {
  let s = emptyWorkspace('c1'); for (let i = 0; i < 40; i++) s = open(s, artifact(`v${i}`));
  assert.equal(open(s, artifact('overflow')), s);
  assert.equal(reduce(s, { type: 'resize', width: NaN }), s);
  assert.equal(reduce(s, { type: 'resize', width: -30 }).width, 34);
});
