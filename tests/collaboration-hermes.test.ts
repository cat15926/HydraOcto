import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';
import { supportsAccount } from '../shared/collaboration.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { RuntimeOutcomeUnknown } from '../server/collaboration/runtime-common.js';
import { hermesPython, probeHermes } from '../server/collaboration/runtime-hermes.js';

test('Hermes accepts compatible API accounts only and reports a missing installation', async () => {
  assert(supportsAccount('hermes-agent', { provider: 'codex', auth: 'api' }));
  assert(supportsAccount('hermes-agent', { provider: 'openai', auth: 'api' }));
  assert(!supportsAccount('hermes-agent', { provider: 'codex', auth: 'cli' }));
  assert(!supportsAccount('hermes-agent', { provider: 'claude', auth: 'api' }));
  assert.equal((await probeHermes('/missing/hermes/python')).installed, false);
});

test('installed Hermes executes a scoped read and form, rejects foreign paths and cancels a live instance', {
  skip: !existsSync(hermesPython()), timeout: 85000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hermes-fixture-'));
  await writeFile(join(cwd, 'note.txt'), 'only-in-fixture-357');
  const history: { names: string[]; messages: any[] }[] = [];
  const failures: string[] = [];
  let denialRound = 0, repeatId = false;
  let drop = false, rejectAuth = false, exerciseDenials = false, dropRequests = 0;
  let hold = false, reached!: () => void;
  const running = new Promise<void>(resolve => { reached = resolve; });
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' || req.url === '/api/show') { res.writeHead(404); res.end(); return; }
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const data of req) body += data.toString();
      const b = JSON.parse(body);
      assert.equal(b.model, 'fixture-model');
      history.push({ names: (b.tools || []).map((t: any) => t.function.name), messages: b.messages });
      if (drop) { dropRequests++; req.socket.destroy(); return; }
      if (rejectAuth) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture denied' } })); return; }
      if (hold) { reached(); return; }
      const denialCalls = [
        ['collaboration_request', { targets: ['other'], content: 'private' }],
        ['user_question', { questions: [{ id: 'choice', question: '第一题' }] }],
        ['user_question', { questions: [{ id: 'choice', question: '替换问题' }] }],
      ] as const;
      const calls = exerciseDenials ? denialCalls : [
        ['workspace_read', { path: 'note.txt' }], ['workspace_read', { path: '../outside.txt' }],
        ['user_question', { questions: [{ id: 'color', question: '选择颜色', options: ['红', '蓝'] }] }],
      ] as const;
      const n = b.messages.filter((m: any) => m.role === 'tool').length;
      const requestIndex = exerciseDenials ? denialRound++ : n;
      const tc = calls[requestIndex];
      const response: any = { role: 'assistant', content: tc ? null : 'completed-357' };
      if (tc) response.tool_calls = [{ id: exerciseDenials && requestIndex > 0 ? (repeatId ? 'same-id' : 'question-' + requestIndex) : 'call-' + n, type: 'function', function: { name: tc[0], arguments: JSON.stringify(tc[1]) } }];
      const completion = { id: 'test-' + n, object: 'chat.completion', created: 1, model: b.model,
        choices: [{ index: 0, message: response, finish_reason: tc ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (response.tool_calls) response.tool_calls[0].index = 0;
        res.end('data: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: response, finish_reason: tc ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(completion)); }
    } catch (e) { failures.push(String(e)); res.writeHead(400); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const runtime = createCollaborationRuntime({ timeoutMs: 35000 });
  const events: RuntimeEvent[] = [];
  const calls: string[] = [];
  const request: RuntimeRequest = { invocationId: 'test-hermes', conversationId: 'test-thread', cwd,
    member: { id: 'hermes', name: 'Hermes', instructions: '', enabled: true, carrier: 'hermes-agent', model: 'fixture-model', accountId: 'a' },
    account: { id: 'a', name: 'compatible', provider: 'openai', auth: 'api', apiKeyEnv: 'HERMES_FIXTURE_KEY', baseUrl: 'http://127.0.0.1:' + port + '/v1' },
    prompt: 'Read then ask', toolPolicyVersion: 'cross-action-v1', signal: new AbortController().signal,
    onEvent: e => events.push(e), onToolCall: async (name, args, callId) => { calls.push(name + '/' + callId); return { color: '蓝' }; } };
  const previous = process.env.HERMES_FIXTURE_KEY;
  process.env.HERMES_FIXTURE_KEY = 'fixture-only';
  try {
    const result = await runtime.invoke(request);
    assert.equal(result.text, 'completed-357');
    assert.deepEqual(failures, []);
    assert.deepEqual(calls, ['user_question/call-2']);
    assert(history.every(r => r.names.includes('workspace_read') && !r.names.includes('terminal')));
    const contents = history.at(-1)!.messages.filter(m => m.role === 'tool').map(m => m.content);
    assert(contents[0].includes('only-in-fixture-357'));
    assert(contents[1].includes('未获准'));
    assert(contents[2].includes('蓝'));
    assert.equal(events.filter(e => e.kind === 'accepted').length, 1);
    assert(events.some(e => e.kind === 'process_exit' && e.detail.confirmed));
    const ctrl = new AbortController();
    hold = true;
    const ending = runtime.invoke({ ...request, invocationId: 'hermes-cancel', signal: ctrl.signal });
    const rejected = assert.rejects(ending);
    await Promise.race([running, ending]);
    ctrl.abort();
    await rejected;
    assert.equal(events.filter(e => e.kind === 'accepted').length, 1);
    assert.equal(events.filter(e => e.kind === 'process_exit' && e.detail.confirmed).length, 2);
    hold = false;
    drop = true;
    await assert.rejects(runtime.invoke({ ...request, invocationId: 'hermes-disconnect' }), RuntimeOutcomeUnknown);
    assert.equal(dropRequests, 1);
    drop = false;
    rejectAuth = true;
    await assert.rejects(runtime.invoke({ ...request, invocationId: 'hermes-rejected' }), /API 地址、模型与账户权限/);
    rejectAuth = false;
    exerciseDenials = true;
    const privateResult = await runtime.invoke({ ...request, invocationId: 'hermes-private', visibility: { kind: 'private', memberIds: ['hermes'] } });
    assert.equal(privateResult.text, 'completed-357');
    const lastRound = history.at(-1)!;
    assert(!lastRound.names.includes('collaboration_request'));
    const toolContents = lastRound.messages.filter(m => m.role === 'tool').map(m => m.content);
    assert(toolContents.some(content => /does not exist|unknown tool/i.test(content)));
    assert.deepEqual(calls, ['user_question/call-2', 'user_question/question-1', 'user_question/question-2']);
    repeatId = true;
    denialRound = 0;
    await assert.rejects(runtime.invoke({ ...request, invocationId: 'hermes-invalid-id',
      visibility: { kind: 'private', memberIds: ['hermes'] } }), /重复的工具调用编号/);
    assert.equal(calls.filter(c => c === 'user_question/same-id').length, 1);
    assert.equal(denialRound, 3, 'A reused identity ends the turn before another provider request');
    assert.deepEqual(failures, []);
  } finally {
    if (previous === undefined) delete process.env.HERMES_FIXTURE_KEY; else process.env.HERMES_FIXTURE_KEY = previous;
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(cwd, { recursive: true, force: true });
  }
});
