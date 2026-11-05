import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { CollaborationRuntime, RuntimeRequest } from '../shared/collaboration.js';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';

function setup(path = ':memory:') {
  const owner = new Store(path); const store = new CollaborationStore(owner);
  store.saveMember({ id: 'third', name: '第三成员', instructions: 'test', carrier: 'codex-app-server', accountId: 'codex-cli', enabled: true });
  const conversation = store.create({ title: '测试会话', memberIds: ['codex', 'claude', 'third'], defaultMemberId: 'codex', requestId: crypto.randomUUID() }).conversation;
  return { owner, store, conversation, send: (content: string, requestId = crypto.randomUUID()) => store.send(conversation.id, { content, requestId }) };
}
function finish(store: CollaborationStore, invocationId: string, content = '完成', status: 'succeeded' | 'failed' = 'succeeded') {
  if (store.invocation(invocationId).status === 'prepared') store.startInvocation(invocationId);
  store.recordEvidence(invocationId, { kind: 'process_exit', detail: { code: 0, confirmed: true, source: 'test-adapter' } });
  store.finish(invocationId, status, content);
}
async function eventually(predicate: () => boolean) { const end = Date.now() + 3000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } }

test('SCH-01：持久消息命令重放不重复来源、成员责任或公开消息', () => {
  const h = setup(); try {
    const requestId = crypto.randomUUID(); const a = h.send('@codex @claude 请协作', requestId); const b = h.send('@codex @claude 请协作', requestId);
    assert.equal(a.source.id, b.source.id); assert.equal(b.replayed, true);
    assert.throws(() => h.send('另一任务', requestId), /different content/);
    const d = h.store.detail(h.conversation.id); assert.equal(d.sources.length, 1); assert.equal(d.deliveries.length, 2); assert.equal(d.messages.length, 1);
  } finally { h.owner.close(); }
});

test('SCH-02/03/04：同源整组等待，重叠不越序，独立成员绕行，批次并行', () => {
  const h = setup(); try {
    h.send('@codex 先执行'); const first = h.store.admitNext()!; h.store.startInvocation(first.invocations[0].id);
    const blocked = h.send('@codex @claude 共同工作').source;
    const overlap = h.send('@claude 后续工作').source;
    const independent = h.send('@third 独立工作').source;
    const next = h.store.admitNext()!; assert.equal(next.batch.sourceId, independent.id); assert.equal(next.batch.mode, 'serial'); assert.equal(h.store.admitNext(), undefined);
    finish(h.store, first.invocations[0].id);
    const group = h.store.admitNext()!; assert.equal(group.batch.sourceId, blocked.id); assert.equal(group.batch.mode, 'parallel'); assert.equal(group.invocations.length, 2);
    assert.ok(group.invocations.every(i => i.batchId === group.batch.id));
    assert.equal(h.store.detail(h.conversation.id).deliveries.find(d => d.sourceId === overlap.id)!.status, 'pending');
  } finally { h.owner.close(); }
});

test('FC-06：输入由response与Consumption承接，queue退休不代表provider接受或完成', () => {
  const h = setup(); try {
    h.send('@codex @claude 对同一任务提供意见'); const admitted = h.store.admitNext()!; const d = h.store.detail(h.conversation.id);
    assert.equal(d.deliveries.filter(x => x.status === 'pending').length, 0); assert.equal(d.consumptions.length, 2); assert.equal(d.responses.length, 2);
    for (const i of admitted.invocations) { assert.equal(i.dispatchStarted, false); assert.equal(i.acceptance, 'unknown'); assert.equal(i.status, 'prepared'); }
    assert.equal(h.store.admitNext(), undefined);
  } finally { h.owner.close(); }
});

test('SCH-07/08：parallel最终@受抑制，结构化callback独立准入，工具ID重放幂等', () => {
  const h = setup(); try {
    h.send('@codex @claude 并行'); const group = h.store.admitNext()!; const a = group.invocations[0]; h.store.startInvocation(a.id);
    const request = { targets: ['third'], content: '请第三成员检查' }; const first = h.store.requestCollaboration(a.id, 'tool-1', request); const replay = h.store.requestCollaboration(a.id, 'tool-1', request);
    assert.equal(first.sourceId, replay.sourceId); assert.equal(replay.replayed, true);
    assert.throws(() => h.store.requestCollaboration(a.id, 'tool-1', { ...request, content: 'changed' }), /different content/);
    finish(h.store, group.invocations[1].id);
    finish(h.store, a.id, '@third 再看看');
    const d = h.store.detail(h.conversation.id); assert.equal(d.sources.length, 2); assert.ok(d.events.some(e => e.type === 'routing.text_suppressed')); assert.equal(d.batches[0].mode, 'parallel');
  } finally { h.owner.close(); }
});

