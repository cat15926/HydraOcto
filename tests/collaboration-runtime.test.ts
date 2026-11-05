import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { cliEnv, executeTool } from '../server/collaboration/runtime-common.js';
import type { Carrier, RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';

function request(carrier: Carrier, cwd: string, events: RuntimeEvent[], tools: unknown[], extra: Partial<RuntimeRequest> = {}): RuntimeRequest {
  const api = carrier.endsWith('-api');
  const provider = ({ 'codex-app-server': 'codex', 'claude-cli': 'claude', 'openai-api': 'openai', 'anthropic-api': 'anthropic' } as const)[carrier];
  return { invocationId: 'invocation-exact', conversationId: 'conversation-1', member: { id: 'member-1', name: 'Member', instructions: '', carrier, model: 'test-model', accountId: 'account-1', enabled: true }, account: { id: 'account-1', name: 'Account', provider, auth: api ? 'api' : 'cli' }, prompt: 'Task', cwd, signal: new AbortController().signal, onEvent: event => events.push(event), onToolCall: async (name, args, id) => { tools.push({ name, args, id }); return { sourceId: 'source-a2a' }; }, ...extra };
}
async function script(dir: string, name: string, source: string) {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}\n${source}`); await chmod(path, 0o700); return path;
}
const fakeCodex = `
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('codex-test 1'); process.exit(0); }
const send = v => console.log(JSON.stringify(v));
let turn = 'turn-exact';
readline.createInterface({input: process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{}}}});
 if(m.method==='thread/start'||m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId||'thread-exact'}}});
 if(m.method==='turn/start') {
   send({method:'turn/started',params:{threadId:'thread-exact',turn:{id:turn}}});
   send({id:m.id,result:{turn:{id:turn}}});
   send({id:99,method:'item/tool/call',params:{threadId:'thread-exact',turnId:turn,callId:'native-call-exact',tool:'collaboration_request',arguments:{targets:['member-2'],content:'Review'}}});
 }
 if(m.id===99&&m.result) { send({method:'item/agentMessage/delta',params:{threadId:'thread-exact',turnId:turn,delta:'Finished'}}); send({method:'turn/completed',params:{threadId:'thread-exact',turn:{id:turn,status:'completed',items:[]}}}); }
});`;

test('Codex: exact native A2A callback, acceptance receipts, resumed identity and observed process exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-codex-protocol-'));
  try {
    const codexPath = await script(dir, 'codex.cjs', fakeCodex);
    for (const nativeSessionId of [undefined, 'thread-exact']) {
      const events: RuntimeEvent[] = [], calls: unknown[] = [];
      const result = await createCollaborationRuntime({ codexPath, timeoutMs: 10000 }).invoke(request('codex-app-server', dir, events, calls, { nativeSessionId }));
      assert.equal(result.text, 'Finished'); assert.equal(result.continuity, nativeSessionId ? 'resumed' : 'fresh');
      assert.deepEqual(calls, [{ name: 'collaboration_request', args: { targets: ['member-2'], content: 'Review' }, id: 'native-call-exact' }]);
      assert.ok(events.some(e => e.kind === 'accepted' && e.detail.nativeTurnId === 'turn-exact'));
      assert.equal(events.at(-1)?.kind, 'process_exit');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Codex: transport exit without native receipt never becomes accepted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-codex-exit-'));
  try {
    const codexPath = await script(dir, 'codex.cjs', `process.stdin.on('data',()=>process.exit(1));`);
    const events: RuntimeEvent[] = [];
    await assert.rejects(createCollaborationRuntime({ codexPath, timeoutMs: 1000 }).invoke(request('codex-app-server', dir, events, [])));
    assert.equal(events.filter(e => e.kind === 'accepted').length, 0);
    assert.ok(events.some(e => e.kind === 'transport_settled' && e.detail.scope === 'preflight'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing API model and account mismatch fail before exposure and release only the preflight scope', async () => {
  process.env.COLLAB_TEST_KEY = 'test-secret';
  try {
    for (const mode of ['model', 'account'] as const) {
      const events: RuntimeEvent[] = [], input = request('openai-api', tmpdir(), events, []);
      input.account.apiKeyEnv = 'COLLAB_TEST_KEY';
      if (mode === 'model') delete input.member.model; else input.account.auth = 'cli';
      await assert.rejects(createCollaborationRuntime().invoke(input));
      assert.equal(events.some(e => e.kind === 'exposed'), false);
      assert.ok(events.some(e => e.kind === 'not_accepted'));
      assert.ok(events.some(e => e.kind === 'transport_settled' && e.detail.scope === 'preflight'));
    }
  } finally { delete process.env.COLLAB_TEST_KEY; }
});

test('API socket loss after request exposure keeps acceptance and transport termination unproven', async () => {
  const server = createServer(async (req, res) => { for await (const _chunk of req) { /* consume request */ } res.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.COLLAB_TEST_KEY = 'test-secret';
  try {
    const events: RuntimeEvent[] = [], input = request('openai-api', tmpdir(), events, []);
    input.account.apiKeyEnv = 'COLLAB_TEST_KEY'; input.account.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    await assert.rejects(createCollaborationRuntime({ timeoutMs: 1000 }).invoke(input));
    assert.ok(events.some(e => e.kind === 'exposed'));
    assert.equal(events.some(e => ['accepted', 'not_accepted', 'transport_settled'].includes(e.kind)), false);
  } finally { delete process.env.COLLAB_TEST_KEY; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Codex cancellation after accepted receipt waits for real close and does not invent a completed result', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-codex-cancel-'));
  try {
    const codexPath = await script(dir, 'codex.cjs', fakeCodex.replace("if(m.id===99&&m.result)", "if(false)"));
    const events: RuntimeEvent[] = [], controller = new AbortController();
    const input = request('codex-app-server', dir, events, [], { signal: controller.signal });
    input.onEvent = event => { events.push(event); if (event.kind === 'accepted') controller.abort(); };
    await assert.rejects(createCollaborationRuntime({ codexPath, timeoutMs: 3000 }).invoke(input));
    assert.ok(events.some(e => e.kind === 'accepted'));
    assert.equal(events.at(-1)?.kind, 'process_exit');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Claude: real stdio MCP bridge forwards a tool call with exact invocation callback, observes result + exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-claude-protocol-'));
  try {
    const claudePath = await script(dir, 'claude.cjs', `
      const cp=require('node:child_process'),readline=require('node:readline');
      if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'oauth'}));process.exit(0)}
      let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
        const sid=process.argv[process.argv.indexOf('--session-id')+1];
        const cfg=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]).mcpServers.platform;
        const bridge=cp.spawn(cfg.command,cfg.args,{env:process.env,stdio:['pipe','pipe','inherit']});
        const send=v=>console.log(JSON.stringify(v));
        send({type:'system',subtype:'init',session_id:sid});
        readline.createInterface({input:bridge.stdout}).on('line',line=>{
          const m=JSON.parse(line);
          if(m.id===1)bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'collaboration_request',arguments:{targets:['member-2'],content:'Review through MCP'}}})+'\\n');
          if(m.id===2){if(m.error||m.result.isError)process.exit(2);send({type:'assistant',session_id:sid,message:{id:'message-1',content:[{type:'text',text:'Delegated'}]}});send({type:'result',subtype:'success',session_id:sid,result:'Delegated',is_error:false});bridge.stdin.end();}
        });
        bridge.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\\n');
      });`);
    const events: RuntimeEvent[] = [], calls: unknown[] = [];
    const result = await createCollaborationRuntime({ claudePath, timeoutMs: 6000 }).invoke(request('claude-cli', dir, events, calls));
    assert.equal(result.text, 'Delegated'); assert.equal(result.continuity, 'fresh');
    assert.equal(calls.length, 1); assert.deepEqual((calls[0] as any).args.targets, ['member-2']);
    assert.ok(events.some(e => e.kind === 'accepted' && e.detail.evidence === 'assistant message'));
    assert.ok(events.some(e => e.kind === 'process_exit' && e.detail.confirmed === true)); assert.equal(events.at(-1)?.kind, 'session');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const carrier of ['openai-api', 'anthropic-api'] as const) test(`${carrier}: native tool calls and follow-up messages, no guessed session/teardown`, async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const first = requests.length === 1, anthropic = carrier === 'anthropic-api';
    assert.equal(anthropic ? req.headers['x-api-key'] : req.headers.authorization, anthropic ? 'test-secret' : 'Bearer test-secret');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(anthropic ? { id: `response-${requests.length}`, role: 'assistant', type: 'message', stop_reason: first ? 'tool_use' : 'end_turn', content: first ? [{ type: 'tool_use', id: 'call-1', name: 'collaboration_request', input: { targets: ['member-2'], content: 'Review API' } }] : [{ type: 'text', text: 'API complete' }] } : { id: `response-${requests.length}`, choices: [{ finish_reason: first ? 'tool_calls' : 'stop', message: first ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'collaboration_request', arguments: JSON.stringify({ targets: ['member-2'], content: 'Review API' }) } }] } : { role: 'assistant', content: 'API complete' } }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.COLLAB_TEST_KEY = 'test-secret';
  try {
    const events: RuntimeEvent[] = [], calls: unknown[] = [];
    const input = request(carrier, tmpdir(), events, calls);
    input.account.apiKeyEnv = 'COLLAB_TEST_KEY'; input.account.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const result = await createCollaborationRuntime().invoke(input);
    assert.equal(result.text, 'API complete'); assert.equal(calls.length, 1); assert.equal(requests.length, 2);
    assert.equal(events.at(-1)?.kind, 'transport_settled'); assert.equal(events.some(e => e.kind === 'process_exit'), false);
    assert.equal(JSON.stringify(events).includes('test-secret'), false);
  } finally { delete process.env.COLLAB_TEST_KEY; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('workspace tools reject symlink escape, hidden paths and unsupported tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-tools-'));
  try {
    await writeFile(join(dir, 'visible.txt'), 'allowed'); await symlink('/etc/hosts', join(dir, 'outside.txt'));
    await writeFile(join(dir, '.secret'), 'private');
    const input = request('openai-api', dir, [], []);
    assert.equal(await executeTool(input, 'workspace_read', { path: 'visible.txt' }, 'r1'), 'allowed');
    await assert.rejects(executeTool(input, 'workspace_read', { path: 'outside.txt' }, 'r2'));
    await assert.rejects(executeTool(input, 'workspace_read', { path: '.secret' }, 'r3'));
    await assert.rejects(executeTool(input, 'shell', { command: 'echo unsupported' }, 'r4'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('malformed assistant JSON cannot become a successful result or an acceptance receipt', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: {}, finish_reason: 'stop' }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  process.env.COLLAB_TEST_KEY = 'test-secret';
  try {
    const events: RuntimeEvent[] = [], input = request('openai-api', tmpdir(), events, []);
    input.account.apiKeyEnv = 'COLLAB_TEST_KEY'; input.account.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    await assert.rejects(createCollaborationRuntime().invoke(input), /invalid assistant/);
    assert.equal(events.some(e => e.kind === 'accepted'), false);
    assert.ok(events.some(e => e.kind === 'transport_settled' && e.detail.confirmed));
  } finally { delete process.env.COLLAB_TEST_KEY; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Codex API credentials stay in selected child env; custom Responses provider and native model are verified without OAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-codex-apikey-'));
  process.env.COLLAB_SELECTED_TEST_API_KEY = 'selected-fixture-key';
  process.env.COLLAB_OTHER_TEST_API_KEY = 'other-fixture-key';
  try {
    const codexPath = await script(dir, 'codex.cjs', fakeCodex
      .replace("const readline = require('node:readline');", `
        const assert=require('node:assert/strict');
        const selected=process.argv.includes('model_provider="platform_api"');
        assert.equal(process.env.COLLAB_OTHER_TEST_API_KEY,undefined);
        assert.equal(process.env.COLLAB_SELECTED_TEST_API_KEY,undefined);
        assert.equal(process.argv.join(' ').includes('selected-fixture-key'),false);
        if(selected)assert.equal(process.env.COLLAB_SELECTED_RUNTIME_API_KEY,'selected-fixture-key');
        const readline=require('node:readline');`)
      .replace("if(m.method==='account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});", "if(m.method==='account/read')process.exit(88);")
      .replace("if(m.method==='config/read') send({id:m.id,result:{config:{mcp_servers:{}}}});", `if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{},...(selected?{model_provider:'platform_api',model_providers:{platform_api:{env_key:'COLLAB_SELECTED_RUNTIME_API_KEY',base_url:'https://api.deepseek.com',wire_api:'responses',requires_openai_auth:false,supports_websockets:false}}}:{})}}});`)
      .replace("send({id:m.id,result:{thread:{id:m.params.threadId||'thread-exact'}}});", `{
        assert.equal(m.params.modelProvider,'platform_api');assert.equal(m.params.model,'deepseek-flash');
        send({id:m.id,result:{thread:{id:m.params.threadId||'thread-exact'},modelProvider:'platform_api',model:'deepseek-flash'}});
      }`));
    const events: RuntimeEvent[] = [], calls: unknown[] = [];
    const input = request('codex-app-server', dir, events, calls);
    input.account.auth = 'api'; input.account.apiKeyEnv = 'COLLAB_SELECTED_TEST_API_KEY'; input.account.baseUrl = 'https://api.deepseek.com'; input.member.model = 'deepseek-flash';
    const result = await createCollaborationRuntime({ codexPath, timeoutMs: 3000 }).invoke(input);
    assert.equal(result.text, 'Finished'); assert.equal(calls.length, 1);
    assert.ok(events.some(e => e.kind === 'session' && e.detail.authentication === 'api' && e.detail.modelProvider === 'platform_api' && e.detail.model === 'deepseek-flash'));
    assert.ok(events.some(e => e.kind === 'diagnostic' && e.detail.oauthFallback === false));
    assert.equal(JSON.stringify(events).includes('selected-fixture-key'), false);
    assert.equal(events.at(-1)?.kind, 'process_exit');
  } finally { delete process.env.COLLAB_SELECTED_TEST_API_KEY; delete process.env.COLLAB_OTHER_TEST_API_KEY; await rm(dir, { recursive: true, force: true }); }
});

test('Claude API credentials bypass OAuth probing and isolate gateway, model and bearer key per child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-claude-apikey-'));
  process.env.COLLAB_SELECTED_TEST_API_KEY = 'selected-fixture-key';
  process.env.COLLAB_OTHER_TEST_API_KEY = 'other-fixture-key';
  const oldOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'unrelated-oauth-token';
  try {
    const claudePath = await script(dir, 'claude.cjs', `
      const assert=require('node:assert/strict');
      assert.equal(process.argv.includes('auth'),false);
      assert.equal(process.argv.join(' ').includes('selected-fixture-key'),false);
      assert.equal(process.env.COLLAB_SELECTED_TEST_API_KEY,undefined);
      assert.equal(process.env.COLLAB_OTHER_TEST_API_KEY,undefined);
      assert.equal(process.env.ANTHROPIC_API_KEY,undefined);
      assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN,undefined);
      assert.equal(process.env.ANTHROPIC_AUTH_TOKEN,'selected-fixture-key');
      assert.equal(process.env.ANTHROPIC_BASE_URL,'https://open.bigmodel.cn/api/anthropic');
      assert.equal(process.argv[process.argv.indexOf('--model')+1],'glm-5.3');
      for(const tier of ['HAIKU','SONNET','OPUS'])assert.equal(process.env['ANTHROPIC_DEFAULT_'+tier+'_MODEL'],'glm-5.3');
      let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
        const sid=process.argv[process.argv.indexOf('--session-id')+1];
        console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'glm-5.3',apiKeySource:'ANTHROPIC_AUTH_TOKEN'}));
        console.log(JSON.stringify({type:'assistant',session_id:sid,message:{id:'native-api-message',content:[{type:'text',text:'API CLI complete'}]}}));
        console.log(JSON.stringify({type:'result',subtype:'success',session_id:sid,is_error:false,result:'API CLI complete'}));
      });`);
    const events: RuntimeEvent[] = [], input = request('claude-cli', dir, events, []);
    input.account.auth = 'api'; input.account.apiKeyEnv = 'COLLAB_SELECTED_TEST_API_KEY'; input.account.baseUrl = 'https://open.bigmodel.cn/api/anthropic'; input.member.model = 'glm-5.3';
    const result = await createCollaborationRuntime({ claudePath, timeoutMs: 3000 }).invoke(input);
    assert.equal(result.text, 'API CLI complete');
    assert.ok(events.some(e => e.kind === 'session' && e.detail.authentication === 'api' && e.detail.model === 'glm-5.3'));
    assert.ok(events.some(e => e.kind === 'accepted'));
    assert.equal(JSON.stringify(events).includes('selected-fixture-key'), false);
    assert.ok(events.some(e => e.kind === 'process_exit' && e.detail.confirmed === true)); assert.equal(events.at(-1)?.kind, 'session');
  } finally {
    delete process.env.COLLAB_SELECTED_TEST_API_KEY; delete process.env.COLLAB_OTHER_TEST_API_KEY;
    if (oldOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldOauth;
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI API mode never falls back to an existing official login when key or model is missing', async () => {
  process.env.COLLAB_SELECTED_TEST_API_KEY = 'selected-fixture-key';
  try {
    for (const carrier of ['codex-app-server', 'claude-cli'] as const) for (const missing of ['key', 'model']) {
      const events: RuntimeEvent[] = [], input = request(carrier, tmpdir(), events, []);
      input.account.auth = 'api'; input.account.apiKeyEnv = missing === 'key' ? 'COLLAB_ABSENT_TEST_KEY' : 'COLLAB_SELECTED_TEST_API_KEY';
      if (missing === 'model') delete input.member.model;
      await assert.rejects(createCollaborationRuntime({ codexPath: '/nonexistent-cli', claudePath: '/nonexistent-cli' }).invoke(input), /credential|explicit model/);
      assert.ok(events.some(e => e.kind === 'not_accepted'));
      assert.ok(events.some(e => e.kind === 'transport_settled' && e.detail.scope === 'preflight'));
      assert.equal(events.some(e => e.kind === 'prepared' || e.kind === 'accepted'), false);
    }
  } finally { delete process.env.COLLAB_SELECTED_TEST_API_KEY; }
});

test('CLI environment allow-list excludes credential references with arbitrary names', () => {
  process.env.DS_KEY = 'fixture-ds-key'; process.env.MY_TOKEN = 'fixture-another-key';
  try {
    const env = cliEnv();
    assert.equal(env.DS_KEY, undefined); assert.equal(env.MY_TOKEN, undefined);
    assert.equal(env.PATH, process.env.PATH); assert.equal(env.HOME, process.env.HOME);
  } finally { delete process.env.DS_KEY; delete process.env.MY_TOKEN; }
});

test('Claude API session rejects missing/different model or an OAuth authentication conflict before acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-claude-api-conflict-'));
  process.env.COLLAB_SELECTED_TEST_API_KEY = 'selected-fixture-key';
  try {
    for (const variant of ['missing-model', 'different-model', 'oauth']) {
      const claudePath = await script(dir, `claude-${variant}.cjs`, `
        process.stdin.resume();process.stdin.on('end',()=>{
          const sid=process.argv[process.argv.indexOf('--session-id')+1];
          console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:${variant === 'missing-model' ? 'undefined' : JSON.stringify(variant === 'different-model' ? 'other-model' : 'glm-5.3')},apiKeySource:${JSON.stringify(variant === 'oauth' ? 'oauth_token' : 'ANTHROPIC_AUTH_TOKEN')}}));
          setTimeout(()=>{},10000);
        });`);
      const events: RuntimeEvent[] = [], input = request('claude-cli', dir, events, []);
      input.account.auth = 'api'; input.account.apiKeyEnv = 'COLLAB_SELECTED_TEST_API_KEY'; input.account.baseUrl = 'https://open.bigmodel.cn/api/anthropic'; input.member.model = 'glm-5.3';
      await assert.rejects(createCollaborationRuntime({ claudePath, timeoutMs: 3000 }).invoke(input), /confirm the selected account model|conflicting authentication source/);
      assert.equal(events.some(e => e.kind === 'accepted'), false); assert.equal(events.at(-1)?.kind, 'process_exit');
    }
  } finally { delete process.env.COLLAB_SELECTED_TEST_API_KEY; await rm(dir, { recursive: true, force: true }); }
});
