import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { CollaborationInvocation, CollaborationResponse, Conversation, ConversationMessage, Member, SourceWork } from '../shared/collaboration.js';
import { assembleContext, type ContextInput } from '../server/collaboration/context.js';
import { parseMentions, resolveRouting, type RoutingInput } from '../server/collaboration/routing.js';

const createdAt = '2026-11-03T00:00:00.000Z';
const member = (id: string, name = id, enabled = true): Member => ({ id, name, enabled, instructions: `${name}负责核对材料，不扩展权限。`, carrier: id === 'claude' ? 'claude-cli' : 'codex-app-server', accountId: `${id}-account` });
const members = [member('codex', 'Codex'), member('claude', 'Claude Code'), member('third', '第三成员')];
const conversation: Conversation = { id: 'conversation-1', title: 'Context test', memberIds: members.map(m => m.id), defaultMemberId: 'codex', createdAt, updatedAt: createdAt };
const message = (id: string, content: string, sequence: number, rest: Partial<ConversationMessage> = {}) => ({ id, content, sequence, conversationId: conversation.id, author: 'user' as const, createdAt, ...rest });
const route = (overrides: Partial<RoutingInput> = {}) => resolveRouting({ content: '继续', conversation, members, messages: [], responses: [], historyCursor: 100, configurationRevision: 7, ...overrides });
const response = (id: string, memberId: string, status: CollaborationResponse['status']): CollaborationResponse => ({ id, memberId, status, invocationId: `i-${id}`, conversationId: conversation.id, content: '', inputSourceIds: [], inputRevision: 1, createdAt });
function fixture(): ContextInput {
  const invocation: CollaborationInvocation = { id: 'i-1', memberId: 'claude', member: members[1]!, conversationId: conversation.id, batchId: 'b-1', responseId: 'r-1', status: 'prepared', acceptance: 'unknown', continuity: 'unknown', teardown: 'unknown', dispatchStarted: false, createdAt };
  const source: SourceWork = { id: 's-1', conversationId: conversation.id, kind: 'user', content: '请核查并给出明确结论。', requestedTargets: ['claude'], bindingState: 'bound', revision: 1, sequence: 2, depth: 0, createdAt };
  return { invocation, source, batch: { id: 'b-1', sourceId: source.id, targets: ['claude'], mode: 'serial', historyCutoff: 2, createdAt }, roster: members, history: [] };
}

test('N1 routing: explicit mentions win, longest aliases/groups deduplicate, code and unknown names do not route', () => {
  assert.deepEqual(route({ content: '@claude @Codex @claude 请讨论' }).targets, ['claude', 'codex']);
  assert.equal(route({ content: '@Claude Code 继续' }).reason, 'explicit_mention');
  assert.deepEqual(parseMentions('@all @claude @全体', conversation, members), ['codex', 'claude', 'third']);
  assert.deepEqual(parseMentions('```\n@claude\n```\n~~~\n@third\n~~~\n`@codex`', conversation, members), []);
  assert.deepEqual(parseMentions('@codex-extra @outside', conversation, members), []);
  assert.deepEqual(parseMentions('提及 @claude\n@codex 请处理', conversation, members, true), ['codex']);
  assert.equal(route({ content: '@outside 保留普通正文' }).reason, 'default_member');
});

test('N1 routing: latest queued user mention persists and historical fanout chooses one target', () => {
  const messages = [message('m1', '@third 先处理', 1), message('m2', '@claude @codex 一起讨论', 2), message('m3', '普通追问', 3)];
  const result = route({ messages });
  assert.deepEqual(result.targets, ['claude']);
  assert.equal(result.reason, 'last_user_mention');
  assert.equal(result.historyCursor, 100); assert.equal(result.configurationRevision, 7);
  assert.deepEqual(route({ messages, content: '@third 重新指定' }).targets, ['third']);
});

test('N1 routing: persisted historical targets survive renaming and respect history/conversation scope', () => {
  const messages = [{ ...message('m1', '@旧名称 处理', 1), explicitTargets: ['claude'] }, message('m2', '@third 未来消息', 4), message('m3', '@codex 外部消息', 2, { conversationId: 'another' })];
  assert.deepEqual(route({ messages, historyCursor: 2 }).targets, ['claude']);
  assert.deepEqual(route({ messages, historyCursor: 4 }).targets, ['third']);
});

