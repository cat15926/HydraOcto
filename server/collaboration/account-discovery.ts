import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import type { AccountObservation, CollaborationAccount, RuntimeModel } from '../../shared/collaboration.js';
import { cliEnv, JsonProcess, type Json } from './runtime-common.js';
import { initializeCodex, isolatedCodexArgs } from './runtime-codex.js';
const exec = promisify(execFile);
const bounded = (v: unknown, max = 200): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v) ? v : undefined;
export function modelsFrom(rows: unknown, kind: 'codex' | 'claude' | 'api'): RuntimeModel[] {
  if (!Array.isArray(rows)) return [];
  const result: RuntimeModel[] = [];
  for (const row of rows.slice(0, 1000)) {
    if (!row || typeof row !== 'object') continue;
    const id = bounded(kind === 'codex' ? row.model ?? row.id : kind === 'claude' ? row.value ?? row.id : row.id);
    if (!id || result.some(m => m.id === id)) continue;
    const efforts: string[] = kind === 'codex' && Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((e: Json) => e.reasoningEffort) : kind === 'claude' && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels : [];
    result.push({ id, name: bounded(row.displayName ?? row.display_name ?? row.display_name ?? row.name) ?? id, efforts: [...new Set(efforts.filter(e => !!bounded(e, 30)))], ...(row.isDefault === true ? { isDefault: true } : {}) });
  }
  return result;
}
async function apiModels(account: CollaborationAccount, result: AccountObservation) {
  const secret = account.apiKeyEnv && process.env[account.apiKeyEnv]; if (!secret?.trim()) { result.reason = '密钥环境变量尚未配置。'; return; }
  const anthropic = ['claude', 'anthropic'].includes(account.provider);
  const base = (account.baseUrl || (anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const path = anthropic && !base.endsWith('/v1') ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> = anthropic ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${secret}` };
  const response = await fetch(path, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  result.connection = 'reachable'; result.catalogSource = 'selected_endpoint:GET/models';
  if (!response.ok) { result.reason = `模型目录返回 HTTP ${response.status}；不代表模型调用已通过。`; if ([401, 403].includes(response.status)) result.identity = { state: 'not_authenticated' }; await response.body?.cancel(); return; }
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body ?? []) { length += chunk.length; if (length > 1000000) throw new Error('catalog too large'); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  result.models = modelsFrom(body.data, 'api');
  // An API catalog may be public; receiving it does not establish an account identity.
  result.reason = result.models.length ? '已取得所选服务目录；API 身份、额度和调用权限仍以各自证据为准。' : '服务没有返回可识别的模型目录。';
}
async function claudeCatalog(command: string): Promise<RuntimeModel[]> {
  const proc = new JsonProcess(command, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env: cliEnv(), cwd: tmpdir() });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 10000); timer.unref();
  try {
    const initialized = new Promise<Json>((resolve, reject) => {
      proc.onFailure = reject;
      proc.onMessage = message => {
        if (message.type === 'control_response' && message.response?.request_id === 'catalog') {
          message.response.subtype === 'success' ? resolve(message.response.response ?? {}) : reject(new Error('initialize rejected'));
        }
      };
    });
    proc.send({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize', hooks: {}, agents: {} } });
    // Only a control request: no user message, prompt or inference.
    const response = await initialized; return modelsFrom(response.models, 'claude');
  } finally { clearTimeout(timer); await proc.stop(); }
}
/** Read-only discovery. It never starts a model turn, logs raw provider bodies, or returns login credentials. */
export async function discoverAccount(account: CollaborationAccount, commands: { codex: string; claude: string }): Promise<AccountObservation> {
  const native = account.provider === 'codex' || account.provider === 'claude';
  const command = account.provider === 'codex' ? commands.codex : commands.claude;
  const result: AccountObservation = { accountId: account.id, accountRevision: account.revision ?? 1, checkedAt: new Date().toISOString(), installed: !native, configured: account.auth === 'cli' || !!(account.apiKeyEnv && process.env[account.apiKeyEnv]?.trim()), connection: 'unknown', identity: { state: 'unknown' }, models: [], catalogSource: 'unavailable', quota: { state: 'unknown' } };
  try {
    if (native) { try { result.version = bounded((await exec(command, ['--version'], { env: cliEnv(), timeout: 6000, maxBuffer: 64000 })).stdout.trim()); result.installed = true; } catch { result.reason = '本机未检测到运行时。'; } }
    if (account.auth === 'api') await apiModels(account, result);
    else if (!result.installed) result.identity = { state: 'unknown' };
    else if (account.provider === 'codex') {
      const proc = new JsonProcess(command, await isolatedCodexArgs(command, tmpdir()), { env: cliEnv(), cwd: tmpdir() });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 15000); timer.unref();
      try {
        await initializeCodex(proc); result.connection = 'reachable';
        const { account: identity } = await proc.call('account/read', { refreshToken: false });
        result.identity = identity?.type === 'chatgpt' ? { state: 'authenticated', label: bounded(identity.email) ?? 'ChatGPT（CLI 未提供身份名称）' } : { state: 'not_authenticated' };
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const list = await proc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          result.models.push(...modelsFrom(list.data, 'codex')); cursor = bounded(list.nextCursor); if (!cursor) break;
        }
        result.models = result.models.filter((m, index, all) => all.findIndex(x => x.id === m.id) === index); result.catalogSource = 'codex:model/list';
        if (result.identity.state === 'authenticated') {
          try {
            const limits = await proc.call('account/rateLimits/read', {});
            const windows = Object.entries(limits.rateLimits ?? {}).flatMap(([name, v]) => { const x = v as Json; return x && typeof x.usedPercent === 'number' && Number.isFinite(x.usedPercent) && x.usedPercent >= 0 && x.usedPercent <= 100 ? [{ name, usedPercent: x.usedPercent, ...(typeof x.resetsAt === 'number' && Number.isFinite(x.resetsAt) ? { resetsAt: new Date(x.resetsAt * 1000).toISOString() } : {}) }] : []; });
            if (windows.length) result.quota = { state: 'known', windows };
          } catch { /* Quota is independent; keep unknown. */ }
        }
        result.reason = '目录来自本机 CLI（可能使用缓存）；登录与目录不等于实际模型调用权限。';
      } finally { clearTimeout(timer); await proc.stop(); }
    } else {
      let status: Json;
      try { status = JSON.parse((await exec(command, ['auth', 'status', '--json'], { env: cliEnv(), timeout: 6000, maxBuffer: 64000 })).stdout); }
      catch (error) { const stdout = (error as { stdout?: string }).stdout; if (!stdout) throw error; status = JSON.parse(stdout); }
      result.connection = 'reachable';
      result.identity = status.loggedIn && ['oauth_token', 'claude.ai', 'oauth', 'claudeAi'].includes(status.authMethod) ? { state: 'authenticated', ...(bounded(status.email) ? { label: status.email } : {}) } : { state: 'not_authenticated' };
      try { result.models = await claudeCatalog(command); result.catalogSource = 'claude:control/initialize'; } catch { result.reason = 'CLI 身份已检查；当前 CLI 没有返回可用模型目录。'; }
    }
  } catch { result.reason = '探测未完成；网络、协议或本机状态不可用。未发起模型调用。'; if (result.connection === 'unknown') result.connection = 'unavailable'; }
  const secret = account.apiKeyEnv && process.env[account.apiKeyEnv];
  return JSON.parse(secret ? JSON.stringify(result).split(secret).join('[redacted]') : JSON.stringify(result));
}
