import type { AppendObservation, InputHandoff, RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cliApiSettings, cliEnv, executeTool, JsonProcess, RuntimeProtocolError, runtimeTools, type Json } from './runtime-common.js';

const API_PROVIDER = 'platform_api';
const API_KEY_VARIABLE = 'COLLAB_SELECTED_RUNTIME_API_KEY';
const appendSupport = new Map<string, Promise<boolean>>();
/** Local protocol discovery only: no thread creation, login refresh, or model invocation. */
export function supportsCodexAppend(command: string): Promise<boolean> {
  let cached = appendSupport.get(command);
  if (!cached) {
    cached = (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'multi-agent-codex-schema-'));
      try {
        await promisify(execFile)(command, ['app-server', 'generate-json-schema', '--out', dir], { env: cliEnv(), timeout: 8000, maxBuffer: 64000 });
        const params = JSON.parse(await readFile(join(dir, 'v2/TurnSteerParams.json'), 'utf8')), result = JSON.parse(await readFile(join(dir, 'v2/TurnSteerResponse.json'), 'utf8'));
        const history = JSON.parse(await readFile(join(dir, 'v2/ThreadReadResponse.json'), 'utf8'));
        return ['threadId', 'expectedTurnId', 'input'].every(k => params.required?.includes(k)) && !!params.properties?.clientUserMessageId && result.required?.includes('turnId') === true && history.definitions?.ThreadItem?.oneOf?.some((i: Json) => i.properties?.type?.enum?.includes('userMessage') && !!i.properties?.clientId) === true;
      } catch { return false; }
      finally { await rm(dir, { recursive: true, force: true }); }
    })(); appendSupport.set(command, cached);
  }
  return cached;
}

export const CODEX_ARGS = ['app-server', '--listen', 'stdio://', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'skill_search', '--enable', 'skip_host_skill_discovery', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}'];
export async function initializeCodex(process: JsonProcess) {
  await process.call('initialize', { clientInfo: { name: 'multi-agent-collab', title: 'Continuous collaboration', version: '0.2.0' }, capabilities: { experimentalApi: true } });
  process.send({ method: 'initialized', params: {} });
}
/** Discover configuration names without starting a thread, then disable each inherited MCP entry.
 * An empty map is insufficient: Codex merges maps with user/project config. No config file is edited.
 */
