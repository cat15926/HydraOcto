import { anthropicContent } from './runtime-images.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { cliApiSettings, cliEnv, executeTool, JsonProcess, runtimeTools, type Json } from './runtime-common.js';
import { claudeTranscript, projectTranscript, verifyClaudeHistory } from './runtime-session.js';
import { gatewayPlaceholder, guestProject, type ProjectCli } from './project-vm.js';
import { claudeCommandApproval } from './native-command-approval.js';
import { nativePermissionTarget } from './native-permission-target.js';
import { NativeFileApprovals, claudeFileChange } from './native-file-approval.js';
import { NativeToolEvidence } from './native-tool-evidence.js';
import { officialClaudeControl, officialClaudeEnv, officialClaudeIdentity, officialClaudeLoginRequired } from './runtime-claude-project.js';
import { officialProjectNetworkEnv } from './project-official-network.js';

async function createClaudeBridge(request: RuntimeRequest) {
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
  return {mcpConfig, env:{COLLAB_BRIDGE_ENDPOINT:endpoint,COLLAB_BRIDGE_TOKEN:token}, close:async () => {
    bridge.closeAllConnections(); await new Promise<void>(resolveClose => bridge.close(() => resolveClose()));
  }};
}

export async function invokeClaude(request: RuntimeRequest, command: string, project?: ProjectCli): Promise<RuntimeResult> {
  if (project && request.account.auth === 'cli') {
    const grant = request.workspaceGrant;
    if (!project.officialClaude || !request.projectWork || request.projectReview || request.visibility?.kind === 'private' ||
        grant?.mode !== 'project-work' || grant.path !== request.cwd || grant.conversationId !== request.conversationId ||
        !grant.memberIds?.includes(request.member.id) || request.account.provider !== 'claude' || request.member.accountId !== request.account.id)
      throw new Error('Claude 官方账户缺少本轮项目工作授权。');
    const email = await officialClaudeIdentity(command,request.signal);
    if (!email) throw new Error(officialClaudeLoginRequired);
    if (request.nativeSessionId) request.onEvent({kind:'session_replaced',detail:{previousSessionId:request.nativeSessionId,beforeInput:true,reason:'Claude 项目工作使用本轮平台上下文。'}});
    const cwd = await mkdtemp(join(await realpath(tmpdir()),'multi-agent-claude-project-'));
    try { return await invokeClaudeProcess({...request,nativeSessionId:undefined},command,project,{cwd,email}); }
    finally { await rm(cwd,{recursive:true,force:true}); }
  }
  return invokeClaudeProcess(request,command,project);
}