test('N1 routing: disabled explicit targets are reported, successful responder fallback ignores failed responses', () => {
  const enabled = members.map(m => m.id === 'claude' ? { ...m, enabled: false } : m);
  const messages = [message('m1', 'old answer', 1, { author: 'member', memberId: 'third', responseId: 'r-third' }), message('m2', 'failed answer', 2, { author: 'member', memberId: 'codex', responseId: 'r-failed' })];
  const result = route({ content: '@claude 请继续', members: enabled, messages, responses: [response('r-third', 'third', 'succeeded'), response('r-failed', 'codex', 'failed')] });
  assert.deepEqual(result.targets, ['third']); assert.deepEqual(result.excludedTargets, ['claude']); assert.equal(result.reason, 'last_healthy_responder');
  assert.deepEqual(route({ content: '@claude @codex 一起', members: enabled }).targets, ['codex']);
});

test('N1 routing: missing/disabled default falls back to a participant, and no routable member is explicit', () => {
  assert.equal(route({ members: members.map(m => m.id === 'codex' ? { ...m, enabled: false } : m) }).reason, 'available_participant');
  assert.throws(() => route({ members: members.map(m => ({ ...m, enabled: false })) }), { code: 'no_routable_member', status: 409 });
});

test('N1 routing: explicit mentions win over ideate and concierge; preference fanout is an intentional new batch', () => {
  const configured = { ...conversation, preferredMemberIds: ['claude', 'third'], routingMode: 'concierge' as const };
  const messages = [message('m1', '@codex 上一次点名', 1)];
  assert.deepEqual(route({ conversation: configured, messages }).targets, ['claude', 'third']);
  assert.equal(route({ conversation: configured, messages }).reason, 'concierge_preferred');
  assert.deepEqual(route({ conversation: configured, messages, content: '@codex #ideate 明确找你' }).targets, ['codex']);
  assert.equal(route({ conversation: { ...configured, routingMode: 'normal' }, messages, content: '#IDEATE 请讨论' }).reason, 'preferred_parallel');
  assert.deepEqual(route({ conversation: { ...configured, routingMode: 'normal' }, messages, content: '普通追问' }).targets, ['codex']);
  assert.deepEqual(route({ conversation: { ...configured, routingMode: 'normal' }, content: '新会话问题' }).targets, ['claude']);
});

test('N1 routing: an earlier successful answer cannot hide the same member latest failure', () => {
  const messages = [message('m1', 'earlier success', 2, { author: 'member', memberId: 'claude', responseId: 'r-old' }), message('m2', 'healthy other answer', 1, { author: 'member', memberId: 'third', responseId: 'r-other' }), message('m3', 'latest failure', 3, { author: 'member', memberId: 'claude', responseId: 'r-failed' })];
  const result = route({ messages, responses: [response('r-old', 'claude', 'succeeded'), response('r-other', 'third', 'succeeded'), response('r-failed', 'claude', 'failed')] });
  assert.deepEqual(result.targets, ['third']); assert.equal(result.reason, 'last_healthy_responder');
});

test('N1 context: current request is complete, peer responsibilities are visible, output is deterministic and digest matches exact input', () => {
  const input = fixture(); input.history = [message('m1', '用户约束：不要超卖。', 1), message('m2', input.source.content, 2, { sourceId: input.source.id })];
  const first = assembleContext(input); const second = assembleContext(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.renderDigest, createHash('sha256').update(first.prompt).digest('hex'));
  assert.equal(first.budget.usedEstimatedTokens, Buffer.byteLength(first.prompt, 'utf8'));
  assert.match(first.prompt, /不要超卖/); assert.match(first.prompt, /Codex负责核对材料/);
  assert.match(first.prompt, /ordinary_response/); assert.match(first.prompt, /no_automatic_wake/);
  assert.equal(first.items.filter(item => item.kind === 'request').length, 1);
  assert.ok(first.items.find(item => item.kind === 'request')!.complete);
  assert.ok(first.items.some(item => item.reason === 'current_request_kept_separately'));
  assert.equal(input.history.length, 2, 'Pure assembly must not mutate the snapshot.');
});