test('串行最终行首@可接力，代码块内和正文内提及不接力', () => {
  const h = setup(); try {
    h.send('请处理'); const a = h.store.admitNext()!.invocations[0]; finish(h.store, a.id, '正文 @claude 不路由\n```\n@claude 示例\n```\n@third 请复核');
    const d = h.store.detail(h.conversation.id); assert.equal(d.sources.length, 2); assert.equal(d.sources[1].kind, 'mention'); assert.deepEqual(d.sources[1].requestedTargets, ['third']);
  } finally { h.owner.close(); }
});

test('SCH-09/10/16：政策hold按来源持久化，部分只派第一个eligible，不重定向默认', () => {
  const h = setup(); try {
    const codex = h.store.members().find(m => m.id === 'codex')!;
    const held = h.send('@codex 不可转给其他人').source;
    h.store.saveMember({ ...codex, enabled: false }); assert.equal(h.store.admitNext(), undefined);
    h.store.saveMember({ ...codex, enabled: true });
    const later = h.send('@codex 新请求').source; const admitted = h.store.admitNext()!; assert.equal(admitted.batch.sourceId, later.id);
    assert.equal(h.store.detail(h.conversation.id).deliveries.find(d => d.sourceId === held.id)!.status, 'held'); finish(h.store, admitted.invocations[0].id);
    h.send('@codex @claude @third 部分hold'); h.store.saveMember({ ...codex, enabled: false }); const partial = h.store.admitNext()!; assert.deepEqual(partial.batch.targets, ['claude']); assert.equal(partial.batch.mode, 'serial');
  } finally { h.owner.close(); }
});

test('FC-01/02/05：普通成功不回唤，失败原子控制准入，重复终态与失败控制不递归', () => {
  const h = setup(); try {
    h.send('请求'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id);
    h.store.requestCollaboration(a.id, 'tool-one', { targets: ['claude'], content: '处理任务一' });
    const b = h.store.admitNext()!.invocations[0]; finish(h.store, b.id); assert.equal(h.store.detail(h.conversation.id).sources.filter(s => s.kind === 'a2a_failure').length, 0);
    h.store.requestCollaboration(a.id, 'tool-two', { targets: ['claude'], content: '处理任务二' }); const c = h.store.admitNext()!.invocations[0];
    finish(h.store, c.id, '承载报错', 'failed'); h.store.finish(c.id, 'failed', '承载报错');
    let d = h.store.detail(h.conversation.id); const control = d.sources.find(s => s.kind === 'a2a_failure')!;
    assert.equal(control.id, c.responseId); assert.deepEqual(control.requestedTargets, ['codex']); assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 1);
    assert.equal(d.messages.filter(m => m.responseId === c.responseId).length, 1); assert.equal(d.messages.filter(m => m.sourceId === control.id).length, 0);
    assert.equal(h.store.admitNext(), undefined, 'caller忙时控制待办等待'); finish(h.store, a.id);
    const report = h.store.admitNext()!.invocations[0]; finish(h.store, report.id, '回报也失败', 'failed');
    d = h.store.detail(h.conversation.id); assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 1); assert.equal(h.store.admitNext(), undefined);
  } finally { h.owner.close(); }
});

test('FC-09：失败提交注入SQL故障时，终态/消息/控制来源全部回滚', () => {
  const h = setup(); try {
    h.send('请求'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id); h.store.requestCollaboration(a.id, 'tool', { targets: ['claude'], content: '执行' });
    const b = h.store.admitNext()!.invocations[0]; h.store.startInvocation(b.id);
    h.store.db.exec(`CREATE TRIGGER fail_control BEFORE INSERT ON cc_sources WHEN json_extract(NEW.value,'$.kind')='a2a_failure' BEGIN SELECT RAISE(ABORT,'injected fault'); END;`);
    assert.throws(() => h.store.finish(b.id, 'failed', '执行失败'), /injected fault/);
    let d = h.store.detail(h.conversation.id); assert.equal(d.invocations.find(i => i.id === b.id)!.status, 'running'); assert.equal(d.messages.filter(m => m.responseId === b.responseId).length, 0); assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 0);
    h.store.db.exec('DROP TRIGGER fail_control'); h.store.finish(b.id, 'failed', '执行失败');
    d = h.store.detail(h.conversation.id); assert.equal(d.invocations.find(i => i.id === b.id)!.status, 'failed'); assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 1);
  } finally { h.owner.close(); }
});

test('FC-04：失败proof身份损坏报协议冲突，不能静默丢失回报', () => {
  const h = setup(); try {
    h.send('请求'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id); h.store.requestCollaboration(a.id, 'tool', { targets: ['claude'], content: '执行' });
    const b = h.store.admitNext()!.invocations[0]; h.store.startInvocation(b.id);
    h.store.db.prepare("UPDATE cc_failure_proofs SET value=json_set(value,'$.callerMemberId','third') WHERE response_id=?").run(b.responseId);
    assert.throws(() => h.store.finish(b.id, 'failed', '错误'), /proof is inconsistent/); assert.equal(h.store.invocation(b.id).status, 'running');
  } finally { h.owner.close(); }
});

