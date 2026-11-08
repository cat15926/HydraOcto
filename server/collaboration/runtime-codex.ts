import { codexInput } from './runtime-images.js';
import type { AppendObservation, InputHandoff, RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { cliApiSettings, cliEnv, executeTool, JsonProcess, RuntimeProtocolError, runtimeTools, type Json } from './runtime-common.js';
import { gatewayPlaceholder, guestProject, type ProjectCli } from './project-vm.js';
import { nativePermissionTarget } from './native-permission-target.js';
import { NativeFileApprovals, codexFileChange } from './native-file-approval.js';
import { NativeToolEvidence } from './native-tool-evidence.js';
import { projectAccountFingerprint, verifiedProjectCodexHome, restoreOfficialCheckpoint, saveOfficialCheckpoint } from './official-codex-history.js';
import { officialProjectNetworkEnv } from './project-official-network.js';

const API_PROVIDER = 'platform_api';
const API_KEY_VARIABLE = 'COLLAB_SELECTED_RUNTIME_API_KEY';
const projectDiscoveryTimeoutMs = 30_000;
const appendSupport = new Map<string, Promise<boolean>>();

function recordProjectRpcFailure(request: RuntimeRequest, stage: 'config_discovery' | 'controller', error: unknown) {
  if (error instanceof RuntimeProtocolError) {
    request.onEvent({kind:'diagnostic',detail:{
      observation:'codex_rpc_rejected', stage, ...(error.method && {method:error.method}),
      ...(error.code !== undefined && {code:error.code}),
    }});
  }
}

function projectPath(path: unknown): boolean {
  if (typeof path !== 'string' || !path.length) return false;
  const resolved = posix.resolve(guestProject,path);
  return resolved === guestProject || resolved.startsWith(guestProject + '/');
}

function projectToolReceipt(item: Json): boolean {
  if (item?.type === 'commandExecution') return typeof item.cwd === 'string' && posix.isAbsolute(item.cwd) && projectPath(item.cwd) &&
    ['agent','unifiedExecStartup','unifiedExecInteraction'].includes(item.source ?? 'agent');
  if (item?.type === 'fileChange') return Array.isArray(item.changes) && item.changes.every((change:Json) =>
    projectPath(change?.path) && (change.kind?.move_path == null || projectPath(change.kind.move_path)));
  return true;
}
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

function codexArgs(project: boolean) {
  const nativeTools = project ? '--enable' : '--disable';
  return ['app-server', '--listen', 'stdio://', nativeTools, 'shell_tool', nativeTools, 'unified_exec', '--disable', 'apps', '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'hooks', '--disable', 'skill_search', '--enable', 'skip_host_skill_discovery', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}'];
}
export const CODEX_ARGS = codexArgs(false);
export async function initializeCodex(process: JsonProcess) {
  await process.call('initialize', { clientInfo: { name: 'multi-agent-collab', title: 'Continuous collaboration', version: '0.2.0' }, capabilities: { experimentalApi: true } });
  process.send({ method: 'initialized', params: {} });
}
/** Discover configuration names without starting a thread, then disable each inherited MCP entry.
 * An empty map is insufficient: Codex merges maps with user/project config. No config file is edited.
 */
interface DiscoveryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  stateArgs?: string[];
  progress?(stage:'initialize'|'config/read', state:'started'|'completed'|'failed'|'cancelled'|'timeout', elapsedMs:number):void;
}
async function discoverMcpSetting(command: string, cwd: string | undefined, env: NodeJS.ProcessEnv, options: DiscoveryOptions) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 6000);
  const signal = options.signal ? AbortSignal.any([options.signal,deadline]) : deadline;
  signal.throwIfAborted();
  const started = Date.now();
  let stage:'initialize'|'config/read' = 'initialize';
  const discovery = new JsonProcess(command, [...CODEX_ARGS,...(options.stateArgs ?? [])], { cwd, env });
  let abort!:()=>void;
  const cancelled = new Promise<never>((_,reject)=>{ abort=()=>reject(signal.reason); });
  signal.addEventListener('abort',abort,{once:true});
  try {
    options.progress?.(stage,'started',0);
    await Promise.race([initializeCodex(discovery),cancelled]);
    stage='config/read';
    options.progress?.(stage,'started',Date.now()-started);
    signal.throwIfAborted();
    const { config } = await Promise.race([discovery.call('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) }),cancelled]);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Codex 未返回有效的配置发现回执。');
    const disabled = Object.keys(config?.mcp_servers ?? {}).map(name => `${JSON.stringify(name)}={enabled=false}`).join(',');
    options.progress?.(stage,'completed',Date.now()-started);
    return `mcp_servers={${disabled}}`;
  } catch (error) {
    const state = options.signal?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'failed';
    options.progress?.(stage,state,Date.now()-started);
    if (state==='timeout') throw new Error(`Codex 配置发现超时（${stage}），尚未启动项目会话。`);
    if (state==='cancelled') throw new Error(`Codex 配置发现已取消（${stage}）。`);
    throw error;
  } finally { signal.removeEventListener('abort',abort); await discovery.stop(); }
}
export async function isolatedCodexArgs(command: string, cwd?: string, env = cliEnv(), options: DiscoveryOptions = {}): Promise<string[]> {
  return [...CODEX_ARGS, '-c', await discoverMcpSetting(command,cwd,env,options)];
}
export async function invokeCodex(request: RuntimeRequest, command: string, project?: ProjectCli): Promise<RuntimeResult> {
  if (project && request.account.auth === 'cli') {
    if (!project.officialCodex) throw new Error('此项目执行缺少官方 Codex 的隔离工具连接。');
    const scratch = await mkdtemp(join(await realpath(tmpdir()), 'multi-agent-codex-controller-'));
    try { return await runCodex(request, command, project, scratch); }
    finally { await rm(scratch, {recursive:true, force:true}); }
  }
  return runCodex(request, command, project);
}

async function runCodex(request: RuntimeRequest, command: string, project?: ProjectCli, scratch?: string): Promise<RuntimeResult> {
  const api = request.account.auth === 'api' ? cliApiSettings(request) : undefined;
  const canAppend = ['cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(request.toolPolicyVersion ?? '') && (project ? true : await supportsCodexAppend(command));
  const cwd = scratch ?? (project ? guestProject : request.cwd);
  const usesHostProxy = !!scratch || (!project && request.webResearch && request.account.auth === 'cli');
  const env = usesHostProxy ? await officialProjectNetworkEnv(cliEnv()) : project ? {} as NodeJS.ProcessEnv : cliEnv();
  const historyHome = request.account.codexHome === 'project' ? verifiedProjectCodexHome(request.cwd) : undefined;
  if (historyHome && (!scratch || !project || !request.sessionPlan?.identity?.projectAccountFingerprint)) throw new Error('项目专用登录缺少已核验的项目执行身份。');
  if (historyHome) env.CODEX_HOME = historyHome;
  // A resumed controller implicitly selects its default remote. Register the current lease
  // under that very ID so it cannot select a second, unauthenticated environment.
  const environmentId = historyHome ? 'remote' : scratch ? 'project-' + randomUUID() : undefined;
  const environments = environmentId ? [{environmentId,cwd:guestProject,runtimeWorkspaceRoots:[guestProject]}] : undefined;
  if (scratch && project?.officialCodex) {
    const {url,bearer} = project.officialCodex;
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || !bearer) throw new Error('项目执行工具必须使用本次授权的回环连接。');
    env.CODEX_SQLITE_HOME = scratch;
    // Login remains under native CLI management. Only the controller knows its home.
    const bypass = [env.NO_PROXY ?? env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
    env.NO_PROXY = env.no_proxy = bypass;
  }
  if (request.projectReview && api) {
    env.HOME = cwd;
    env.CODEX_HOME = join(cwd,'.codex');
    await mkdir(env.CODEX_HOME, {mode:0o700});
  }
  const args = project ? codexArgs(true) : await isolatedCodexArgs(command, cwd, env);
  if (request.webResearch) args.push('-c','web_search="disabled"');
  if (scratch && project?.officialCodex) {
    const stateArgs = ['-c',`log_dir=${JSON.stringify(scratch)}`,'-c',`sqlite_home=${JSON.stringify(scratch)}`];
    const setting = await discoverMcpSetting(command,cwd,env,{
      stateArgs,signal:request.signal,timeoutMs:projectDiscoveryTimeoutMs,
      progress:(stage,state,elapsedMs)=>request.onEvent({kind:'diagnostic',detail:{
        observation:'codex_config_discovery',stage,state,elapsedMs,timeoutMs:projectDiscoveryTimeoutMs,
      }}),
    }).catch(error => {
      recordProjectRpcFailure(request,'config_discovery',error);
      throw error;
    });
    // Only the working controller connects to the guest. Its default executor is
    // remote and unauthorized until environment/add binds this invocation.
    env.CODEX_EXEC_SERVER_URL = project.officialCodex.url;
    args.push(...stateArgs,'--disable','multi_agent','--disable','multi_agent_v2','--disable','code_mode',
      '--disable','view_image','--disable','image_generation','--disable','in_app_browser','--disable','shell_snapshot','--disable','memories',
      '-c','model_provider="openai"','-c','chatgpt_base_url="https://chatgpt.com/backend-api/"','-c','project_doc_max_bytes=0','-c',setting);
  }
  const reviewProfile = request.projectReview ? 'review_' + randomUUID().replaceAll('-','') : undefined;
  if (reviewProfile) {
    args.push('--disable','view_image','--disable','image_generation','--disable','multi_agent','--disable','multi_agent_v2',
      '-c','project_doc_max_bytes=0','-c',`default_permissions=${JSON.stringify(reviewProfile)}`,
      '-c',`permissions.${reviewProfile}.filesystem={":root"="none",${JSON.stringify(cwd)}="read"}`,
      '-c',`permissions.${reviewProfile}.network.enabled=false`);
  }
  if (api) {
    // Configuration is per child process; it does not overwrite login or user config files.
    env[API_KEY_VARIABLE] = project ? 'project-gateway' : api.key;
    args.push('-c', `model_provider=${JSON.stringify(API_PROVIDER)}`, '-c', `model_providers.${API_PROVIDER}={name="Platform API",base_url=${JSON.stringify(project ? gatewayPlaceholder + '/model/v1' : api.baseUrl)},env_key=${JSON.stringify(API_KEY_VARIABLE)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`, '-c', `model=${JSON.stringify(api.model)}`);
  }
  request.signal.throwIfAborted();
  const proc = new JsonProcess(command, args, { cwd, env, imageEchoBytes: request.images?.reduce((sum, image) => sum + image.base64.length, 0), transport: scratch ? undefined : project?.launch(args, env as Record<string,string>), onExit: (code, signal) => {
    if (scratch) request.onEvent({kind:'diagnostic',detail:{observation:'project_controller_exit',code,signal}});
    else request.onEvent({kind:'process_exit',detail:{code,signal,transport:'stdio',confirmed:true}});
  } });
  let nativeSessionId = '', nativeTurnId = '', text = '';
  const nativeTools = new NativeToolEvidence(project ? guestProject : cwd, request.onEvent);
  const fileApprovals = new NativeFileApprovals(request);
  const fileTargets = new Map<string,string>();
  const confirmFiles = !!project && request.projectWork && request.workspaceGrant?.nativeFileApprovals === true;
  let done = false;
  let invalidProjectReceipt = false;
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
  // The previous turn belongs to the same thread after resume. Only the reply to
  // this turn/start can identify the new turn if notifications arrive first.
  let waitForTurnReceipt = false;
  const pendingTurnFrames: Json[] = [];
  proc.onMessage = message => {
    if (waitForTurnReceipt && message.params?.threadId === nativeSessionId) {
      if (pendingTurnFrames.length >= 128) {
        fail(new Error('Codex 在返回本轮身份前发来过多消息。'));
        proc.kill('SIGTERM');
      } else pendingTurnFrames.push(message);
      return;
    }
    if (invalidProjectReceipt) return;
    const params: Json = message.params ?? {};
    if (message.id !== undefined && message.method) {
      void (async () => {
        if (message.method === 'item/tool/call' && !done && nativeSessionId && nativeTurnId &&
            params.threadId === nativeSessionId && params.turnId === nativeTurnId) {
          try {
            const result = await executeTool(request, params.tool, params.arguments, params.callId);
            proc.send({ id: message.id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
          } catch { proc.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: 'Tool request was rejected by the platform.' }] } }); }
        } else if (message.method === 'item/tool/requestUserInput' && matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(request.toolPolicyVersion ?? '')) {
          const response = await request.onInteraction({ providerRequestId: String(message.id), kind: 'question', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId,
            questions: Array.isArray(params.questions) ? params.questions.map((q: Json) => ({ id: q.id, question: q.question, ...(Array.isArray(q.options) ? { options: q.options.map((o: Json) => o.label) } : {}) })) : [], payload: params });
          const answers = Object.fromEntries(Object.entries(response.state === 'answered' ? response.answers ?? {} : {}).map(([id, answer]) => [id, { answers: [answer] }]));
          if (!done && !request.signal.aborted) proc.send({ id: message.id, result: { answers } });
        } else if (confirmFiles && message.method === 'item/fileChange/requestApproval' &&
            !done && !request.signal.aborted && nativeSessionId && nativeTurnId &&
            params.threadId === nativeSessionId && params.turnId === nativeTurnId && params.grantRoot == null) {
          const id = 'codex:'+JSON.stringify(message.id);
          if (!fileApprovals.hasItem(nativeSessionId,nativeTurnId,params.itemId))
            await fileApprovals.unavailable(nativeSessionId,nativeTurnId,params.itemId,id,message.method,nativePermissionTarget(message.method,params) ?? fileTargets.get(params.itemId));
          const decision = await fileApprovals.decide(nativeSessionId,nativeTurnId,params.itemId,id,'codex');
          if (decision !== 'closed' && !done && !request.signal.aborted) {
            proc.send({id:message.id,result:{decision}});
            if (decision === 'cancel') request.onNativePermissionCancelled?.();
          }
        } else if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          if (matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(request.toolPolicyVersion ?? '')) await request.onInteraction({ providerRequestId: String(message.id), kind: 'approval', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId, payload: {target:nativePermissionTarget(message.method,params)} });
          proc.send({ id: message.id, result: { decision: 'decline' } });
        } else if (message.method === 'item/permissions/requestApproval' || message.method === 'mcpServer/elicitation/request') {
          if (matches(params) && nativeTurnId && request.onInteraction && ['managed-artifacts-v1', 'cooperation-v2', 'visibility-memory-v1', 'cross-action-v1'].includes(request.toolPolicyVersion ?? '')) await request.onInteraction({ providerRequestId: String(message.id), kind: message.method.startsWith('mcpServer') ? 'elicitation' : 'approval', operation: message.method, nativeSessionId, nativeTurnId, nativeItemId: params.itemId, payload: {target:nativePermissionTarget(message.method,params)} });
          proc.send({ id: message.id, result: message.method.startsWith('mcpServer') ? { action: 'decline' } : { permissions: {}, scope: 'turn' } });
        } else proc.send({ id: message.id, error: { code: -32601, message: 'This client does not grant this capability.' } });
      })().catch(error => fail(error instanceof Error ? error : new Error('Tool response failed.')));
      return;
    }
    if (message.method === 'serverRequest/resolved' && params.threadId === nativeSessionId) { fileApprovals.closeRequest('codex:'+JSON.stringify(params.requestId)); request.onInteractionResolved?.(String(params.requestId)); return; }
    if (!nativeSessionId || !matches(params)) return;
    if (scratch) {
      const items = params.item ? [params.item] : Array.isArray(params.turn?.items) ? params.turn.items : [];
      invalidProjectReceipt = !items.every(projectToolReceipt);
      if (invalidProjectReceipt) {
        fail(new Error('Codex 的原生工具回执与授权的项目目录或执行来源不一致，已停止执行。'));
        proc.kill('SIGTERM');
        return;
      }
    }
    if (nativeTurnId && params.turnId === nativeTurnId && ['item/started', 'item/completed'].includes(message.method) && params.item) {
      if (confirmFiles && params.item.type === 'fileChange') {
        if (message.method === 'item/started') {
          fileApprovals.observe(nativeSessionId,nativeTurnId,params.item.id,codexFileChange(params.item),params.item.changes);
          const changes = params.item.changes;
          if (fileTargets.size < 128 && Array.isArray(changes)) {
            const paths = changes.slice(0,3).flatMap((change:Json) => [change?.path, change?.kind?.move_path].filter(p => typeof p === 'string'));
            const target = nativePermissionTarget('item/fileChange/requestApproval',{target:paths.join('、') + (changes.length > 3 ? ' 等 '+changes.length+' 项' : '')});
            if (target) fileTargets.set(params.item.id,target);
          }
        } else {
          fileTargets.delete(params.item.id);
          fileApprovals.closeItem(nativeSessionId,nativeTurnId,params.item.id);
        }
      }
      readItem(params.item);
      nativeTools.codex(nativeSessionId, nativeTurnId, params.item, message.method === 'item/started' ? 'started' : 'completed');
    }
    if (message.method === 'item/fileChange/patchUpdated' && params.turnId === nativeTurnId) fileApprovals.closeItem(nativeSessionId,nativeTurnId,params.itemId);
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
      fileApprovals.close();
      if (!nativeTurnId) nativeTurnId = params.turn.id;
      for (const item of params.turn.items ?? []) {
        readItem(item);
        if (item.status && item.status !== 'inProgress') nativeTools.codex(nativeSessionId, nativeTurnId, item, 'completed');
      }
      const finalMessages = (params.turn.items ?? []).filter((item: Json) => item.type === 'agentMessage').map((item: Json) => item.text ?? '');
      if (finalMessages.length) text = finalMessages.join('\n');
      if (params.turn.status === 'completed' || params.turn.status === 'failed') request.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: 'codex-app-server', nativeSessionId, nativeTurnId, status: params.turn.status === 'completed' ? 'succeeded' : 'failed', content: params.turn.status === 'completed' ? text : 'Codex 原生终态回执确认执行失败。', evidence: 'turn/completed' } });
      finish(params.turn);
      done = true;
    }
  };
  try {
    if (project) await project.ready;
    if (proc.pid !== undefined) request.onEvent({ kind: 'prepared', detail: { processStarted: true, transport: 'stdio' } });
    request.signal.throwIfAborted();
    await initializeCodex(proc);
    if (!api) {
      const account = await proc.call('account/read', { refreshToken: false });
      if (historyHome && projectAccountFingerprint(account) !== request.sessionPlan?.identity?.projectAccountFingerprint) {
        throw new Error('项目专用登录身份在派发后发生变化，请核对账户后重试。');
      }
      if (account.account?.type !== 'chatgpt') { request.onEvent({ kind: 'not_accepted', detail: { reason: 'Selected CLI account requires ChatGPT login; no model request was sent.' } }); throw new Error('Codex official CLI account requires ChatGPT login (codex login).'); }
    }
    const config = await proc.call('config/read', { includeLayers: false, cwd });
    if (Object.entries(config.config?.mcp_servers ?? {}).some(([, value]) => (value as Json)?.enabled !== false)) throw new Error('Codex configuration contains external MCP servers; this release requires them disabled for isolation.');
    if (scratch && project?.officialCodex) {
      if (config.config?.model_provider !== 'openai' || config.config?.model_providers?.openai != null ||
          config.config?.chatgpt_base_url !== 'https://chatgpt.com/backend-api/')
        throw new Error('Codex 未确认使用内置 OpenAI 提供方，请核对所选官方登录。');
      if (config.config?.sqlite_home !== scratch || ['multi_agent','multi_agent_v2','code_mode','computer_use','browser_use','in_app_browser','plugins','hooks','view_image','image_generation','memories'].some(flag => config.config?.features?.[flag] !== false))
        throw new Error('Codex 未确认隔离的状态库或宿主工具限制，已停止项目执行。');
      const {url,bearer} = project.officialCodex;
      const local = await proc.call('environment/status',{environmentId:'local'});
      if (local.status !== 'unknown') throw new Error('Codex 仍可使用宿主执行环境，已停止发送任务。');
      await proc.call('environment/add',{environmentId,execServerUrl:url,authBearerToken:bearer,connectTimeoutMs:5000});
      const info = await proc.call('environment/info',{environmentId});
      if (info.cwd !== 'file://' + guestProject) throw new Error('远程 Codex 执行器报告了其他项目目录。请重新验证工作区。');
    }
    if (api) {
      const selected = config.config?.model_providers?.[API_PROVIDER];
      if (config.config?.model_provider !== API_PROVIDER || selected?.env_key !== API_KEY_VARIABLE || selected?.base_url?.replace(/\/+$/, '') !== (project ? project.origin + '/model/v1' : api.baseUrl) || selected?.wire_api !== 'responses' || selected?.requires_openai_auth !== false || selected?.supports_websockets !== false) throw new Error('Codex API provider configuration did not match the selected account; no model request was sent.');
      if (['experimental_bearer_token', 'auth', 'gateway_oauth', 'aws', 'query_params', 'http_headers', 'env_http_headers'].some(key => selected[key] != null && (typeof selected[key] !== 'object' || Object.keys(selected[key]).length > 0))) throw new Error('Codex API provider contains inherited authentication or request overrides; refusing account fallback.');
      request.onEvent({ kind: 'diagnostic', detail: { authentication: 'api', evidence: 'config/read', modelProvider: API_PROVIDER, model: api.model, endpointOrigin: new URL(api.baseUrl).origin, credentialSource: project ? 'host_gateway' : 'selected_account_environment', oauthFallback: false } });
    }
    const options = { cwd, approvalPolicy: confirmFiles ? 'untrusted' : 'never', ...(reviewProfile ? {permissions:reviewProfile, runtimeWorkspaceRoots:[cwd]} : {sandbox: project && !scratch && !confirmFiles ? 'workspace-write' : 'read-only'}), ...(request.member.model ? { model: request.member.model } : {}), ...(api ? { modelProvider: API_PROVIDER } : {}) };
    let resumeId = request.nativeSessionId;
    const replace = (reason: string) => {
      request.onEvent({ kind: 'session_replaced', detail: { previousSessionId: resumeId, beforeInput: true, reason } }); resumeId = undefined;
    };
    const previousRollout = historyHome && restoreOfficialCheckpoint(historyHome,request);
    if (historyHome && resumeId && !previousRollout) replace('上次项目历史缺失或已变化，已用本会话上下文新建项目会话。');
    if (scratch && !historyHome && resumeId) replace('官方 Codex 使用本轮隔离工具连接，以平台会话上下文继续。');
    if (project && !historyHome && resumeId && (!request.sessionPlan?.previousAnchor || !project.history?.restored)) replace('原项目检查点缺失或与上一轮不符，输入发送前重建。');
    let session: Json | undefined;
    if (resumeId) {
      try { session = await proc.call('thread/resume', { ...options, threadId: resumeId, ...(historyHome ? {path:previousRollout, cwd:guestProject, runtimeWorkspaceRoots:[guestProject], modelProvider:'openai'} : {}), ...(project?.history?.restoredRolloutPath ? {path:project.history.restoredRolloutPath} : {}), excludeTurns: true }); }
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
    session ??= await proc.call('thread/start', { ...options, ephemeral: historyHome ? false : !!scratch || !!reviewProfile || (!!project && !project.history),
      ...(scratch ? {environments,selectedCapabilityRoots:[],multiAgentMode:'none',modelProvider:'openai',allowProviderModelFallback:false} : {}),
      dynamicTools: runtimeTools(request).map(tool => ({ type: 'function', ...tool })), developerInstructions: project ? `Work directly in the selected Linux project at ${guestProject}. Run native file and command tools in that directory to implement and verify the request. Use the platform tools for collaboration. Respect existing user changes.${request.gitDelivery ? ' For requested Git delivery use the native apply_patch file tool for edits. Then call project_git_deliver to present the approval card, even when the user asks to see the diff first. When asked for a PR or CI repair, set pullRequest=true. The tool waits for confirmation and performs the push; the platform tracks the PR and checks.' : ''}${confirmFiles ? ' Use project_environment_check for git --version, node --version, and pwd. It runs after user approval in a separate isolated project copy.' : ''}` : `Use only these platform tools: ${runtimeTools(request).map(t => t.name).join(', ')}. Never access files outside the supplied workspace. Native file changes are disabled. Ordinary tasks require explicit tools; A2A assistance does not transfer ownership.` });
    if (confirmFiles && (session.approvalPolicy !== 'untrusted' || session.cwd !== (historyHome && resumeId ? guestProject : cwd)))
      throw new Error('Codex 未确认项目目录和本轮文件审批策略。');
    if (typeof session.thread?.id !== 'string') throw new Error('Native session identity mismatch.');
    if (scratch) {
      const selected = session.thread.environments;
      if (session.cwd !== (historyHome && resumeId ? guestProject : scratch) || session.modelProvider !== 'openai' || (request.member.model && session.model !== request.member.model) ||
          session.thread.ephemeral !== !historyHome || !Array.isArray(session.instructionSources) || session.instructionSources.length ||
          !Array.isArray(selected) || selected.length !== 1 || selected[0]?.environmentId !== environmentId || selected[0].cwd !== guestProject ||
          !Array.isArray(selected[0].runtimeWorkspaceRoots) || selected[0].runtimeWorkspaceRoots.length !== 1 || selected[0].runtimeWorkspaceRoots[0] !== guestProject)
        throw new Error('Codex 未确认唯一的隔离项目工作区，已停止发送任务。');
      const status = await proc.call('environment/status',{environmentId});
      if (status.status !== 'ready') throw new Error('Codex 项目执行器已断开，请检查虚拟机后重试。');
      request.onEvent({kind:'diagnostic',detail:{authentication:'cli',evidence:'account/read + thread.environments + environment/status',modelProvider:'openai',environmentId,projectDirectory:guestProject}});
    }
    if (reviewProfile && (session.activePermissionProfile?.id !== reviewProfile || session.cwd !== cwd ||
        !Array.isArray(session.instructionSources) || session.instructionSources.length)) throw new Error('Codex 未确认独立的评审目录与访问范围。');
    if (api && (session.modelProvider !== API_PROVIDER || session.model !== api.model)) throw new Error('Native Codex session did not retain the selected API provider and model.');
    nativeSessionId = session.thread.id;
    const continuity = resumeId ? 'resumed' : 'fresh';
    request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity, evidence: resumeId ? 'thread/resume response + saved turn anchor' : 'thread/start response', previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined, ...(api ? { authentication: 'api', modelProvider: session.modelProvider, model: session.model } : { authentication: 'cli' }) } });
    request.signal.throwIfAborted();
    request.onEvent({ kind: 'exposed', detail: { nativeSessionId, clientUserMessageId: request.invocationId } });
    waitForTurnReceipt = !!confirmFiles || (!!historyHome && !!resumeId);
    const started = await proc.call('turn/start', { threadId: nativeSessionId, clientUserMessageId: request.invocationId, ...(confirmFiles ? {approvalPolicy:'untrusted', sandboxPolicy:{type:'readOnly',networkAccess:false}} : project ? {sandboxPolicy:{type:'externalSandbox',networkAccess:'restricted'}} : {}), ...(scratch ? {environments,multiAgentMode:'none'} : {}), ...(request.member.effort ? { effort: request.member.effort } : {}), input: codexInput(request) });
    if (typeof started.turn?.id !== 'string') throw new Error('Missing native turn identity.');
    if (nativeTurnId && started.turn.id !== nativeTurnId) throw new Error('Native turn identity mismatch.');
    nativeTurnId = started.turn.id;
    request.onEvent({ kind: 'accepted', detail: { nativeSessionId, nativeTurnId, evidence: 'turn/start response', clientUserMessageId: request.invocationId } });
    request.onEvent({ kind: 'session', detail: { nativeSessionId, nativeTurnId } });
    waitForTurnReceipt = false;
    for (const message of pendingTurnFrames) proc.onMessage(message);
    pendingTurnFrames.length = 0;
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
    done = true;
    let historyVerified = !reviewProfile;
    if (project) {
      historyVerified = false;
      if (historyHome || (project.history && !scratch)) {
        let rollout: string | undefined;
        if (historyHome) {
          try {
            const snapshot = await proc.call('thread/read',{threadId:nativeSessionId,includeTurns:false});
            const latest = await proc.call('thread/turns/list',{threadId:nativeSessionId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
            if (snapshot.thread?.id === nativeSessionId && typeof snapshot.thread.path==='string' &&
                latest.data?.[0]?.id===nativeTurnId && latest.data[0].status==='completed') rollout = snapshot.thread.path;
          } catch (error) {
            request.signal.throwIfAborted();
            if (!(error instanceof RuntimeProtocolError)) throw error;
            recordProjectRpcFailure(request,'controller',error);
          }
        }
        // EOF lets app-server flush its rollout. A stalled exit still uses the bounded process-group teardown.
        proc.endInput('');
        let grace: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([proc.closed,new Promise<void>(resolve => { grace = setTimeout(resolve, 6000); grace.unref(); })]); }
        finally { clearTimeout(grace); }
        fileApprovals.close();
        await proc.stop();
        request.signal.throwIfAborted();
        if (historyHome) {
          await project.close();
          historyVerified = !!rollout && proc.exitCode === 0 && project.treeExited &&
            saveOfficialCheckpoint(historyHome,request,rollout,nativeSessionId,nativeTurnId);
        } else historyVerified = project.treeExited && proc.exitCode === 0 && !!await project.history?.finish(nativeSessionId,nativeTurnId);
        request.signal.throwIfAborted();
      }
    }
    request.onEvent({ kind: 'session', detail: { nativeSessionId, nativeTurnId, continuity, ...(historyVerified ? {anchor:nativeTurnId} : {}), historyVerified,
      evidence: historyVerified ? historyHome ? 'thread/turn/completed + scoped official CLI checkpoint' : project ? 'thread/turn/completed + scoped guest checkpoint' : 'thread identity + turn/completed' : reviewProfile ? '一次性文件评审已结束' : '本轮缺少可续接的项目检查点',
      previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined } });
    return { text, nativeSessionId, nativeTurnId, continuity };
  } catch (error) {
    if (scratch) recordProjectRpcFailure(request,'controller',error);
    throw error;
  } finally { done = true; fileApprovals.close(); request.signal.removeEventListener('abort', abort); await proc.stop(); }
}
