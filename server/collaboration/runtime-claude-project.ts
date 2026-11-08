import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { RuntimeRequest } from '../../shared/collaboration.js';
import { cliEnv, executeTool, JsonProcess, runtimeTools, type Json } from './runtime-common.js';
import { verifyWorkspace } from './workbench.js';

export interface OfficialClaudeProject {
  run(command: string): Promise<{output: string; exitCode: number}>;
}

const projectCommand = {
  name: 'project_command',
  description: 'Run a shell command inside the authorized Linux project directory. Use this tool to inspect files, edit them, run tests and check Git. Each call starts in the project root.',
  inputSchema: {type:'object', properties:{command:{type:'string',minLength:1,maxLength:16000}}, required:['command'], additionalProperties:false},
};
const loginRequired = '请在运行服务的本机终端使用 claude auth login 登录 Claude 订阅账户，然后重试项目工作。';
const exec = promisify(execFile);

export function officialClaudeEnv(): NodeJS.ProcessEnv {
  const env = cliEnv();
  // The CLI owns the subscription. Commands run in a different OS, with a separate environment.
  return {
    HOME: env.HOME, PATH: env.PATH, USER: env.USER, LOGNAME: env.LOGNAME,
    ...(env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:env.CLAUDE_CONFIG_DIR} : {}),
    LANG: env.LANG, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', ENABLE_TOOL_SEARCH:'false',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1', CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1', CLAUDE_CODE_DISABLE_ORG_MEMORY:'1',
  };
}

/** A public status query, using the same profile and settings policy as the actual CLI. */
export async function officialClaudeIdentity(command: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const {stdout} = await exec(command, ['--safe-mode','--setting-sources','','auth','status','--json'],
      {cwd:'/', env:officialClaudeEnv(), timeout:6000, maxBuffer:16_384, signal});
    const status = JSON.parse(stdout);
    if (status.loggedIn === true && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty' &&
        typeof status.email === 'string' && status.email.trim() && status.email.length <= 320) return status.email.trim().toLowerCase();
  } catch { /* Keep raw status, errors and account details out of platform logs. */ }
}

