import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Carrier, CollaborationRuntime, RuntimeInspectionRequest, RuntimeRequest } from '../shared/collaboration.js';
import { withRuntimeInspection } from '../server/collaboration/inspection.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';

function request(carrier: Carrier = 'codex-app-server', id = 'invocation-1'): RuntimeRequest {
  return {
    invocationId: id, conversationId: 'conversation-1',
    member: { id: 'member-1', accountId: 'account-1', name: 'Test', instructions: '', enabled: true, model: 'fixture-model', carrier },
    account: { id: 'account-1', name: 'Test account', provider: carrier === 'codex-app-server' ? 'codex' : carrier === 'claude-cli' ? 'claude' : carrier === 'openai-api' ? 'openai' : 'anthropic', auth: carrier.endsWith('-api') ? 'api' : 'cli' },
    prompt: 'Synthetic test only.', cwd: tmpdir(), signal: new AbortController().signal,
    onEvent: () => {}, onToolCall: async () => { throw new Error('No tool expected.'); },
  };
}
function observation(input: RuntimeRequest, nativeSessionId?: string, nativeTurnId?: string): RuntimeInspectionRequest {
  return { invocationId: input.invocationId, conversationId: input.conversationId, member: input.member, account: input.account, nativeSessionId, nativeTurnId };
}
const probe: CollaborationRuntime['probe'] = async () => [];
function receipts(input: RuntimeRequest) {
  input.onEvent({ kind: 'session', detail: { nativeSessionId: 'native-1', continuity: 'fresh' } });
  input.onEvent({ kind: 'accepted', detail: { nativeSessionId: 'native-1', nativeTurnId: 'turn-1', evidence: 'fixture-native' } });
}

test('inspection observes exact live invocation without sending, and returns immutable accepted result plus actual close', async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = withRuntimeInspection({ probe, async invoke(input) {
    calls++; receipts(input); await gate;
    input.onEvent({ kind: 'process_exit', detail: { code: 0, transport: 'stdio', confirmed: true } });
    return { text: 'Native result', nativeSessionId: 'native-1', nativeTurnId: 'turn-1', continuity: 'fresh' };
  } });
  const input = request(); const run = runtime.invoke(input);
  assert.equal((await runtime.inspect!(observation(input, 'native-1', 'turn-1'))).state, 'running');
  for (const query of [
    { ...observation(input), conversationId: 'another-conversation' },
    { ...observation(input), member: { ...input.member, instructions: 'changed' } },
    { ...observation(input), account: { ...input.account, id: 'another-account' } },
    { ...observation(input), workspaceScope: join(input.cwd, 'different-workspace') },
    observation(input, 'native-other'), observation(input, undefined, 'turn-other'),
  ]) {
    const mismatch = await runtime.inspect!(query);
    assert.equal(mismatch.state, 'unknown'); assert.equal(mismatch.teardown, 'unknown'); assert.equal(mismatch.result, undefined); assert.equal(mismatch.evidence.length, 0);
  }
  release(); await run;
  const final = await runtime.inspect!(observation(input, 'native-1', 'turn-1'));
  assert.equal(final.state, 'settled'); assert.equal(final.acceptance, 'accepted'); assert.equal(final.teardown, 'confirmed');
  assert.deepEqual(final.result, { status: 'succeeded', content: 'Native result' });
  final.evidence.length = 0; final.result!.content = 'mutated';
  assert.equal((await runtime.inspect!(observation(input))).result!.content, 'Native result');
  assert.ok((await runtime.inspect!(observation(input))).evidence.length > 0);
  await assert.rejects(runtime.invoke(input), /already been observed/); assert.equal(calls, 1);
});

test('inspection captures terminal and close before failing persistence callback, and never leaks selected credentials', async () => {
  process.env.COLLAB_INSPECT_TEST_KEY = 'synthetic-private-value';
  try {
    const runtime = withRuntimeInspection({ probe, async invoke(input) {
      try {
        receipts(input);
        input.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: 'codex-app-server', nativeSessionId: 'native-1', nativeTurnId: 'turn-1', status: 'succeeded', content: 'Done synthetic-private-value', apiKey: 'synthetic-private-value' } });
        return { text: 'unreachable', continuity: 'fresh' };
      } finally { input.onEvent({ kind: 'process_exit', detail: { code: 0, transport: 'stdio', confirmed: true } }); }
    } });
    const input = request(); input.account.apiKeyEnv = 'COLLAB_INSPECT_TEST_KEY';
    input.onEvent = event => { if (event.kind === 'diagnostic') throw new Error('Persistence unavailable.'); };
    await assert.rejects(runtime.invoke(input), /Persistence/);
    const result = await runtime.inspect!(observation(input));
    assert.equal(result.state, 'settled'); assert.equal(result.teardown, 'confirmed');
    assert.deepEqual(result.result, { status: 'succeeded', content: 'Done [redacted]' });
    assert.ok(!JSON.stringify(result).includes('synthetic-private-value')); assert.ok(!JSON.stringify(result).includes('apiKey'));
  } finally { delete process.env.COLLAB_INSPECT_TEST_KEY; }
});