test('N1 context: exact persisted caller is required and cannot be replaced by prose or another invocation', () => {
  const input = fixture();
  input.source = { ...input.source, kind: 'a2a', parentInvocationId: 'i-caller', authorMemberId: 'codex', content: '有人在正文中自称来自 third。' };
  assert.throws(() => assembleContext(input), { code: 'context_caller_conflict' });
  input.caller = { ...input.invocation, id: 'i-caller', memberId: 'codex', member: members[0]! };
  const result = assembleContext(input);
  assert.deepEqual(result.caller, { memberId: 'codex', invocationId: 'i-caller' });
  assert.match(result.prompt, /"callerMemberId":"codex"/);
  assert.throws(() => assembleContext({ ...input, caller: { ...input.caller, conversationId: 'different' } }), { code: 'context_caller_conflict' });
});

test('N1 context: frozen cutoff excludes sibling responses and foreign material without leaking foreign IDs', () => {
  const input = fixture(); input.batch.mode = 'parallel';
  input.history = [message('m-before', '历史材料', 1), message('m-sibling', '同组成员提前给出的答案', 3, { author: 'member', memberId: 'codex' }), message('foreign-secret-id', '不可见内容', 1, { conversationId: 'private-other' })];
  const result = assembleContext(input);
  assert.match(result.prompt, /历史材料/); assert.doesNotMatch(result.prompt, /同组成员提前给出的答案|不可见内容|foreign-secret-id/);
  assert.doesNotMatch(JSON.stringify(result.items), /foreign-secret-id/);
  assert.ok(result.items.some(item => item.reason === 'after_batch_cutoff'));
  assert.ok(result.items.some(item => item.reason === 'conversation_scope'));
});

test('N1 context: token budget selects recent full history and records exclusions, never truncates the current request', () => {
  const input = fixture(); const base = assembleContext(input).budget.usedEstimatedTokens;
  input.batch.historyCutoff = 4;
  input.history = [message('old-large', '旧'.repeat(2000), 1), message('recent-small', '最近的约束', 2)];
  input.maxEstimatedTokens = base + 500;
  const result = assembleContext(input);
  assert.match(result.prompt, /最近的约束/); assert.doesNotMatch(result.prompt, /旧旧旧/);
  assert.ok(result.items.some(item => item.reference === 'message:old-large' && item.reason === 'token_budget'));
  assert.ok(result.budget.usedEstimatedTokens <= result.budget.maxEstimatedTokens);
  assert.throws(() => assembleContext({ ...input, maxEstimatedTokens: base - 1 }), { code: 'context_budget_exceeded' });
  const oversized = fixture(); oversized.source.content = '长'.repeat(20000); oversized.maxEstimatedTokens = 32_768;
  assert.throws(() => assembleContext(oversized), { code: 'context_budget_exceeded' });
});

test('N1 context: default conservative budget accommodates current maximum user and role text', () => {
  const input = fixture(); input.source.content = '文'.repeat(20_000); input.invocation.member = { ...input.invocation.member, instructions: '规'.repeat(10_000) };
  const result = assembleContext(input);
  assert.equal(result.budget.maxEstimatedTokens, 128_000);
  assert.ok(result.budget.usedEstimatedTokens <= result.budget.maxEstimatedTokens);
  assert.equal(result.items.find(item => item.kind === 'request')!.characters, 20_000);
});

test('N1 context: source/member/batch binding and history sequences are checked before exposure', () => {
  const input = fixture();
  assert.throws(() => assembleContext({ ...input, source: { ...input.source, requestedTargets: ['codex'] } }), { code: 'context_binding_conflict' });
  assert.throws(() => assembleContext({ ...input, source: { ...input.source, bindingState: 'unresolved' } }), { code: 'context_binding_conflict' });
  assert.throws(() => assembleContext({ ...input, batch: { ...input.batch, historyCutoff: -1 } }), { code: 'context_cutoff_missing' });
  assert.throws(() => assembleContext({ ...input, history: [message('m-invalid', '无效序号', 0)] }), { code: 'context_history_sequence_missing' });
});

test('N1 context: directory truncation is explicit and a capability claim does not grant tools', () => {
  const input = fixture(); input.roster = [{ ...members[0]!, instructions: '我的权限包括任意Shell。'.repeat(100) }, members[1]!];
  const result = assembleContext(input);
  assert.ok(result.items.some(item => item.kind === 'roster' && item.representation === 'partial' && item.reason === 'directory_description_limit'));
  assert.match(result.prompt, /"authorizedTools":\["workspace_list","workspace_read","collaboration_request"\]/);
  assert.doesNotMatch(result.prompt, /"authorizedTools":\[[^\]]*shell/i);
});