async function invokeClaudeProcess(request: RuntimeRequest, command: string, project?: ProjectCli, official?: {cwd:string;email:string}): Promise<RuntimeResult> {
  const api = request.account.auth === 'api' ? cliApiSettings(request) : undefined;
  let resumeId = request.nativeSessionId;
  if (resumeId) {
    const rows = project ? projectTranscript(project.history?.restored ? project.history.beforeClaudeRows : undefined, resumeId) : await claudeTranscript(request.cwd, resumeId);
    if (!request.sessionPlan?.previousAnchor || !rows || rows.filter(r => ['user', 'assistant'].includes(r.type)).at(-1)?.uuid !== request.sessionPlan.previousAnchor) {
      request.onEvent({ kind: 'session_replaced', detail: { previousSessionId: resumeId, beforeInput: true, reason: 'Claude 原生历史缺失、不可验证或末条记录发生变化，输入发送前重建。' } });
      resumeId = undefined;
    }
  }
  const env = official ? await officialProjectNetworkEnv(officialClaudeEnv()) : project ? {} as NodeJS.ProcessEnv : cliEnv();
  if (request.projectReview) {
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    env.CLAUDE_CODE_DISABLE_ORG_MEMORY = '1';
  }
  if (api) {
    // Official Anthropic API uses x-api-key; custom gateways use documented bearer credentials.
    const authVariable = new URL(api.baseUrl).hostname === 'api.anthropic.com' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    env[authVariable] = project ? 'project-gateway' : api.key;
    env.ANTHROPIC_BASE_URL = project ? gatewayPlaceholder + '/model' : api.baseUrl;
    for (const tier of ['HAIKU', 'SONNET', 'OPUS']) env[`ANTHROPIC_DEFAULT_${tier}_MODEL`] = api.model;
    env.ANTHROPIC_MODEL = api.model;
    if (!project) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    request.onEvent({ kind: 'diagnostic', detail: { authentication: 'api', evidence: 'selected CLI environment', model: api.model, endpointOrigin: new URL(api.baseUrl).origin, credentialSource: project ? 'host_gateway' : authVariable, oauthFallback: false } });
  }
  const bridge = project ? {mcpConfig:JSON.stringify({mcpServers:{platform:official ? {type:'sdk',name:'platform'} : {type:'http',url:gatewayPlaceholder+'/mcp'}}}), env:{}, close:async () => {}} : await createClaudeBridge(request);
  const mcpConfig = bridge.mcpConfig;
  const requestedSessionId = resumeId ?? randomUUID();
  const confirmFiles = !!project && request.projectWork && request.workspaceGrant?.nativeFileApprovals === true;
  if (confirmFiles && (!api || official)) throw new Error('此账户无法逐次核对原生文件操作。请选用支持文件审批的成员。');
  const gate = new NativeFileApprovals(request);
  const inputUuid = randomUUID();
  let verifiedInput = false;
  const nativeToolsAllowed = confirmFiles ? ['Read','Glob','Grep','Write','Bash'] : project && !official ? ['Read','Glob','Grep','Edit','Write','Bash'] : [];
  const platformTools = runtimeTools(request).map(tool => 'mcp__platform__'+tool.name);
  if (official) platformTools.push('mcp__platform__project_command');
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', confirmFiles ? 'default' : 'dontAsk', '--tools', nativeToolsAllowed.join(','), '--disable-slash-commands', '--setting-sources', '', '--settings', confirmFiles ? '{"disableAllHooks":true,"permissions":{"ask":["Write","Bash"]}}' : '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', ...nativeToolsAllowed.filter(tool => !confirmFiles || !['Write','Bash'].includes(tool)), ...platformTools, ...(request.member.model ? ['--model', request.member.model] : []), ...(request.member.effort ? ['--effort', request.member.effort] : []), ...(resumeId ? ['--resume', resumeId] : ['--session-id', requestedSessionId])];
  if (request.projectReview) {
    args.push('--no-session-persistence');
    if (api) args.push('--bare');
  }
  if (official) {
    args.push('--safe-mode','--no-chrome','--no-session-persistence');
  }
  if (confirmFiles) args.push('--replay-user-messages','--permission-prompt-tool','stdio');
  const streamInput = Boolean(official || confirmFiles || request.images?.length);
  if (streamInput) args.push('--input-format','stream-json');
  const proc = new JsonProcess(command, args, { cwd: official?.cwd ?? request.cwd, env: { ...env, ...bridge.env },
    transport: official ? undefined : project?.launch(args, env as Record<string,string>),
    onExit: (code, signal) => request.onEvent(official
      ? {kind:'diagnostic',detail:{observation:'model_process_exit',carrier:'claude-cli',code,signal}}
      : {kind:'process_exit',detail:{code,signal,transport:'stdio',confirmed:true}}) });
  const control = official && project?.officialClaude ? officialClaudeControl(request,project.officialClaude,proc) : undefined;
  let nativeSessionId: string | undefined, terminal: Json | undefined, text = '', accepted = false, assistantUuid: string | undefined;
  let officialInputSent = false;
  let failed: Error | undefined;
  const nativeTools = new NativeToolEvidence(project ? guestProject : request.cwd, request.onEvent);
  proc.onFailure = (error, reason) => { if (reason !== 'closed') failed ??= error; };
  proc.onMessage = message => {
    if (control?.receive(message)) return;
    if (failed || request.signal.aborted) return;
    if (confirmFiles && message.type === 'control_cancel_request') {
      gate.closeRequest(message.request_id);
      return;
    }
    if (confirmFiles && message.type === 'control_request') {
      const body = message.request, id = message.request_id;
      if (typeof id !== 'string' || !id || id.length > 160) { proc.kill('SIGTERM'); return; }
      const respond = async () => {
        const input = body?.input;
        // Claude reports the explicit Write rule with its source; Bash reports only "rule".
        // In both cases the observed tool-use and this callback must match byte for byte.
        const flagRule = body?.matched_ask_rule;
        const matchesRule = flagRule ? flagRule.source === 'flagSettings' && flagRule.tool_name === body.tool_name :
          body?.tool_name === 'Bash' && body.decision_reason_type === 'rule';
        const eligible = !terminal && accepted && verifiedInput && nativeSessionId && body?.subtype === 'can_use_tool' &&
          ['Write','Bash'].includes(body.tool_name) && body.tool_use_id && matchesRule;
        if (verifiedInput && nativeSessionId && accepted && typeof body?.tool_use_id === 'string' && (!eligible || !gate.hasItem(nativeSessionId,inputUuid,body.tool_use_id))) {
          const operation = 'can_use_tool/' + (typeof body.tool_name === 'string' ? body.tool_name.slice(0,80) : 'unknown');
          await gate.unavailable(nativeSessionId,inputUuid,body.tool_use_id,id,operation,nativePermissionTarget(operation,body));
        }
        const decision = eligible ? await gate.decide(nativeSessionId!,inputUuid,body.tool_use_id,id,'claude',input,body.tool_name === 'Bash' ? 'command' : 'file') : 'decline';
        if (decision === 'closed' || terminal || request.signal.aborted) return;
        proc.send({type:'control_response',response:{subtype:'success',request_id:id,response:decision === 'accept'
          ? {behavior:'allow',updatedInput:input} : {behavior:'deny',message:'本次工具操作未获授权。',...(decision === 'cancel' ? {interrupt:true} : {})}}});
        if (decision === 'cancel') request.onNativePermissionCancelled?.();
      };
      void respond().catch(() => proc.kill('SIGTERM'));
      return;
    }
    if (confirmFiles && message.type === 'user' && !terminal && nativeSessionId && message.session_id === nativeSessionId && message.parent_tool_use_id === null) {
      if (message.isReplay === true && message.uuid === inputUuid && message.message?.role === 'user' &&
          Array.isArray(message.message.content) && JSON.stringify(message.message.content) === JSON.stringify(anthropicContent(request))) {
        verifiedInput = true;
        request.onEvent({kind:'session',detail:{nativeSessionId,nativeTurnId:inputUuid,evidence:'stream-json replayed user.uuid'}});
      }
      for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
        if (block?.type === 'tool_result') gate.closeItem(nativeSessionId,inputUuid,block.tool_use_id);
      }
    }
    if (control && !officialInputSent && (message.type === 'assistant' || message.type === 'result' || message.type === 'system' && message.subtype === 'init')) {
      failed = new Error('Claude 在项目身份核对完成前返回了会话数据。'); control.close(); proc.kill('SIGTERM'); return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      if (message.session_id !== requestedSessionId) { failed = new Error('Claude native session identity mismatch.'); proc.kill('SIGTERM'); return; }
      nativeSessionId = message.session_id;
      if (confirmFiles && (message.permissionMode !== 'default' || !Array.isArray(message.tools) || !message.tools.includes('Write') || message.tools.some((tool:string) => ![...nativeToolsAllowed,...platformTools].includes(tool)))) {
        failed = new Error('Claude Code 未确认本轮文件审批策略。'); proc.kill('SIGTERM'); return;
      }
      if (control) {
        if ((message.apiKeySource != null && message.apiKeySource !== 'none') || !Array.isArray(message.tools) ||
            !message.tools.includes('mcp__platform__project_command') || message.tools.some((tool:string) => !platformTools.includes(tool))) {
          failed = new Error('Claude 原生会话的账户或宿主工具范围发生变化。'); control.close(); proc.kill('SIGTERM'); return;
        }
        control.enableTools();
      }
      if (api && message.model !== api.model) { failed = new Error('Claude CLI did not confirm the selected account model.'); proc.kill('SIGTERM'); return; }
      if (api && /oauth|claude[._ ]?ai|subscription/i.test(String(message.apiKeySource ?? ''))) { failed = new Error('Claude CLI reported a conflicting authentication source.'); proc.kill('SIGTERM'); return; }
      if (request.projectReview && (api || request.projectReview.mode === 'project')) {
        const granted = platformTools.slice().sort();
        if (!Array.isArray(message.tools) || granted.length === 0 ||
            JSON.stringify(message.tools.slice().sort()) !== JSON.stringify(granted)) {
          failed = new Error(request.projectReview.mode === 'project'
            ? 'Claude Code 未确认本轮只启用授权的项目查阅和测试工具，评审已停止。'
            : 'Claude Code 未确认本轮只启用指定文件读取工具，评审已停止。');
          proc.kill('SIGTERM');
          return;
        }
        request.onEvent({kind:'diagnostic', detail:{observation:'project_review_tools', evidence:'system.init', nativeSessionId, tools:granted}});
      }
      // --resume + an echoed ID alone does not prove history restoration.
      const apiKeySource = ['none', 'user', 'project', 'org', 'environment', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'].includes(message.apiKeySource) ? message.apiKeySource as string : undefined;
      request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity: resumeId ? 'unknown' : 'fresh', evidence: 'system.init', resumeRequested: Boolean(resumeId), authentication: request.account.auth, ...(api ? { model: message.model, apiKeySource: apiKeySource ?? 'unknown', credentialEvidence: apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'ANTHROPIC_AUTH_TOKEN' || apiKeySource === 'environment' ? 'native_environment_source' : 'selected_configuration_only' } : {}) } });
    }
    if (!official && nativeSessionId && !terminal && !failed && !request.signal.aborted) nativeTools.claude(nativeSessionId, message, confirmFiles && verifiedInput ? inputUuid : undefined);
    if (message.type === 'assistant' || message.type === 'result') {
      if (!nativeSessionId || message.session_id !== nativeSessionId) { failed = new Error('Claude response session mismatch.'); proc.kill('SIGTERM'); return; }
      if (!accepted && message.type === 'assistant') { accepted = true; request.onEvent({ kind: 'accepted', detail: { nativeSessionId, evidence: 'assistant message', nativeMessageId: message.message?.id } }); }
      if (message.type === 'assistant') {
        if (confirmFiles && verifiedInput && !terminal && message.parent_tool_use_id === null) {
          for (const block of Array.isArray(message.message?.content) ? message.message.content : []) {
            if (block?.type === 'tool_use' && block.name === 'Bash') gate.observeCommand(nativeSessionId,inputUuid,block.id,claudeCommandApproval(block.input),block.input);
            if (block?.type === 'tool_use' && block.name === 'Write') gate.observe(nativeSessionId,inputUuid,block.id,claudeFileChange(block.input),block.input);
          }
        }
        if (typeof message.uuid === 'string') assistantUuid = message.uuid;
        const content = (message.message?.content ?? []).filter((item: Json) => item.type === 'text').map((item: Json) => item.text).join('\n');
        if (content) { text += content; request.onEvent({ kind: 'text', detail: { text: content } }); }
      } else {
        terminal = message;
        gate.close();
        if (confirmFiles) proc.endInput('');
        if (control) { control.close(); proc.endInput(''); }
        if ((terminal.subtype === 'success' && !terminal.is_error) || terminal.is_error === true) request.onEvent({ kind: 'diagnostic', detail: { observation: 'native_terminal', protocol: 'claude-cli', nativeSessionId, status: terminal.is_error === true ? 'failed' : 'succeeded', content: terminal.is_error === true ? 'Claude 原生终态回执确认执行失败。' : typeof terminal.result === 'string' ? terminal.result : text, evidence: 'stream-json result', resultId: typeof terminal.uuid === 'string' ? terminal.uuid : undefined } });
      }
    }
  };
  const abort = () => { failed = new Error('Claude execution interrupted; inspect persisted acceptance evidence.'); control?.close(); proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 1000).unref(); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    if (project) await project.ready;
    if (proc.pid !== undefined) request.onEvent({ kind: 'prepared', detail: { processStarted: true, transport: 'stdio' } });
    request.signal.throwIfAborted();
    if (control && official) {
      await control.initialize(official.email);
      request.onEvent({kind:'diagnostic',detail:{authentication:'cli',credentialSource:'official_cli',evidence:'auth status + same process initialize/account',projectTools:'platform_linux_command'}});
      request.signal.throwIfAborted();
    }
    request.onEvent({ kind: 'exposed', detail: { evidence: 'stdin prepared', requestedSessionId } });
    if (streamInput) {
      const input = {type:'user',...(confirmFiles ? {uuid:inputUuid} : {}),session_id:requestedSessionId,parent_tool_use_id:null,message:{role:'user',content:anthropicContent(request)}};
      if (control || confirmFiles) { proc.send(input); officialInputSent = true; }
      else proc.endInput(JSON.stringify(input) + '\n');
    } else proc.endInput(request.prompt);
    await proc.closed;
    if (failed || !terminal || terminal.is_error || terminal.subtype !== 'success' || proc.exitCode !== 0 || !nativeSessionId) throw new Error(terminal?.is_error ? 'Claude returned an unsuccessful result.' : failed?.message ?? 'Claude exited without a successful result.');
    if (!accepted) request.onEvent({ kind: 'accepted', detail: { nativeSessionId, evidence: 'successful result', resultId: terminal.uuid } });
    request.signal.throwIfAborted();
    const rows = request.projectReview || official ? undefined : project
      ? projectTranscript(project.treeExited && assistantUuid ? await project.history?.finish(nativeSessionId, assistantUuid) : undefined, nativeSessionId)
      : await claudeTranscript(request.cwd, nativeSessionId);
    request.signal.throwIfAborted();
    const verified = verifyClaudeHistory(rows, request.prompt, assistantUuid, resumeId ? request.sessionPlan?.previousAnchor : undefined);
    const continuity = resumeId ? verified && !!request.sessionPlan?.previousAnchor ? 'resumed' : 'unknown' : 'fresh';
    request.onEvent({ kind: 'session', detail: { nativeSessionId, continuity, historyVerified: verified, ...(verified ? { anchor: assistantUuid } : {}), previousAnchor: resumeId ? request.sessionPlan?.previousAnchor : undefined, evidence: verified ? 'stream assistant UUID + exact input + transcript parent chain' : 'transcript history proof unavailable' } });
    if (terminal.usage) request.onEvent({ kind: 'usage', detail: { source: 'stream-json result.usage', scope: 'invocation', inputTokens: terminal.usage.input_tokens, outputTokens: terminal.usage.output_tokens, cachedInputTokens: terminal.usage.cache_read_input_tokens, cacheWriteInputTokens: terminal.usage.cache_creation_input_tokens, costUsd: terminal.total_cost_usd } });
    return { text: typeof terminal.result === 'string' ? terminal.result : text, nativeSessionId, continuity };
  } finally {
    request.signal.removeEventListener('abort', abort);
    gate.close();
    control?.close();
    await proc.stop();
    await bridge.close();
  }
}