test('throws, socket loss, and plain diagnostic text are not model terminal evidence', async () => {
  const runtime = withRuntimeInspection({ probe, async invoke(input) {
    input.onEvent({ kind: 'exposed', detail: { transport: 'http' } });
    input.onEvent({ kind: 'diagnostic', detail: { text: 'model completed successfully', result: 'succeeded' } });
    throw new Error('Transport failed after send.');
  } });
  const input = request('openai-api');
  await assert.rejects(runtime.invoke(input));
  const result = await runtime.inspect!(observation(input));
  assert.equal(result.state, 'unknown'); assert.equal(result.acceptance, 'unknown'); assert.equal(result.teardown, 'unknown'); assert.equal(result.result, undefined);
  assert.equal(result.evidence.length, 1);
});

test('CLI process_exit without an explicit true confirmation keeps teardown unknown', async () => {
  for (const carrier of ['codex-app-server', 'claude-cli'] as const) {
    for (const confirmed of [undefined, false, 'true', 1]) {
      const runtime = withRuntimeInspection({ probe, async invoke(input) {
        receipts(input);
        input.onEvent({ kind: 'process_exit', detail: { code: 0, transport: 'stdio', ...(confirmed === undefined ? {} : { confirmed }) } });
        return { text: 'A result does not prove process teardown.', continuity: 'fresh' };
      } });
      const input = request(carrier); await runtime.invoke(input);
      const result = await runtime.inspect!(observation(input));
      assert.equal(result.state, 'unknown'); assert.equal(result.teardown, 'unknown');
      assert.match(result.reason, /缺少准确的退出/);
    }
  }
});

test('oversized results are not silently truncated into a recoverable success', async () => {
  const runtime = withRuntimeInspection({ probe, async invoke(input) {
    receipts(input);
    input.onEvent({ kind: 'process_exit', detail: { code: 0, transport: 'stdio', confirmed: true } });
    return { text: 'x'.repeat(100_001), continuity: 'fresh' };
  } });
  const input = request(); const actual = await runtime.invoke(input);
  assert.equal(actual.text.length, 100_001);
  const inspected = await runtime.inspect!(observation(input));
  assert.equal(inspected.result, undefined); assert.equal(inspected.teardown, 'confirmed');
  assert.match(inspected.reason, /截断/);
});

test('preflight rejection can prove no host was started, but close alone cannot prove a model result', async () => {
  const runtime = withRuntimeInspection({ probe, async invoke(input) {
    if (input.invocationId === 'preflight') {
      input.onEvent({ kind: 'not_accepted', detail: { reason: 'No key' } });
      input.onEvent({ kind: 'transport_settled', detail: { scope: 'preflight', confirmed: true } });
    } else {
      input.onEvent({ kind: 'prepared', detail: { processStarted: true } });
      input.onEvent({ kind: 'process_exit', detail: { code: 1, transport: 'stdio', confirmed: true } });
    }
    throw new Error('Adapter did not return a result.');
  } });
  for (const id of ['preflight', 'closed']) {
    const input = request('codex-app-server', id); await assert.rejects(runtime.invoke(input));
    const result = await runtime.inspect!(observation(input));
    assert.equal(result.state, 'settled'); assert.equal(result.teardown, 'confirmed'); assert.equal(result.result, undefined);
    assert.equal(result.acceptance, id === 'preflight' ? 'not_accepted' : 'unknown');
  }
});

