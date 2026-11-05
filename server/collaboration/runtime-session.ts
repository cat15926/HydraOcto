import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { NativeSessionIdentity, RuntimeRequest } from '../../shared/collaboration.js';
import { digest } from './continuity.js';
import { cliEnv, JsonProcess } from './runtime-common.js';
import { initializeCodex, isolatedCodexArgs } from './runtime-codex.js';
const exec = promisify(execFile);
type SessionRequest = Pick<RuntimeRequest, 'member' | 'account' | 'cwd'>;

async function fileIdentity(path: string) {
  try { const p = await realpath(path), s = await stat(p); return { path: p, device: s.dev, inode: s.ino, ...(s.isFile() ? { size: s.size, mtime: s.mtimeMs } : {}) }; }
  catch { return { path: resolve(path), missing: true }; }
}
/** Discovery runs without model inputs. Only opaque fingerprints, never login tokens, are retained. */
export async function describeNativeSession(input: SessionRequest, command: string): Promise<NativeSessionIdentity> {
  if (input.member.carrier.endsWith('-api')) return { supported: false, reason: 'API 直连没有可续接的原生会话。' };
  try {
    const env = cliEnv();
    const version = (await exec(command, ['--version'], { env, timeout: 6000, maxBuffer: 64_000 })).stdout.trim().slice(0, 160);
    let executable = command;
    if (!isAbsolute(command)) for (const dir of (env.PATH ?? '').split(delimiter)) { try { const p = await realpath(join(dir, command)); if ((await stat(p)).isFile()) { executable = p; break; } } catch { /* next PATH entry */ } }
    let authentication: unknown;
    if (input.account.auth === 'api') {
      const key = input.account.apiKeyEnv && process.env[input.account.apiKeyEnv];
      if (!key?.trim()) return { supported: false, version, reason: '所选 API 凭据不可用。' };
      authentication = digest({ credential: key, provider: input.account.provider, endpoint: input.account.baseUrl });
    } else if (input.member.carrier === 'codex-app-server') {
      const proc = new JsonProcess(command, await isolatedCodexArgs(command, input.cwd), { cwd: input.cwd, env });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 6000); timer.unref();
      try {
        await initializeCodex(proc);
        const { account } = await proc.call('account/read', { refreshToken: false });
        if (account?.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email) return { supported: false, version, reason: '官方账户未提供可核验身份，使用新会话。' };
        authentication = digest({ type: account.type, email: account.email, plan: account.planType });
      } finally { clearTimeout(timer); await proc.stop(); }
    } else {
      const status = JSON.parse((await exec(command, ['auth', 'status', '--json'], { env, timeout: 6000, maxBuffer: 64_000 })).stdout);
      if (!status.loggedIn || typeof status.email !== 'string' || !status.email || !['oauth_token', 'claude.ai', 'oauth', 'claudeAi'].includes(status.authMethod)) return { supported: false, version, reason: '官方账户未提供可核验身份，使用新会话。' };
      authentication = digest({ email: status.email, method: status.authMethod, orgId: status.orgId, accountUuid: status.accountUuid });
    }
    const configRoot = input.member.carrier === 'codex-app-server' ? env.CODEX_HOME || join(env.HOME || homedir(), '.codex') : env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
    return { supported: true, version, fingerprint: digest({ version, executable: await fileIdentity(executable), authentication,
      workspace: await fileIdentity(input.cwd), config: await fileIdentity(configRoot),
      codexConfig: input.member.carrier === 'codex-app-server' ? await fileIdentity(join(configRoot, 'config.toml')) : undefined,
      policy: 'readonly-native-continuity-v1' }), reason: '本机运行版本、目录与认证身份已核对。' };
  } catch { return { supported: false, reason: '原生身份探测不可用，本轮不复用历史会话。' }; }
}

interface TranscriptRecord { uuid: string; parentUuid?: string; sessionId: string; cwd?: string; type: string; isSidechain?: boolean; message?: { content?: unknown } }
/** Read ONLY the exact UUID created by this platform, in the exact project directory; never scan CLI history. */
export async function claudeTranscript(cwd: string, sessionId: string): Promise<TranscriptRecord[] | undefined> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return;
  const root = resolve(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), '.claude'));
  try {
    const actualCwd = await realpath(cwd);
    const project = actualCwd.replace(/[^a-zA-Z0-9]/g, '-');
    const path = join(root, 'projects', project, `${sessionId}.jsonl`);
    // Large/unsupported formats remain unknown; never silently use truncated history.
    const actual = await realpath(path), actualRoot = await realpath(root);
    if (actual !== join(actualRoot, 'projects', project, `${sessionId}.jsonl`) || (await stat(actual)).size > 16_000_000) return;
    const rows = (await readFile(actual, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as TranscriptRecord);
    return rows.filter(r => r.sessionId === sessionId && !r.isSidechain && typeof r.uuid === 'string' && (!r.cwd || [actualCwd, resolve(cwd)].includes(resolve(r.cwd))));
  } catch { return; }
}
function transcriptText(record: TranscriptRecord): string | undefined {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every(c => c?.type === 'text' && typeof c.text === 'string')) return content.map(c => c.text).join('\n');
}
export function verifyClaudeHistory(rows: TranscriptRecord[] | undefined, prompt: string, assistantUuid: string | undefined, previousAnchor?: string): boolean {
  if (!rows || !assistantUuid) return false;
  const byId = new Map(rows.map(r => [r.uuid, r]));
  let node = byId.get(assistantUuid), inputFound = false;
  if (node?.type !== 'assistant') return false;
  const seen = new Set<string>();
  while (node && !seen.has(node.uuid)) {
    seen.add(node.uuid);
    if (node.uuid === previousAnchor) return inputFound;
    if (node.type === 'user' && transcriptText(node) === prompt) inputFound = true;
    if (!node.parentUuid) return !previousAnchor && inputFound;
    node = byId.get(node.parentUuid);
  }
  return false;
}