test('重启：prepared可按原身份启动；越过provider边界的unknown不重发且保留槽', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-recovery-')); const path = join(dir, 'db.sqlite');
  try {
    const h = setup(path); h.send('@codex 运行中'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id); h.send('@codex 后续'); h.send('@claude 尚未外部启动'); const prepared = h.store.admitNext()!.invocations[0]; const conversationId = h.conversation.id; h.owner.close();
    const owner = new Store(path); const store = new CollaborationStore(owner); try {
      store.recover(); assert.equal(store.invocation(a.id).status, 'interrupted'); assert.equal(store.invocation(a.id).teardown, 'unknown'); assert.equal(store.invocation(prepared.id).status, 'prepared'); assert.equal(store.admitNext(), undefined);
      store.startInvocation(prepared.id); finish(store, prepared.id); assert.equal(store.detail(conversationId).invocations.filter(i => i.memberId === 'codex').length, 1);
    } finally { owner.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancel_requested不能释放槽；实际退出后旧结果不能变成成功', () => {
  const h = setup(); try {
    h.send('执行'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id); h.store.cancel(a.id); h.send('后续'); assert.equal(h.store.admitNext(), undefined);
    assert.throws(() => h.store.requestCollaboration(a.id, 'late', { targets: ['claude'], content: '迟到回调' }), /inactive/);
    h.store.recordEvidence(a.id, { kind: 'process_exit', detail: { code: null, signal: 'SIGTERM', confirmed: true } }); assert.equal(h.store.admitNext(), undefined, '退出回执早于Promise完成时仍保留槽');
    h.store.finish(a.id, 'succeeded', '迟到完成'); assert.equal(h.store.invocation(a.id).status, 'cancelled'); assert.ok(h.store.admitNext());
  } finally { h.owner.close(); }
});

test('HTTP transport_settled与CLI process_exit分开记录；未知网络结果不释放槽', () => {
  const h = setup(); try {
    h.send('执行'); const a = h.store.admitNext()!.invocations[0]; h.store.startInvocation(a.id); h.store.finish(a.id, 'failed', '请求结果未知'); h.send('下一轮'); assert.equal(h.store.admitNext(), undefined);
    h.store.recordEvidence(a.id, { kind: 'transport_settled', detail: { scope: 'request', confirmed: false } }); assert.equal(h.store.admitNext(), undefined);
    h.store.recordEvidence(a.id, { kind: 'transport_settled', detail: { scope: 'request', confirmed: true } }); assert.ok(h.store.admitNext());
  } finally { h.owner.close(); }
});

test('Engine真实持久链路：Codex→Claude工具交接、成功不回唤、自然追问继续', async () => {
  const h = setup(); const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe: async () => [], invoke: async request => {
    calls.push(request); request.onEvent({ kind: 'accepted', detail: { carrier: 'test', turn: calls.length } });
    if (request.member.id === 'codex' && calls.length === 1) await request.onToolCall('collaboration_request', { targets: ['claude'], content: '请检查输入' }, 'tool-1');
    request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true, carrier: 'test' } }); return { text: '已处理', continuity: 'fresh' };
  } };
  const engine = new CollaborationEngine(h.store, runtime, { workspace: '/tmp' });
  try {
    h.send('一起处理'); engine.start(); await eventually(() => h.store.detail(h.conversation.id).invocations.length === 2 && h.store.invocations().every(i => i.status === 'succeeded'));
    assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.nativeSessionId));
    h.send('继续修改'); engine.kick(); await eventually(() => calls.length === 3 && h.store.invocations().every(i => i.status === 'succeeded'));
    assert.match(calls[2].prompt, /已处理/);
  } finally { await engine.stop(); h.owner.close(); }
});

test('会话配置变化不改既有绑定；不能移除仍有工作责任的成员', () => {
  const h = setup(); try {
    const source = h.send('原目标').source; h.store.updateConversation(h.conversation.id, { memberIds: ['codex', 'claude', 'third'], defaultMemberId: 'claude' });
    assert.deepEqual(h.store.detail(h.conversation.id).sources[0].requestedTargets, ['codex']);
    assert.throws(() => h.store.updateConversation(h.conversation.id, { memberIds: ['claude'], defaultMemberId: 'claude' }), /still owns/);
    assert.deepEqual(h.send('新目标').source.requestedTargets, ['claude']); assert.notEqual(source.id, h.store.detail(h.conversation.id).sources[1].id);
  } finally { h.owner.close(); }
});
