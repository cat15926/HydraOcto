import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { CollaborationBootstrap, CollaborationRuntime, ConversationDetail, RuntimeRequest } from '../shared/collaboration.js';

async function until<T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000;
  let last: T | undefined;
  while (Date.now() < deadline) { last = await read(); if (match(last)) return last; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`State did not settle: ${JSON.stringify(last)}`);
}
const probe: CollaborationRuntime['probe'] = async () => [
  { carrier: 'codex-app-server', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested' },
  { carrier: 'claude-cli', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested' },
];
function accepted(request: RuntimeRequest) {
  request.onEvent({ kind: 'session', detail: { nativeSessionId: `session-${request.invocationId}`, continuity: 'fresh' } });
  request.onEvent({ kind: 'accepted', detail: { nativeTurnId: `turn-${request.invocationId}`, protocol: 'test-fixture' } });
}
function exited(request: RuntimeRequest) { request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true, fixture: true } }); }
async function harness(runtime: CollaborationRuntime) {
  const dataDir = await mkdtemp(join(tmpdir(), 'continuous-http-'));
  let app = await createApplication({ dataDir, port: 0, collaborationRuntime: runtime });
  let address = await app.start();
  let bootstrap = await (await fetch(address.url + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
  const api = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(address.url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrfToken, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as any };
  };
  return {
    api, get url() { return address.url; }, get bootstrap() { return bootstrap; },
    detail: async (id: string) => (await api(`/api/conversations/${id}`)).data as ConversationDetail,
    restart: async () => { await app.close(); app = await createApplication({ dataDir, port: 0, collaborationRuntime: runtime }); address = await app.start(); bootstrap = await (await fetch(address.url + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap; },
    close: async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

test('continuous HTTP: natural message → real callback boundary → second member; success does not auto-wake caller; persistence and idempotency', async () => {
  const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe, async invoke(request) {
    calls.push(request); accepted(request);
    if (calls.length === 1) {
      const result = await request.onToolCall('collaboration_request', { targets: ['claude'], content: '请复核本文的结论并交付结果。' }, 'handoff-1');
      assert.ok(result);
      const replay = await request.onToolCall('collaboration_request', { targets: ['claude'], content: '请复核本文的结论并交付结果。' }, 'handoff-1');
      assert.equal((replay as { sourceId: string }).sourceId, (result as { sourceId: string }).sourceId);
    }
    exited(request); return { text: request.member.id === 'claude' ? '复核结果：结论可用。' : '已处理本次输入。', continuity: 'fresh' };
  } };
  const h = await harness(runtime);
  try {
    const body = { title: '持续协作验收', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: 'create-1' };
    const created = await h.api('/api/conversations', body); assert.equal(created.status, 201);
    const id = created.data.conversation.id;
    assert.equal((await h.api('/api/conversations', body)).data.conversation.id, id);
    assert.equal((await h.api('/api/conversations', { ...body, title: '不同内容' })).status, 409);
    const sent = { content: '分析这份方案，需要时请 Claude 复核。', requestId: 'message-1' };
    assert.equal((await h.api(`/api/conversations/${id}/messages`, sent)).status, 201);
    assert.equal((await h.api(`/api/conversations/${id}/messages`, sent)).status, 200);
    assert.equal((await h.api(`/api/conversations/${id}/messages`, { ...sent, content: '不同消息' })).status, 409);
    const detail = await until(() => h.detail(id), d => d.responses.length === 2 && d.responses.every(r => r.status === 'succeeded'));
    assert.equal(calls.length, 2); assert.deepEqual(calls.map(c => c.member.id), ['codex', 'claude']);
    assert.equal(detail.sources.filter(s => s.kind === 'a2a').length, 1);
    assert.equal(detail.sources.filter(s => s.kind === 'a2a_failure').length, 0);
    assert.equal(detail.consumptions.length, 2);
    assert.ok(detail.deliveries.every(d => d.status === 'consumed'));
    assert.ok(detail.invocations.every(i => i.acceptance === 'accepted' && i.teardown === 'confirmed'));
    await h.restart();
    assert.equal((await h.detail(id)).responses.length, 2); assert.equal(calls.length, 2);
    await h.api(`/api/conversations/${id}/messages`, { content: '继续整理最终结论。', requestId: 'message-2' });
    await until(() => h.detail(id), d => d.responses.length === 3 && d.responses.every(r => r.status === 'succeeded'));
    assert.match(calls[2]!.prompt, /复核结果/);
    assert.equal(calls[2]!.nativeSessionId, undefined, 'Round 1 does not claim native resume');
    const events = await fetch(h.url + '/api/collaboration/events?after=0');
    const reader = events.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /event: collaboration-event/); await reader.cancel();
  } finally { await h.close(); }
});

test('continuous HTTP: exact A2A failure creates one durable control source, and no recursive failure return', async () => {
  const calls: RuntimeRequest[] = [];
  const runtime: CollaborationRuntime = { probe, async invoke(request) {
    calls.push(request); accepted(request);
    if (calls.length === 1) { await request.onToolCall('collaboration_request', { targets: ['claude'], content: '执行需要失败回报的复核。' }, 'failure-test'); exited(request); return { text: '已交给 Claude。', continuity: 'fresh' }; }
    exited(request); throw new Error('受控故障：用于验证失败回报。');
  } };
  const h = await harness(runtime);
  try {
    const created = await h.api('/api/conversations', { title: '失败回报', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: 'failure-conversation' });
    const id = created.data.conversation.id;
    await h.api(`/api/conversations/${id}/messages`, { content: '请开始复核。', requestId: 'failure-message' });
    const detail = await until(() => h.detail(id), d => d.responses.length === 3 && d.responses.filter(r => r.status === 'failed').length === 2);
    assert.deepEqual(calls.map(c => c.member.id), ['codex', 'claude', 'codex']);
    assert.equal(detail.sources.filter(s => s.kind === 'a2a_failure').length, 1);
    await h.restart(); assert.equal(calls.length, 3); assert.equal((await h.detail(id)).sources.filter(s => s.kind === 'a2a_failure').length, 1);
  } finally { await h.close(); }
});

test('continuous HTTP: configuration is validated, CSRF required, key references do not expose secrets', async () => {
  const h = await harness({ probe, async invoke() { throw new Error('Unexpected provider call'); } });
  try {
    const account = { id: 'example-api', name: '测试 API 引用', provider: 'openai', auth: 'api', apiKeyEnv: 'COLLAB_TEST_KEY', baseUrl: 'http://127.0.0.1:9999/v1' };
    process.env.COLLAB_TEST_KEY = 'do-not-leak-this-secret';
    assert.equal((await h.api('/api/accounts', account, { 'x-csrf-token': '' })).status, 403);
    assert.equal((await h.api('/api/accounts', account, { origin: 'https://foreign.example' })).status, 403);
    assert.equal((await h.api('/api/accounts', { ...account, apiKey: 'no-inline-secrets' })).status, 400);
    assert.equal((await h.api('/api/accounts', { ...account, baseUrl: 'http://remote.example/v1' })).status, 400);
    const created = await h.api('/api/accounts', account); assert.equal(created.status, 200); assert.equal(created.data.account.configured, true);
    const b = await h.api('/api/collaboration/bootstrap'); assert.ok(!JSON.stringify(b.data).includes('do-not-leak-this-secret'));
    assert.equal((await h.api('/api/members', { id: 'api-agent', name: 'API 成员', carrier: 'openai-api', accountId: 'example-api', instructions: '', enabled: true, model: 'test-model' })).status, 200);
    assert.equal((await h.api('/api/members', { id: 'bad-agent', name: '不匹配', carrier: 'claude-cli', accountId: 'example-api', instructions: '', enabled: true })).status, 400);
  } finally { delete process.env.COLLAB_TEST_KEY; await h.close(); }
});

test('native CLI accounts: API authentication is independent of official login, requires endpoint/model, and retains only key references', async () => {
  const unavailableProbe: CollaborationRuntime['probe'] = async () => (await probe()).map(capability => ({ ...capability, available: false, reason: 'No official login in this fixture.' }));
  const h = await harness({ probe: unavailableProbe, async invoke() { throw new Error('Configuration test must not invoke a model'); } });
  const variable = 'COLLAB_NATIVE_AUTH_TEST'; const original = process.env[variable]; process.env[variable] = 'native-fixture-secret-do-not-expose';
  try {
    for (const [provider, carrier] of [['codex', 'codex-app-server'], ['claude', 'claude-cli']] as const) {
      const account = { id: `${provider}-api-test`, name: `${provider} API profile`, provider, auth: 'api', apiKeyEnv: variable, baseUrl: 'http://127.0.0.1:9999/compatible' };
      const missingEndpoint = await h.api('/api/accounts', { ...account, baseUrl: undefined });
      assert.equal(missingEndpoint.status, 400);
      assert.equal((await h.api('/api/accounts', { ...account, apiKeyEnv: undefined })).status, 400);
      assert.equal((await h.api('/api/accounts', { ...account, baseUrl: 'https://user:password@example.invalid' })).status, 400);
      const saved = await h.api('/api/accounts', account); assert.equal(saved.status, 200); assert.equal(saved.data.account.configured, true);
      assert.equal(saved.data.account.auth, 'api');
      const member = { id: `${provider}-key-member`, name: `${provider} key member`, instructions: '', carrier, accountId: account.id, enabled: true };
      const missingModel = await h.api('/api/members', member); assert.equal(missingModel.status, 400); assert.match(missingModel.data.error, /模型/);
      const savedMember = await h.api('/api/members', { ...member, model: 'explicit-test-model' }); assert.equal(savedMember.status, 200);
      assert.equal(savedMember.data.member.carrier, carrier, 'API auth must keep the native CLI carrier');
      assert.equal((await h.api('/api/members', { ...member, model: 'explicit-test-model', carrier: provider === 'codex' ? 'claude-cli' : 'codex-app-server' })).status, 400);
      assert.equal((await h.api('/api/accounts', { ...account, auth: 'cli' })).status, 409, 'Referenced account identity cannot silently switch authentication');
    }
    assert.equal((await h.api('/api/accounts', { id: 'invalid-cli', name: 'invalid CLI', provider: 'openai', auth: 'cli' })).status, 400);
    await h.restart();
    const result = await h.api('/api/collaboration/bootstrap');
    const b = result.data as CollaborationBootstrap;
    for (const provider of ['codex', 'claude']) {
      assert.equal(b.accounts.find(a => a.id === `${provider}-api-test`)?.configured, true, 'Official login probe does not invalidate explicit API authentication');
      assert.equal(b.accounts.find(a => a.id === `${provider}-cli`)?.auth, 'cli', 'Existing official-login profile is preserved');
      assert.equal(b.accounts.find(a => a.id === `${provider}-cli`)?.configured, false);
    }
    assert.ok(!JSON.stringify(b).includes('native-fixture-secret-do-not-expose'));
  } finally { if (original === undefined) delete process.env[variable]; else process.env[variable] = original; await h.close(); }
});
