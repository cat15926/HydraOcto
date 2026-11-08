import { isManagedProbeArgv } from './native-command-approval.js';
import { checkImageTransport } from './runtime-images.js';
import { attachOfficialExecutor } from './project-official.js';
import { observeProjectDomain } from './project-vm-observation.js';
import { supportsAccount } from '../../shared/collaboration.js';
import { hermesPython, invokeHermes, probeHermes } from './runtime-hermes.js';
import { projectPrivateRoots, verifyWorkspace } from './workbench.js';
import { prepareProjectCli, readProjectVm, vmSupports, type ProjectVm } from './project-vm.js';
import { acquireProjectVm, canManageProjectRoot } from './project-vm-mount.js';
import { RuntimeOutcomeUnknown } from './runtime-common.js';
import { nativeProjectCapability } from './native-project-capability.js';
import { discoverAccount, projectLoginGuidance, resolveCodexExecutable } from './account-discovery.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollaborationRuntime, RuntimeCapability, RuntimeRequest, Carrier, WorkspaceGrant } from '../../shared/collaboration.js';
import { runProjectReviewTest } from './project-review-test.js';
import { cliApiSettings, cliEnv, JsonProcess } from './runtime-common.js';
import { isolatedCodexArgs, initializeCodex, invokeCodex, supportsCodexAppend } from './runtime-codex.js';
import { invokeClaude } from './runtime-claude.js';
import { invokeApi } from './runtime-api.js';
import { withRuntimeInspection } from './inspection.js';
import { describeNativeSession, projectSessionIdentity } from './runtime-session.js';
const exec = promisify(execFile);