/** The CLI's SDK MCP transport runs over the existing stdio pair. No host tool process or listener is needed. */
export function officialClaudeControl(request: RuntimeRequest, project: OfficialClaudeProject, proc: JsonProcess) {
  const tools = [...runtimeTools(request), projectCommand];
  const names = new Set(tools.map(tool => tool.name));
  const waiters = new Map<string,{resolve:(r:Json)=>void;reject:(e:Error)=>void}>();
  const used = new Set<string>();
  let authorized = false, finished = false;
  function close() {
    finished = true;
    for (const waiter of waiters.values()) waiter.reject(new Error('Claude 项目执行通道已关闭。'));
    waiters.clear();
  }
  void proc.closed.then(close);
  async function control(subtype: string): Promise<Json> {
    request.signal.throwIfAborted();
    if (finished) throw new Error('Claude 项目执行通道已关闭。');
    const id = randomUUID();
    const answer = new Promise<Json>((resolve,reject) => waiters.set(id,{resolve,reject}));
    try {
      proc.send({type:'control_request',request_id:id,request:{subtype}});
      return await answer;
    } finally { waiters.delete(id); }
  }
  async function mcp(message: Json): Promise<Json> {
    const {id,method,params} = message;
    function result(value: unknown) { return {jsonrpc:'2.0',id,result:value}; }
    function error(code: number, message: string) { return {jsonrpc:'2.0',id,error:{code,message}}; }
    if (method === 'notifications/initialized' && id === undefined) return {jsonrpc:'2.0',result:{}};
    if (!Number.isSafeInteger(id) && !(typeof id === 'string' && id.length > 0 && id.length <= 128)) throw new Error();
    if (method === 'initialize') return result({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'platform',version:'1'}});
    if (method === 'ping') return result({});
    if (method === 'tools/list') return result({tools});
    if (method !== 'tools/call' || !authorized || finished || request.signal.aborted || !names.has(params?.name))
      return error(-32601,'Tool unavailable for this execution.');
    const callId = 'claude-project:' + JSON.stringify(id);
    if (used.has(callId) || used.size >= 256) return error(-32600,'Tool call already received or invocation limit reached.');
    used.add(callId);
    try {
      verifyWorkspace(request.workspaceGrant!);
      const args = params.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
      if (params.name === projectCommand.name) {
        if (Object.keys(args).length !== 1 || typeof args.command !== 'string' || !args.command.trim() ||
            args.command.includes('\0') || Buffer.byteLength(args.command) > 16000) throw new Error();
        const detail = {origin:'platform',name:projectCommand.name,callId,commandDigest:createHash('sha256').update(args.command).digest('hex')};
        request.onEvent({kind:'tool',detail:{...detail,state:'started'}});
        let response;
        try { response = await project.run(args.command); }
        catch { request.onEvent({kind:'tool',detail:{...detail,state:'unknown'}}); throw new Error(); }
        request.onEvent({kind:'tool',detail:{...detail,state:response.exitCode === 0 ? 'completed' : 'failed',exitCode:response.exitCode}});
        return result({content:[{type:'text',text:JSON.stringify(response)}],isError:response.exitCode !== 0});
      }
      const value = await executeTool(request,params.name,args,callId);
      return result({content:[{type:'text',text:JSON.stringify(value)}]});
    } catch { return result({content:[{type:'text',text:'Project tool failed. Inspect the original invocation before repeating commands.'}],isError:true}); }
  }
  return {
    close,
    async initialize(expectedEmail: string) {
      const {account} = await control('initialize');
      if (!account || account.apiProvider !== 'firstParty' || typeof account.email !== 'string' ||
          account.email.trim().toLowerCase() !== expectedEmail ||
          ![undefined,'none'].includes(account.apiKeySource) || ![undefined,'claude.ai'].includes(account.tokenSource) ||
          typeof account.subscriptionType !== 'string' || !account.subscriptionType.trim()) throw new Error(loginRequired);
      // Safe mode still honors enterprise policy. A managed hook or endpoint could otherwise act
      // on the user's prompt. Inspect the CLI's effective settings without persisting their values.
      const {effective,sources} = await control('get_settings');
      if (!effective || effective.disableAllHooks !== true || Object.keys(effective).length !== 1 ||
          !Array.isArray(sources) || sources.length !== 1 || sources[0]?.source !== 'flagSettings')
        throw new Error('Claude 存在其他生效的设置，无法确认宿主工具和项目执行隔离。请使用独立的 Claude 运行环境。');
      // The CLI connects the in-process MCP server asynchronously after initialization.
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const {mcpServers} = await control('mcp_status');
        if (!Array.isArray(mcpServers) || mcpServers.some(s => s?.name !== 'platform')) break;
        if (mcpServers.length === 1 && mcpServers[0].status === 'connected') {
          const available = mcpServers[0].tools;
          if (Array.isArray(available) && available.length === names.size && [...names].every(n => available.some((t:Json) => t?.name === n))) return;
          if (Array.isArray(available) && available.length) break;
        }
        await delay(60,undefined,{signal:request.signal});
      }
      throw new Error('Claude 未能确认本轮授权的项目工具，请检查 CLI 版本并重试。');
    },
    enableTools() { authorized = true; },
    receive(frame: Json): boolean {
      if (frame.type === 'control_response') {
        const message = frame.response, waiter = waiters.get(message?.request_id);
        if (waiter) {
          waiters.delete(message.request_id);
          if (message.subtype === 'success') waiter.resolve(message.response ?? {});
          else waiter.reject(new Error('Claude 拒绝了项目身份或工具核对。'));
        }
        return true;
      }
      if (frame.type !== 'control_request') return false;
      const {request_id:id,request:body} = frame;
      if (typeof id !== 'string' || id.length > 256) throw new Error('Claude 控制回执无效。');
      const answer = async () => {
        if (body?.subtype !== 'mcp_message' || body.server_name !== 'platform' || body.message?.jsonrpc !== '2.0') throw new Error();
        return {mcp_response:await mcp(body.message)};
      };
      void answer().then(response => {
        if (!finished) proc.send({type:'control_response',response:{subtype:'success',request_id:id,response}});
      }, () => {
        if (!finished) proc.send({type:'control_response',response:{subtype:'error',request_id:id,error:'Unsupported project control request.'}});
      }).catch(() => proc.kill('SIGTERM'));
      return true;
    },
  };
}

export const officialClaudeLoginRequired = loginRequired;