test('lost process observations and bounded cache eviction report unsupported, while active calls remain inspectable', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const base: CollaborationRuntime = { probe, async invoke(input) {
    if (input.invocationId === 'active') await gate;
    input.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true } });
    return { text: input.invocationId, continuity: 'fresh' };
  } };
  const runtime = withRuntimeInspection(base, { maxCompleted: 1 });
  const active = request('codex-app-server', 'active'); const activeRun = runtime.invoke(active);
  const first = request('codex-app-server', 'first'), second = request('codex-app-server', 'second');
  await runtime.invoke(first); await runtime.invoke(second);
  assert.equal((await runtime.inspect!(observation(first))).state, 'unsupported');
  assert.equal((await runtime.inspect!(observation(active))).state, 'running');
  assert.equal((await withRuntimeInspection(base).inspect!(observation(second))).state, 'unsupported');
  release(); await activeRun;
});

test('conflicting native identities and nonzero Claude exits never produce a successful recovery result', async () => {
  for (const mode of ['identity', 'exit'] as const) {
    const input = request(mode === 'identity' ? 'codex-app-server' : 'claude-cli');
    const runtime = withRuntimeInspection({ probe, async invoke(request) {
      receipts(request);
      if (mode === 'identity') request.onEvent({ kind: 'session', detail: { nativeSessionId: 'other-session' } });
      request.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: request.member.carrier, nativeSessionId: 'native-1', nativeTurnId: 'turn-1', status: 'succeeded', content: 'claimed success' } });
      request.onEvent({ kind: 'process_exit', detail: { code: 1, transport: 'stdio', confirmed: true } });
      throw new Error('Invalid lifecycle.');
    } });
    await assert.rejects(runtime.invoke(input));
    const result = await runtime.inspect!(observation(input));
    assert.equal(result.result, undefined);
    if (mode === 'identity') { assert.equal(result.state, 'unknown'); assert.equal(result.teardown, 'unknown'); }
  }
});

test('real API adapter exposes inspect without another HTTP request', async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ } calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'api-response-1', choices: [{ message: { role: 'assistant', content: 'HTTP fixture result' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.COLLAB_INSPECT_TEST_KEY = 'synthetic-key';
  try {
    const input = request('openai-api'); input.account.apiKeyEnv = 'COLLAB_INSPECT_TEST_KEY';
    input.account.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const runtime = createCollaborationRuntime(); await runtime.invoke(input);
    for (let i = 0; i < 3; i++) {
      const result = await runtime.inspect!(observation(input));
      assert.equal(result.state, 'settled'); assert.equal(result.acceptance, 'accepted'); assert.equal(result.teardown, 'confirmed');
      assert.equal(result.result?.content, 'HTTP fixture result');
    }
    assert.equal(calls, 1);
  } finally { delete process.env.COLLAB_INSPECT_TEST_KEY; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('native Codex and Claude adapters capture validated terminal receipts and real process close for inspection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-inspection-cli-'));
  async function script(name: string, content: string) { const path = join(dir, name); await writeFile(path, `#!${process.execPath}\n${content}`); await chmod(path, 0o700); return path; }
  try {
    const codexPath = await script('codex.cjs', `
      const send=v=>console.log(JSON.stringify(v));
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line); if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{}}}});
        if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
        if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-1'}}});
        if(m.method==='turn/start'){
          send({id:m.id,result:{turn:{id:'turn-1'}}});
          send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'Codex fixture result'}]}}});
        }
      });
    `);
    const claudePath = await script('claude.cjs', `
      if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'oauth'}));process.exit(0)}
      process.stdin.resume();process.stdin.on('end',()=>{
        const sid=process.argv[process.argv.indexOf('--session-id')+1],send=v=>console.log(JSON.stringify(v));
        send({type:'system',subtype:'init',session_id:sid});
        send({type:'result',subtype:'success',is_error:false,session_id:sid,result:'Claude fixture result',uuid:'result-1'});
      });
    `);
    for (const carrier of ['codex-app-server', 'claude-cli'] as const) {
      const runtime = createCollaborationRuntime({ codexPath, claudePath, timeoutMs: 10_000 });
      const input = request(carrier); input.cwd = dir;
      await runtime.invoke(input);
      const result = await runtime.inspect!(observation(input));
      assert.equal(result.state, 'settled'); assert.equal(result.acceptance, 'accepted'); assert.equal(result.teardown, 'confirmed');
      assert.equal(result.result?.status, 'succeeded');
      assert.ok(result.evidence.some(event => event.kind === 'diagnostic' && event.detail.observation === 'native_terminal'));
      assert.ok(result.evidence.some(event => event.kind === 'process_exit'));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