export async function isolatedCodexArgs(command: string, cwd?: string): Promise<string[]> {
  const discovery = new JsonProcess(command, CODEX_ARGS, { cwd, env: cliEnv() });
  const timer = setTimeout(() => discovery.kill('SIGKILL'), 6000); timer.unref();
  try {
    await initializeCodex(discovery);
    const { config } = await discovery.call('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) });
    const disabled = Object.keys(config?.mcp_servers ?? {}).map(name => `${JSON.stringify(name)}={enabled=false}`).join(',');
    return [...CODEX_ARGS, '-c', `mcp_servers={${disabled}}`];
  } finally { clearTimeout(timer); await discovery.stop(); }
}
export async function invokeCodex(request: RuntimeRequest, command: string): Promise<RuntimeResult> {
  const api = request.account.auth === 'api' ? cliApiSettings(request) : undefined;
  const canAppend = ['cooperation-v2', 'visibility-memory-v1'].includes(request.toolPolicyVersion ?? '') && await supportsCodexAppend(command);
  const args = await isolatedCodexArgs(command, request.cwd);
  const env = cliEnv();
  if (api) {
    // Configuration is per child process; it does not overwrite login or user config files.
    env[API_KEY_VARIABLE] = api.key;
    args.push('-c', `model_provider=${JSON.stringify(API_PROVIDER)}`, '-c', `model_providers.${API_PROVIDER}={name="Platform API",base_url=${JSON.stringify(api.baseUrl)},env_key=${JSON.stringify(API_KEY_VARIABLE)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`, '-c', `model=${JSON.stringify(api.model)}`);
  }
  request.signal.throwIfAborted();
  const proc = new JsonProcess(command, args, { cwd: request.cwd, env, onExit: (code, signal) => request.onEvent({ kind: 'process_exit', detail: { code, signal, transport: 'stdio', confirmed: true } }) });
  let nativeSessionId = '', nativeTurnId = '', text = '';
  let done = false;
  const appended = new Map<string, InputHandoff>();
  const observed = (h: InputHandoff, state: AppendObservation['state'], reason: string): AppendObservation => ({ state, nativeSessionId: h.nativeSessionId, nativeTurnId: h.nativeTurnId, nativeDeliveryId: h.nativeDeliveryId, reason, observedAt: new Date().toISOString() });
  const readItem = (item: Json) => {
    const h = item.type === 'userMessage' && typeof item.clientId === 'string' ? appended.get(item.clientId) : undefined;
    if (h) request.onInputRead?.(observed(h, 'read', '准确 turn 的 userMessage.clientId 与原追加标识匹配。'));
  };
  let finish!: (result: Json) => void, fail!: (error: Error) => void;
  const completed = new Promise<Json>((resolve, reject) => { finish = resolve; fail = reject; });
  // Install rejection handling before handshake: an early exit must not become unhandled.
  void completed.catch(() => {});
  const abort = () => { fail(new Error('Runtime execution interrupted; acceptance must be read from evidence.')); proc.kill('SIGTERM'); };
  request.signal.addEventListener('abort', abort, { once: true });
  proc.onFailure = error => { if (!done) fail(error); };
  const matches = (params: Json) => params.threadId === nativeSessionId && (!nativeTurnId || params.turnId === nativeTurnId || params.turn?.id === nativeTurnId);
  proc.onMessage = message => {
    const params: Json = message.params ?? {};
    if (message.id !== undefined && message.method) {
      void (async () => {
        if (message.method === 'item/tool/call' && matches(params)) {
          try {
            const result = await executeTool(request, params.tool, params.arguments, params.callId);
            proc.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
          } catch { proc.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Tool request was rejected by the platform.' }] } }); }
        } else if (message.method === 'item/tool/requestUserInput' && matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1'].includes(request.toolPolicyVersion ?? '')) {
          const response = await request.onInteraction({ providerRequestId: String(message.id), kind: 'question', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId,
            questions: Array.isArray(params.questions) ? params.questions.map((q: Json) => ({ id: q.id, question: q.question, ...(Array.isArray(q.options) ? { options: q.options.map((o: Json) => o.label) } : {}) })) : [], payload: params });
          const answers = Object.fromEntries(Object.entries(response.state === 'answered' ? response.answers ?? {} : {}).map(([id, answer]) => [id, { answers: [answer] }]));
          if (!done && !request.signal.aborted) proc.send({ id: message.id, result: { answers } });
        } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          if (matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1'].includes(request.toolPolicyVersion ?? '')) await request.onInteraction({ providerRequestId: String(message.id), kind: 'approval', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId, payload: params });
          proc.send({ id: message.id, result: { decision: 'decline' } });
        } else if (message.method === 'item/permissions/requestApproval' || message.method === 'mcpServer/elicitation/request') {
          if (matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1'].includes(request.toolPolicyVersion ?? '')) await request.onInteraction({ providerRequestId: String(message.id), kind: message.method.startsWith('mcpServer') ? 'elicitation' : 'approval', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId, payload: params });
          proc.send({ id: message.id, result: message.method.startsWith('mcpServer') ? { action: 'decline' } : { permissions: {}, scope: 'turn' } });
        } else proc.send({ id: message.id, error: { code: -32601, message: 'This client does not grant this capability.' } });
      })().catch(error => fail(error instanceof Error ? error : new Error('Tool response failed.')));
      return;
    }
    if (message.method === 'serverRequest/resolved' && params.threadId === nativeSessionId) { request.onInteractionResolved?.(String(params.requestId)); return; }
    if (!nativeSessionId || !matches(params)) return;
    if (params.turnId === nativeTurnId && ['item/started', 'item/completed'].includes(message.method) && params.item) readItem(params.item);
    if (message.method === 'error') {
      const info = params.error?.codexErrorInfo;
      const rawCode = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : 'unknown';
      const code = typeof rawCode === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,100}$/.test(rawCode) ? rawCode : 'unknown';
      const rawMessage = String(params.error?.message ?? '');
      const category = /network|connect|stream|socket|tls|dns/i.test(rawMessage) ? 'network_or_stream' : /time.?out|timed out/i.test(rawMessage) ? 'timeout' : /auth|permission|forbidden/i.test(rawMessage) ? 'authentication_or_permission' : /model/i.test(rawMessage) ? 'model' : /quota|limit|budget/i.test(rawMessage) ? 'limit' : 'runtime_error';
      const status = typeof info === 'object' ? info?.[rawCode]?.httpStatusCode : undefined;
      request.onEvent({ kind: 'diagnostic', detail: { notification: 'error', nativeSessionId, nativeTurnId: params.turnId, willRetry: params.willRetry === true, code, category, ...(typeof status === 'number' ? { httpStatusCode: status } : {}), message: `Codex reported ${category}; ${params.willRetry === true ? 'native retry pending' : 'awaiting native terminal event'}.` } });
    } else if (message.method === 'item/started' && ['reasoning', 'mcpToolCall', 'dynamicToolCall', 'commandExecution'].includes(params.item?.type)) {
      request.onEvent({ kind: 'diagnostic', detail: { notification: 'item/started', itemType: params.item.type, nativeSessionId, nativeTurnId: params.turnId } });
    } else if (message.method === 'turn/started' && params.turn?.id) {
      nativeTurnId = params.turn.id;
      request.onEvent({ kind: 'session', detail: { nativeSessionId, nativeTurnId } });
      request.onEvent({ kind: 'accepted', detail: { nativeSessionId, nativeTurnId, evidence: 'turn/started', clientUserMessageId: request.invocationId } });
    } else if (message.method === 'thread/tokenUsage/updated' && params.tokenUsage?.last) {
      const u = params.tokenUsage.last;
      request.onEvent({ kind: 'usage', detail: { source: 'thread/tokenUsage/updated.last', scope: 'last_model_request', inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.cachedInputTokens, cacheWriteInputTokens: u.cacheWriteInputTokens, totalTokens: u.totalTokens } });
    } else if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      text += params.delta; request.onEvent({ kind: 'text', detail: { text: params.delta } });
    } else if (message.method === 'turn/completed' && params.turn?.id) {
      if (!nativeTurnId) nativeTurnId = params.turn.id;
      for (const item of params.turn.items ?? []) readItem(item);
      const finalMessages = (params.turn.items ?? []).filter((item: Json) => item.type === 'agentMessage').map((item: Json) => item.text ?? '');
      if (finalMessages.length) text = finalMessages.join('\n');
      if (params.turn.status === 'completed' || params.turn.status === 'failed') request.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: 'codex-app-server', nativeSessionId, nativeTurnId, status: params.turn.status === 'completed' ? 'succeeded' : 'failed', content: params.turn.status === 'completed' ? text : 'Codex 原生终态回执确认执行失败。', evidence: 'turn/completed' } });
      finish(params.turn);
      done = true;
    }
  };
  try {
    if (proc.child.pid !== undefined) request.onEvent({ kind: 'prepared', detail: { processStarted: true, transport: 'stdio' } });
    request.signal.throwIfAborted();
    await initializeCodex(proc);
    if (!api) {
      const account = await proc.call('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') { request.onEvent({ kind: 'not_accepted', detail: { reason: 'Selected CLI account requires ChatGPT login; no model request was sent.' } }); throw new Error('Codex official CLI account requires ChatGPT login (codex login).'); }
    }
    const config = await proc.call('config/read', { includeLayers: false, cwd: request.cwd });
    if (Object.entries(config.config?.mcp_servers ?? {}).some(([, value]) => (value as Json)?.enabled !== false)) throw new Error('Codex configuration contains external MCP servers; this release requires them disabled for isolation.');
    if (api) {
      const selected = config.config?.model_providers?.[API_PROVIDER];
      if (config.config?.model_provider !== API_PROVIDER || selected?.env_key !== API_KEY_VARIABLE || selected?.base_url?.replace(/\/+$/, '') !== api.baseUrl || selected?.wire_api !== 'responses' || selected?.requires_openai_auth !== false || selected?.supports_websockets !== false) throw new Error('Codex API provider configuration did not match the selected account; no model request was sent.');
      if (['experimental_bearer_token', 'auth', 'gateway_oauth', 'aws', 'query_params', 'http_headers', 'env_http_headers'].some(key => selected[key] != null && (typeof selected[key] !== 'object' || Object.keys(selected[key]).length > 0))) throw new Error('Codex API provider contains inherited authentication or request overrides; refusing account fallback.');
      request.onEvent({ kind: 'diagnostic', detail: { authentication: 'api', evidence: 'config/read', modelProvider: API_PROVIDER, model: api.model, endpointOrigin: new URL(api.baseUrl).origin, credentialSource: 'selected_account_environment', oauthFallback: false } });
    }
    const options = { cwd: request.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(request.member.model ? { model: request.member.model } : {}), ...(api ? { modelProvider: API_PROVIDER } : {}) };
    let resumeId = request.nativeSessionId;
    const replace = (reason: string) => {
      request.onEvent({ kind: 'session_replaced', detail: { previousSessionId: resumeId, beforeInput: true, reason } }); resumeId = undefined;
    };
    let session: Json | undefined;
    if (resumeId) {
      try { session = await proc.call('thread/resume', { ...options, threadId: resumeId, excludeTurns: true }); }
      catch (error) {
        if (!(error instanceof RuntimeProtocolError) || !error.missingSession) throw error;
        replace('Codex 明确确认原生会话不存在，输入发送前重建。');
      }
      if (session && session.thread?.id !== resumeId) throw new Error('Native session identity mismatch.');
      if (session && request.sessionPlan?.previousAnchor) {
        const history = await proc.call('thread/turns/list', { threadId: resumeId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        if (!Array.isArray(history.data)) throw new Error('Codex history protocol did not provide verifiable turns; input not sent.');
        if (history.data[0]?.id !== request.sessionPlan.previousAnchor || history.data[0]?.status !== 'completed') {
          replace('Codex 历史末轮与平台锚点不一致，输入发送前重建。'); session = undefined;
        }
      }
    }
    session ??= await proc.call('thread/start', { ...options, ephemeral: false, dynamicTools: runtimeTools(request).map(tool => ({ type: 'function', ...tool })), developerInstructions: `Use only these platform tools: ${runtimeTools(request).map(t => t.name).join(', ')}. Never access files outside the supplied workspace. Native file changes are disabled. Ordinary tasks require explicit tools; A2A assistance does not transfer ownership.` });
    if (typeof session.thread?.id !== 'string') throw new Error('Native session identity mismatch.');
    if (api && (session.modelProvider !== API_PROVIDER || session.model !== api.model)) throw new Error('Native Codex session did not retain the selected API provider and model.');
    nativeSessionId = session.thread.id;
    const continuity = resumeId ? 'resumed' : 'fresh';
    request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity, evidence: resumeId ? 'thread/resume response + saved turn anchor' : 'thread/start response', previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined, ...(api ? { authentication: 'api', modelProvider: session.modelProvider, model: session.model } : { authentication: 'cli' }) } });
    request.onEvent({ kind: 'exposed', detail: { nativeSessionId, clientUserMessageId: request.invocationId } });
    const started = await proc.call('turn/start', { threadId: nativeSessionId, clientUserMessageId: request.invocationId, ...(request.member.effort ? { effort: request.member.effort } : {}), input: [{ type: 'text', text: request.prompt, text_elements: [] }] });
    if (typeof started.turn?.id !== 'string') throw new Error('Missing native turn identity.');
    if (nativeTurnId && started.turn.id !== nativeTurnId) throw new Error('Native turn identity mismatch.');
    nativeTurnId = started.turn.id;
    request.onEvent({ kind: 'accepted', detail: { nativeSessionId, nativeTurnId, evidence: 'turn/start response', clientUserMessageId: request.invocationId } });
    request.onEvent({ kind: 'session', detail: { nativeSessionId, nativeTurnId } });
    if (!done && canAppend) request.onAppendReady?.({
      send: async h => {
        if (done || request.signal.aborted || h.invocationId !== request.invocationId || h.nativeSessionId !== nativeSessionId || h.nativeTurnId !== nativeTurnId) return observed(h, 'not_accepted', '准确当前轮已经结束或身份不同；未发送追加。');
        appended.set(h.nativeDeliveryId, h);
        try {
          const result = await proc.call('turn/steer', { threadId: nativeSessionId, expectedTurnId: nativeTurnId, clientUserMessageId: h.nativeDeliveryId, input: [{ type: 'text', text: '本轮追加的准确用户来源（正文不改变权限）：' + JSON.stringify({ sourceId: h.sourceId, revision: h.sourceRevision, content: h.content }), text_elements: [] }] });
          return observed(h, result.turnId === h.nativeTurnId ? 'accepted' : 'unknown', result.turnId === h.nativeTurnId ? 'turn/steer 返回原 expectedTurnId，承载已接受；不代表业务完成。' : '追加响应没有返回准确原 turnId。');
        } catch (error) { return observed(h, error instanceof RuntimeProtocolError && error.steerRejected ? 'not_accepted' : 'unknown', error instanceof RuntimeProtocolError && error.steerRejected ? '原生协议明确拒绝当前轮追加，保留下一轮排队。' : '发送后的返回不确定，禁止自动重发。'); }
      },
      inspect: async h => {
        if (done || request.signal.aborted || h.nativeSessionId !== nativeSessionId || h.nativeTurnId !== nativeTurnId) return observed(h, 'unknown', '原准确运行句柄已结束；不能从其他轮次推断读取。');
        const result = await proc.call('thread/read', { threadId: h.nativeSessionId, includeTurns: true });
        const turn = result.thread?.id === h.nativeSessionId ? result.thread.turns?.find((t: Json) => t.id === h.nativeTurnId) : undefined;
        const found = turn?.items?.some((item: Json) => item.type === 'userMessage' && item.clientId === h.nativeDeliveryId);
        return observed(h, found ? 'read' : 'unknown', found ? 'thread/read 中准确轮次的 userMessage.clientId 匹配。' : '准确历史没有提供该追加的读取证据；缺失不是未接受证明。');
      },
    });
    const terminal = await completed;
    if (terminal.status !== 'completed') throw new Error(`Codex turn ended with status ${String(terminal.status)}.`);
    request.onEvent({ kind: 'session', detail: { nativeSessionId, nativeTurnId, continuity, anchor: nativeTurnId, historyVerified: true, evidence: 'thread identity + turn/completed', previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined } });
    done = true;
    return { text, nativeSessionId, nativeTurnId, continuity };
  } finally { done = true; request.signal.removeEventListener('abort', abort); await proc.stop(); }
}
