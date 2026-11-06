import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { cliApiSettings, cliEnv, executeTool, JsonProcess, runtimeTools, type Json } from './runtime-common.js';
import { claudeTranscript, verifyClaudeHistory } from './runtime-session.js';

export async function invokeClaude(request: RuntimeRequest, command: string): Promise<RuntimeResult> {
  const api = request.account.auth === 'api' ? cliApiSettings(request) : undefined;
  let resumeId = request.nativeSessionId;
  if (resumeId && request.sessionPlan?.previousAnchor) {
    const rows = await claudeTranscript(request.cwd, resumeId);
    if (!rows || rows.filter(r => ['user', 'assistant'].includes(r.type)).at(-1)?.uuid !== request.sessionPlan.previousAnchor) {
      request.onEvent({ kind: 'session_replaced', detail: { previousSessionId: resumeId, beforeInput: true, reason: 'Claude 原生历史缺失、不可验证或末条记录发生变化，输入发送前重建。' } });
      resumeId = undefined;
    }
  }
  const env = cliEnv();
  if (api) {
    // Official Anthropic API uses x-api-key; custom gateways use documented bearer credentials.
    const authVariable = new URL(api.baseUrl).hostname === 'api.anthropic.com' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    env[authVariable] = api.key;
    env.ANTHROPIC_BASE_URL = api.baseUrl;
    for (const tier of ['HAIKU', 'SONNET', 'OPUS']) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = api.model;
    env.ANTHROPIC_MODEL = api.model;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    request.onEvent({ kind: 'diagnostic', detail: { authentication: 'api', evidence: 'selected CLI environment', model: api.model, endpointOrigin: new URL(api.baseUrl).origin, credentialSource: authVariable, oauthFallback: false } });
  }
  const token = randomBytes(32).toString('hex');
  const bridge = createServer((incoming, outgoing) => {
    void (async () => {
      const auth = incoming.headers.authorization ?? '', expected = `Bearer ${token}`;
      if (incoming.method !== 'POST' || incoming.url !== '/tool' || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { outgoing.writeHead(403); outgoing.end(); return; }
      let raw = '';
      for await (const chunk of incoming) { raw += String(chunk); if (Buffer.byteLength(raw) > 64_000) throw new Error('Tool payload too large.'); }
      const input = JSON.parse(raw) as Json;
      let result: unknown;
      if (input.method === 'tools/list') result = { tools: runtimeTools(request) };
      else if (input.method === 'tools/call') {
        try {
          const output = await executeTool(request, input.params?.name, input.params?.arguments ?? {}, String(input.id));
          result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
        } catch { result = { content: [{ type: 'text', text: 'Tool request rejected by platform.' }], isError: true }; }
      } else { outgoing.writeHead(400); outgoing.end(); return; }
      outgoing.writeHead(200, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify(result));
    })().catch(() => { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end(); });
  });
  bridge.requestTimeout = 15_000;
  await new Promise<void>((resolveListen, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', () => { bridge.removeListener('error', reject); resolveListen(); }); });
  const address = bridge.address();
  if (!address || typeof address === 'string') throw new Error('MCP bridge could not bind.');
  // Source and compiled layouts both resolve the same checked-in bridge.
  const sourceBridge = fileURLToPath(new URL('../../scripts/runtime/mcp-bridge.mjs', import.meta.url));
  const bridgePath = existsSync(sourceBridge) ? sourceBridge : resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts/runtime/mcp-bridge.mjs');
  const endpoint = `http://127.0.0.1:${address.port}/tool`;
  const mcpConfig = JSON.stringify({ mcpServers: { platform: { command: process.execPath, args: [bridgePath], env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', COLLAB_SELECTED_RUNTIME_API_KEY: '' } } } });
  const requestedSessionId = resumeId ?? randomUUID();
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', ...runtimeTools(request).map(tool => `mcp__platform__${tool.name}`), ...(request.member.model ? ['--model', request.member.model] : []), ...(request.member.effort ? ['--effort', request.member.effort] : []), ...(resumeId ? ['--resume', resumeId] : ['--session-id', requestedSessionId])];
  const proc = new JsonProcess(command, args, { cwd: request.cwd, env: { ...env, COLLAB_BRIDGE_ENDPOINT: endpoint, COLLAB_BRIDGE_TOKEN: token }, onExit: (code, signal) => request.onEvent({ kind: 'process_exit', detail: { code, signal, transport: 'stdio', confirmed: true } }) });
  let nativeSessionId: string | undefined, terminal: Json | undefined, text = '', accepted = false, assistantUuid: string | undefined;
  let failed: Error | undefined;
  proc.onFailure = (error, reason) => { if (reason !== 'closed') failed ??= error; };
  proc.onMessage = message => {
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id !== requestedSessionId) { failed = new Error('Claude native session identity mismatch.'); proc.kill('SIGTERM'); return; }
      nativeSessionId = message.session_id;
      if (api && message.model !== api.model) { failed = new Error('Claude CLI did not confirm the selected account model.'); proc.kill('SIGTERM'); return; }
      if (api && /oauth|claude[._ ]?ai|subscription/i.test(String(message.apiKeySource ?? ''))) { failed = new Error('Claude CLI reported a conflicting authentication source.'); proc.kill('SIGTERM'); return; }
      // --resume + an echoed ID alone does not prove history restoration.
      const apiKeySource = ['none', 'user', 'project', 'org', 'environment', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'].includes(message.apiKeySource) ? message.apiKeySource as string : undefined;
      request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity: resumeId ? 'unknown' : 'fresh', evidence: 'system.init', resumeRequested: Boolean(resumeId), authentication: request.account.auth, ...(api ? { model: message.model, apiKeySource: apiKeySource ?? 'unknown', credentialEvidence: apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'ANTHROPIC_AUTH_TOKEN' || apiKeySource === 'environment' ? 'native_environment_source' : 'selected_configuration_only' } : {}) } });
    }
    if (message.type === 'assistant' || message.type === 'result') {
      if (!nativeSessionId || message.session_id !== nativeSessionId) { failed = new Error('Claude response session mismatch.'); proc.kill('SIGTERM'); return; }
      if (!accepted && message.type === 'assistant') { accepted = true; request.onEvent({ kind: 'accepted', detail: { nativeSessionId, evidence: 'assistant message', nativeMessageId: message.message?.id } }); }
      if (message.type === 'assistant') {
        if (typeof message.uuid === 'string') assistantUuid = message.uuid;
        const content = (message.message?.content ?? []).filter((item: Json) => item.type === 'text').map((item: Json) => item.text).join('\n');
        if (content) { text += content; request.onEvent({ kind: 'text', detail: { text: content } }); }
      } else {
        terminal = message;
        if ((terminal.subtype === 'success' && !terminal.is_error) || terminal.is_error === true) request.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: 'claude-cli', nativeSessionId, status: terminal.is_error === true ? 'failed' : 'succeeded', content: terminal.is_error === true ? 'Claude 原生终态回执确认执行失败。' : typeof terminal.result === 'string' ? terminal.result : text, evidence: 'stream-json result', resultId: typeof terminal.uuid === 'string' ? terminal.uuid : undefined } });
      }
    }
  };
  const abort = () => { failed = new Error('Claude execution interrupted; inspect persisted acceptance evidence.'); proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 1000).unref(); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    if (proc.child.pid !== undefined) request.onEvent({ kind: 'prepared', detail: { processStarted: true, transport: 'stdio' } });
    request.signal.throwIfAborted();
    request.onEvent({ kind: 'exposed', detail: { evidence: 'stdin prepared', requestedSessionId } });
    proc.child.stdin.end(request.prompt);
    await proc.closed;
    if (failed || !terminal || terminal.is_error || terminal.subtype !== 'success' || proc.child.exitCode !== 0 || !nativeSessionId) throw new Error(terminal?.is_error ? 'Claude returned an unsuccessful result.' : failed?.message ?? 'Claude exited without a successful result.');
    if (!accepted) request.onEvent({ kind: 'accepted', detail: { nativeSessionId, evidence: 'successful result', resultId: terminal.uuid } });
    const rows = await claudeTranscript(request.cwd, nativeSessionId);
    const verified = verifyClaudeHistory(rows, request.prompt, assistantUuid, resumeId ? request.sessionPlan?.previousAnchor : undefined);
    const continuity = resumeId ? verified && !!request.sessionPlan?.previousAnchor ? 'resumed' : 'unknown' : 'fresh';
    request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity, historyVerified: verified, ...(verified ? { anchor: assistantUuid } : {}), previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined, evidence: verified ? 'stream assistant UUID + exact input + transcript parent chain' : 'transcript history proof unavailable' } });
    if (terminal.usage) request.onEvent({ kind: 'usage', detail: { source: 'stream-json result.usage', scope: 'invocation', inputTokens: terminal.usage.input_tokens, outputTokens: terminal.usage.output_tokens, cachedInputTokens: terminal.usage.cache_read_input_tokens, cacheWriteInputTokens: terminal.usage.cache_creation_input_tokens, costUsd: terminal.total_cost_usd } });
    return { text: typeof terminal.result === 'string' ? terminal.result : text, nativeSessionId, continuity };
  } finally {
    request.signal.removeEventListener('abort', abort);
    await proc.stop();
    bridge.closeAllConnections(); await new Promise<void>(resolveClose => bridge.close(() => resolveClose()));
  }
}
