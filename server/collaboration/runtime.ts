import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CollaborationRuntime, RuntimeCapability, RuntimeRequest } from '../../shared/collaboration.js';
import { cliApiSettings, cliEnv, JsonProcess } from './runtime-common.js';
import { isolatedCodexArgs, initializeCodex, invokeCodex, supportsCodexAppend } from './runtime-codex.js';
import { invokeClaude } from './runtime-claude.js';
import { invokeApi } from './runtime-api.js';
import { withRuntimeInspection } from './inspection.js';
import { describeNativeSession } from './runtime-session.js';
const exec = promisify(execFile);

async function claudeLoggedIn(path: string): Promise<boolean> {
  const { stdout } = await exec(path, ['auth', 'status', '--json'], { env: cliEnv(), timeout: 6000, maxBuffer: 64_000 });
  const status = JSON.parse(stdout);
  return status.loggedIn === true && ['oauth_token', 'claude.ai', 'oauth', 'claudeAi'].includes(status.authMethod);
}
export function createCollaborationRuntime(options: { codexPath?: string; claudePath?: string; timeoutMs?: number } = {}): CollaborationRuntime {
  const codex = options.codexPath ?? process.env.COLLAB_CODEX_PATH ?? 'codex';
  const claude = options.claudePath ?? process.env.COLLAB_CLAUDE_PATH ?? 'claude';
  return withRuntimeInspection({
    sessionIdentity: input => describeNativeSession(input, input.member.carrier === 'codex-app-server' ? codex : claude),
    async invoke(input: RuntimeRequest) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      let exposed = false, nativeHostStarted = false;
      const request: RuntimeRequest = { ...input, signal: AbortSignal.any([input.signal, timeout]), onEvent: event => {
        if (event.kind === 'exposed' || event.kind === 'accepted') exposed = true;
        if (event.kind === 'prepared' && event.detail.processStarted === true) nativeHostStarted = true;
        input.onEvent(event);
      } };
      try {
      const api = request.member.carrier.endsWith('-api');
      if (!['cli', 'api'].includes(request.account.auth) || (api && request.account.auth !== 'api')) throw new Error('Account authentication does not match runtime.');
      const expectedProvider = ({ 'codex-app-server': 'codex', 'claude-cli': 'claude', 'openai-api': 'openai', 'anthropic-api': 'anthropic' } as const)[request.member.carrier];
      if (request.account.provider !== expectedProvider) throw new Error('Account provider does not match runtime.');
      request.signal.throwIfAborted();
      if (request.sessionPlan?.identity?.supported) {
        const identity = await describeNativeSession(request, request.member.carrier === 'codex-app-server' ? codex : claude);
        if (!identity.supported || identity.fingerprint !== request.sessionPlan.identity.fingerprint) throw new Error('原生身份在计划与发送之间发生变化；本次没有发送输入，请核对配置。');
      }
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
            return { ...base, version, append: await supportsCodexAppend(codex), installed: true, available, ...(available ? {} : { reason: externalMcp ? 'External MCP configuration could not be isolated; runtime will not start a model.' : 'Official ChatGPT CLI login required.' }) };
          }
          catch { return { ...base, version, installed: true, available: false, reason: 'Codex app-server handshake or account check failed.' }; }
          finally { clearTimeout(timer); await process.stop(); }
        })(),
        (async (): Promise<RuntimeCapability> => {
          const base = { carrier: 'claude-cli' as const, append: false as const, authentication: 'cli' as const, verified: 'unverified' as const };
          let version: string;
          try { version = (await exec(claude, ['--version'], { env: cliEnv(), timeout: 6000, maxBuffer: 64_000 })).stdout.trim().slice(0, 160); } catch { return { ...base, installed: false, available: false, reason: 'Claude CLI unavailable.' }; }
          let available = false; try { available = await claudeLoggedIn(claude); } catch { /* report capability only */ }
          return { ...base, version, installed: true, available, ...(available ? {} : { reason: 'Official Claude CLI login required; API environment credentials are kept separate.' }) };
        })(),
      ];
      return [...await Promise.all(tasks), ...(['openai-api', 'anthropic-api'] as const).map(carrier => ({ carrier, append: false as const, authentication: 'api' as const, installed: true, available: true, verified: 'unverified' as const, reason: 'Protocol adapter installed; account key and explicit model are checked when invoked.' }))];
    },
  });
}
