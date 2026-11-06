import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverAccount, modelsFrom } from '../server/collaboration/account-discovery.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
test('N7 discovery: local native protocols return identity, per-model efforts and unknown/known quota without turn or user input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n7-discovery-')), command = join(dir, 'cli.mjs'), log = join(dir, 'calls.jsonl');
  await writeFile(command, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport readline from 'node:readline';\nconst args=process.argv.slice(2);\nif(args.includes('--version')){console.log('synthetic-cli 1.0');process.exit(0)}\nif(args[0]==='auth'){console.log(JSON.stringify({loggedIn:false}));process.exit(1)}\nfor await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n'); if(m.method==='initialized')continue; if(m.type==='control_request'){console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{models:[{value:'claude-fixture',displayName:'Claude fixture',supportedEffortLevels:['high']}]}}}));continue;} const result=m.method==='account/read'?{account:{type:'chatgpt',email:'synthetic@example.invalid'}}:m.method==='model/list'?{data:[{model:'codex-fixture',displayName:'Codex fixture',supportedReasoningEfforts:[{reasoningEffort:'low'}],isDefault:true}]}:m.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:37,resetsAt:1900000000}}}:{config:{mcp_servers:{}}}; console.log(JSON.stringify({id:m.id,result}));}\n`, { mode: 0o700 });
  try {
    const runtime = createCollaborationRuntime({ codexPath: command, claudePath: command });
    const codex = await runtime.discoverAccount!({ id: 'c', name: 'c', auth: 'cli', provider: 'codex', revision: 2 });
    assert.equal(codex.identity.state, 'authenticated'); assert.equal(codex.identity.label, 'synthetic@example.invalid'); assert.deepEqual(codex.models[0]?.efforts, ['low']); assert.equal(codex.quota.windows?.[0]?.usedPercent, 37);
    const claude = await discoverAccount({ id: 'a', name: 'a', auth: 'cli', provider: 'claude' }, { codex: command, claude: command });
    assert.equal(claude.identity.state, 'not_authenticated'); assert.equal(claude.quota.state, 'unknown'); assert.equal(claude.models[0]?.id, 'claude-fixture'); assert.deepEqual(claude.models[0]?.efforts, ['high']);
    const calls = await readFile(log, 'utf8'); assert.ok(!calls.includes('turn/start')); assert.ok(!calls.includes('thread/start')); assert.ok(!calls.includes('"type":"user"')); assert.ok(!calls.includes('login/start'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('N7 discovery: selected API endpoint uses only selected credentials, redacts unexpected returned secret and does not infer identity/quota', async () => {
  const secret = 'n7-secret-never-return', prior = process.env.N7_DISCOVERY_KEY; process.env.N7_DISCOVERY_KEY = secret;
  let calls = 0, redirect = false;
  const server = createServer((req, res) => { calls++; assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, `Bearer ${secret}`); if (redirect) { res.writeHead(302, { location: 'https://example.invalid/leak' }); res.end(); return; } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'model-a', name: 'A' }, { id: secret }] })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as { port: number }).port;
  try {
    const account = { id: 'api', name: 'API', auth: 'api' as const, provider: 'openai' as const, apiKeyEnv: 'N7_DISCOVERY_KEY', baseUrl: `http://127.0.0.1:${port}/v1`, revision: 7 };
    const result = await discoverAccount(account, { codex: '', claude: '' }); assert.equal(calls, 1); assert.equal(result.models[0]?.id, 'model-a'); assert.equal(result.identity.state, 'unknown'); assert.equal(result.quota.state, 'unknown'); assert.ok(!JSON.stringify(result).includes(secret));
    redirect = true; const denied = await discoverAccount(account, { codex: '', claude: '' }); assert.equal(calls, 2); assert.equal(denied.connection, 'unavailable'); assert.equal(denied.models.length, 0);
  } finally { await new Promise<void>(r => server.close(() => r())); if (prior === undefined) delete process.env.N7_DISCOVERY_KEY; else process.env.N7_DISCOVERY_KEY = prior; }
});
test('N7 discovery: malformed model entries do not generate global reasoning options', () => {
  assert.deepEqual(modelsFrom([{ id: 'known', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }, null, { id: 'known' }, { id: 123 }], 'api'), [{ id: 'known', name: 'known', efforts: [] }]);
});