async function claudeLoggedIn(path: string): Promise<boolean> {
  let stdout: string, successful = true;
  try { ({ stdout } = await exec(path, ['auth', 'status', '--json'], { env: cliEnv(), timeout: 6000, maxBuffer: 64_000 })); }
  catch (error) {
    const result = error as { code?: number; stdout?: string };
    // A nonzero exit can establish signed-out status, never successful authentication.
    if (result.code !== 1 || !result.stdout) throw new Error('Claude CLI 登录状态未能确认。');
    successful = false; stdout = result.stdout;
  }
  let status;
  try { status = JSON.parse(stdout); } catch { throw new Error('Claude CLI 登录状态未能确认。'); }
  if (status?.loggedIn === false) return false;
  if (!successful || status?.loggedIn !== true) throw new Error('Claude CLI 登录状态未能确认。');
  return ['oauth_token', 'claude.ai', 'oauth', 'claudeAi'].includes(status.authMethod);
}
export function createCollaborationRuntime(options: { codexPath?: string; claudePath?: string; hermesPython?: string; timeoutMs?: number; projectVm?: ProjectVm; privateRoots?: string[] } = {}): CollaborationRuntime {
  const configuredCodex=options.codexPath ?? process.env.COLLAB_CODEX_PATH;
  const codex = resolveCodexExecutable(configuredCodex) ?? configuredCodex ?? 'codex';
  const claude = options.claudePath ?? process.env.COLLAB_CLAUDE_PATH ?? 'claude';
  const hermes = options.hermesPython ?? hermesPython();
  let vm: ProjectVm | undefined, vmError: string | undefined;
  try { vm = options.projectVm ?? readProjectVm(process.env.COLLAB_PROJECT_VM_CONFIG); }
  catch { vmError = '虚拟机登记无效，请重新验证本机执行环境。'; }
  const privateRoots = [...(options.privateRoots ?? []), ...projectPrivateRoots()];
  type AuthorTest = {vm: ProjectVm; grant: WorkspaceGrant; signal: AbortSignal; confirmed: boolean; canCheckEnvironment: boolean; canRunNpm: boolean; active?: Promise<unknown>};
  const authorTests = new Map<string, AuthorTest>();
  const projectMatrix = (carrier: Carrier, grant?: WorkspaceGrant) => {
    const capabilities = nativeProjectCapability(carrier);
    if (!['codex-app-server','claude-cli'].includes(carrier)) return capabilities;
    if (vm || vmError) {
      const supported = vmSupports(vm,carrier) && (!grant || (vm?.manageMount ? canManageProjectRoot(vm,grant,privateRoots) : vmSupports(vm,carrier,grant)));
      const registered = (carrier==='codex-app-server' || carrier==='claude-cli') && vm?.officialExecutors?.includes(carrier);
      capabilities.cli = {available:!!(supported && registered), reason:supported && registered ?
        (carrier==='codex-app-server' ? '官方登录由本机 Codex 核验，原生命令在项目虚拟机运行。' : '官方登录由本机 Claude Code 核验，项目命令通过工作台在虚拟机运行。') :
        vmError ?? (registered ? '此目录不适用于已登记的项目执行器。' : '此执行器尚未登记官方登录项目工作；原有只读协作仍可使用。')};
      capabilities.api = {available:supported, reason: supported ? '已登记本机 Linux 项目执行器，派发时复核目录和运行版本。' :
        vmError ?? (grant ? '该目录或成员尚未登记到本机 Linux 执行器。' : '此成员的虚拟机承载尚未通过验证。')};
    }
    return capabilities;
  };
  return withRuntimeInspection({
    projectLoginGuidance:()=>projectLoginGuidance(configuredCodex),
    async runProjectReviewTest(request) {
      if (!vm) throw new Error(vmError ?? '请先登记本机 Linux 项目执行器，再运行评审测试。');
      if (!request.authorInvocationId) return runProjectReviewTest({...request,vm,privateRoots,
        hasActiveWriter:request.npm ? () => authorTests.size > 0 : undefined});
      const author = authorTests.get(request.authorInvocationId);
      if (!author || (request.npm ? !author.canRunNpm : !author.canCheckEnvironment || !isManagedProbeArgv(request.argv)) || author.active || !author.confirmed || author.signal.aborted ||
          author.grant.path !== request.grant.path || author.grant.device !== request.grant.device ||
          author.grant.inode !== request.grant.inode || author.grant.conversationId !== request.grant.conversationId ||
          author.grant.revision !== request.grant.revision) throw new Error('作者的项目执行环境已变化或已有测试运行。');
      const borrowedLease = {vm:author.vm, async release(confirmed:boolean) { author.confirmed &&= confirmed; }};
      const result = runProjectReviewTest({...request, vm:author.vm, privateRoots, borrowedLease,
        signal:AbortSignal.any([author.signal,request.signal])});
      author.active = result;
      try { return await result; } finally { author.active = undefined; }
    },
    inspectProjectDomain: (id,evidence) => observeProjectDomain(vm,id,evidence),
    projectWorkAvailability: (member, account, grant) => projectMatrix(member.carrier, grant)[account.auth],
    discoverAccount: account => discoverAccount(account, { codex, claude }),
    historyIdentity: input => input.account.codexHome === 'project' ? Promise.resolve({supported:false,reason:'专用项目历史仅在原会话续接。'}) : describeNativeSession(input,input.member.carrier==='codex-app-server'?codex:claude,true),
    sessionIdentity: input => input.projectWork ? projectSessionIdentity(input,vm,codex) : input.account.codexHome === 'project'
      ? Promise.resolve({supported:false,reason:'项目专用登录用于已授权的项目委托。'}) : input.member.carrier === 'hermes-agent'
      ? Promise.resolve({ supported: false, reason: 'Hermes 使用本轮平台历史。' }) : describeNativeSession(input, input.member.carrier === 'codex-app-server' ? codex : claude),
    async invoke(input: RuntimeRequest) {
      const projectTest = input.mayRunProjectNpmTest || input.projectReview?.npmTest;
      const timeout = AbortSignal.timeout(options.timeoutMs ?? (projectTest ? 600_000 : 180_000));
      let exposed = false, nativeHostStarted = false, nativeTerminal = false;
      const request: RuntimeRequest = { ...input, signal: AbortSignal.any([input.signal, timeout]), onEvent: event => {
        if (event.kind === 'exposed' || event.kind === 'accepted') exposed = true;
        if (event.kind === 'prepared' && event.detail.processStarted === true) nativeHostStarted = true;
        if (event.kind === 'diagnostic' && event.detail.observation === 'native_terminal') nativeTerminal = true;
        input.onEvent(event);
      } };
      try {
      const api = request.member.carrier.endsWith('-api');
      checkImageTransport(request);
      if (!['cli', 'api'].includes(request.account.auth) || (api && request.account.auth !== 'api')) throw new Error('Account authentication does not match runtime.');
      if (!supportsAccount(request.member.carrier, request.account)) throw new Error('Account provider does not match runtime.');
      request.signal.throwIfAborted();
      if (request.projectReview && request.projectWork) throw new Error('文件评审不能取得项目写入权限。');
      if (request.workspaceGrant) verifyWorkspace(request.workspaceGrant);
      if (request.account.codexHome === 'project' && (!request.projectWork || request.account.auth!=='cli' ||
          request.member.carrier!=='codex-app-server' || !request.sessionPlan?.identity?.projectAccountFingerprint)) {
        throw new Error(request.projectWork ? '请先为「Codex 项目专用登录」完成官方登录，再提交项目委托。' : '此账户专用于已授权的项目工作。请在项目会话中发送修改或测试委托。');
      }
      if (request.projectWork) {
        const capability = projectMatrix(request.member.carrier, request.workspaceGrant)[request.account.auth];
        if (!vm || !request.workspaceGrant || !capability.available) throw new Error(capability.reason);
        const lease = await acquireProjectVm(vm,request.workspaceGrant,request.signal,privateRoots);
        let project: Awaited<ReturnType<typeof prepareProjectCli>> | undefined;
        const testLifetime = new AbortController();
        const canCheckEnvironment = request.member.carrier === 'codex-app-server' && request.workspaceGrant.nativeFileApprovals === true &&
          !request.visibility && !request.projectReview && request.toolPolicyVersion === 'cross-action-v1';
        const author: AuthorTest = {vm:lease.vm, grant:request.workspaceGrant, confirmed:true,canCheckEnvironment,canRunNpm:!!request.mayRunProjectNpmTest,
          signal:AbortSignal.any([request.signal,testLifetime.signal])};
        if (canCheckEnvironment || request.mayRunProjectNpmTest) authorTests.set(request.invocationId,author);
        const official=request.account.auth==='cli';
        let detach: (()=>void) | undefined;
        try {
          if (official && request.member.carrier==='claude-cli' && !await claudeLoggedIn(claude).catch(()=>false)) throw new Error('请先在本机终端运行 claude auth login 完成官方登录，再发送项目委托。');
          project = await prepareProjectCli(lease.vm, request);
          if (official) {
            detach=await attachOfficialExecutor(project,request);
            await project.ready;
          }
          if (request.sessionPlan?.identity?.supported) {
            const identity = await projectSessionIdentity(request,lease.vm,codex);
            if (!identity.supported || identity.fingerprint !== request.sessionPlan.identity.fingerprint)
              throw new Error('项目执行器、目录或账户在计划后发生变化。请重新提交委托。');
          }
          const result = request.member.carrier === 'claude-cli'
            ? await invokeClaude(request, claude, project) : await invokeCodex(request, codex, project);
          if (official) await project.close();
          if (!project.treeExited || !author.confirmed) throw new RuntimeOutcomeUnknown('虚拟机执行域退出待核查。');
          return result;
        } catch (error) {
          if (official && project?.launched) await project.close();
          if ((exposed && !nativeTerminal) || (project?.launched && !project.treeExited)) throw new RuntimeOutcomeUnknown('虚拟机执行结果待核查，项目原文件可能已修改。平台不会重发。');
          throw error;
        } finally {
          if (project?.launched) nativeHostStarted = true;
          try {
            detach?.();
            await project?.close();
            if (official && project?.treeExited) input.onEvent({kind:'process_exit',detail:{transport:'linux-project-executor',confirmed:true}});
          }
          finally {
            authorTests.delete(request.invocationId);
            testLifetime.abort();
            await author.active?.catch(() => {});
            await lease.release(author.confirmed && (!project?.launched || project.treeExited));
          }
        }
      }
      if (request.projectReview) {
        if (request.nativeSessionId || request.visibility || !request.workspaceGrant || request.workspaceGrant.mode !== 'project-work' ||
            (request.projectReview.mode === 'project' && request.workspaceGrant.reviewMode !== 'project') ||
            !['claude-cli','codex-app-server'].includes(request.member.carrier)) throw new Error('本次评审缺少对应的只读项目授权。');
        const cwd = await mkdtemp(join(await realpath(tmpdir()),'multi-agent-review-'));
        try {
          const isolated = { ...request, cwd };
          if (request.member.carrier === 'codex-app-server') return await invokeCodex(isolated,codex);
          if (request.account.auth === 'cli' && !await claudeLoggedIn(claude)) throw new Error('Claude 评审需要所选官方 CLI 账户登录。');
          return await invokeClaude(isolated,claude);
        } finally { await rm(cwd,{recursive:true,force:true}); }
      }
      if (request.sessionPlan?.identity?.supported) {
        const identity = await describeNativeSession(request, request.member.carrier === 'codex-app-server' ? codex : claude);
        if (!identity.supported || identity.fingerprint !== request.sessionPlan.identity.fingerprint) throw new Error('原生身份在计划与发送之间发生变化；本次没有发送输入，请核对配置。');
      }
      if (request.member.carrier === 'hermes-agent') return await invokeHermes(request, hermes);
      if (!api && request.account.auth === 'api') cliApiSettings(request);
      if (request.member.carrier === 'codex-app-server') return await invokeCodex(request, codex);
      if (request.member.carrier === 'claude-cli') {
        if (request.account.auth === 'api') return await invokeClaude(request, claude);
        let loggedIn = false;
        try { loggedIn = await claudeLoggedIn(claude); } catch { /* No credential details enter persisted errors. */ }
        if (!loggedIn) { request.onEvent({ kind: 'not_accepted', detail: { reason: 'Claude official CLI login is unavailable; no model request sent.' } }); throw new Error('Claude CLI requires official login: claude auth login. API keys must use an API account.'); }
        return await invokeClaude(request, claude);
      }
      return await invokeApi(request);
      } catch (error) {
        if (!exposed) {
          input.onEvent({ kind: 'not_accepted', detail: { reason: 'Preflight ended before any model input was sent.' } });
          if (!nativeHostStarted) input.onEvent({ kind: 'transport_settled', detail: { scope: 'preflight', confirmed: true, reason: 'not sent; no execution host started' } });
        }
        throw error;
      }
    },
    async probe() {
      const tasks = [
        probeHermes(hermes),
        (async (): Promise<RuntimeCapability> => {
          const base = { carrier: 'codex-app-server' as const, append: false as const, authentication: 'cli' as const, verified: 'unverified' as const };
          let version: string;
          try { version = (await exec(codex, ['--version'], { env: cliEnv(), timeout: 6000, maxBuffer: 64_000 })).stdout.trim().slice(0, 160); } catch { return { ...base, installed: false, available: false, reason: 'Codex CLI unavailable.' }; }
          let args: string[];
          try { args = await isolatedCodexArgs(codex); } catch { return { ...base, version, installed: true, available: false, reason: 'Codex configuration isolation probe failed.' }; }
          const process = new JsonProcess(codex, args, { env: cliEnv() });
          const timer = setTimeout(() => process.kill('SIGKILL'), 6000); timer.unref();
          try {
            await initializeCodex(process);
            const account = await process.call('account/read', { refreshToken: false });
            const config = await process.call('config/read', { includeLayers: false });
            const externalMcp = Object.values(config.config?.mcp_servers ?? {}).some(value => (value as { enabled?: boolean })?.enabled !== false);
            const available = account.account?.type === 'chatgpt' && !externalMcp;
            return { ...base, version, append: await supportsCodexAppend(codex), installed: true, available, ...(available ? {} : { loginRequired: !externalMcp, reason: externalMcp ? 'External MCP configuration could not be isolated; runtime will not start a model.' : 'Official ChatGPT CLI login required.' }) };
          }
          catch { return { ...base, version, installed: true, available: false, reason: 'Codex app-server handshake or account check failed.' }; }
          finally { clearTimeout(timer); await process.stop(); }
        })(),
        (async (): Promise<RuntimeCapability> => {
          const base = { carrier: 'claude-cli' as const, append: false as const, authentication: 'cli' as const, verified: 'unverified' as const };
          let version: string;
          try { version = (await exec(claude, ['--version'], { env: cliEnv(), timeout: 6000, maxBuffer: 64_000 })).stdout.trim().slice(0, 160); } catch { return { ...base, installed: false, available: false, reason: 'Claude CLI unavailable.' }; }
          try {
            const available = await claudeLoggedIn(claude);
            return { ...base, version, installed: true, available, ...(available ? {} : { loginRequired: true, reason: 'Official Claude CLI login required; API environment credentials are kept separate.' }) };
          } catch { return { ...base, version, installed: true, available: false, reason: 'Claude CLI 登录状态未能确认。' }; }
        })(),
      ];
      return [...await Promise.all(tasks), ...(['openai-api', 'anthropic-api'] as const).map(carrier => ({ carrier, append: false as const, authentication: 'api' as const, installed: true, available: true, verified: 'unverified' as const, reason: 'Protocol adapter installed; account key and explicit model are checked when invoked.' }))].map(capability => ({
        ...capability, nativeProject: (() => {
          const matrix=projectMatrix(capability.carrier);
          if (matrix.cli.available && !capability.available) matrix.cli = { available: false, reason: '本机官方账户或连接未就绪，请重新检查。' };
          return matrix;
        })(),
      }));
    },
  });
}
