import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { projectAccountFingerprint, verifiedProjectCodexHome } from './official-codex-history.js';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { NativeSessionIdentity, RuntimeRequest } from '../../shared/collaboration.js';
import { digest } from './continuity.js';
import { cliApiSettings, cliEnv, JsonProcess } from './runtime-common.js';
import type { ProjectVm } from './project-vm.js';
import { verifyWorkspace } from './workbench.js';
import { initializeCodex, isolatedCodexArgs } from './runtime-codex.js';
const exec = promisify(execFile);
type SessionRequest = Pick<RuntimeRequest, 'member' | 'account' | 'cwd'>;

/** This identity describes the guest backend and the selected host API credential. Guest boot IDs
 * are transport fences and change on an authorized remount of the same physical project. */
export function describeProjectSession(input: SessionRequest & Pick<RuntimeRequest,'projectWork'|'projectContinuity'|'workspaceGrant'>, vm?: ProjectVm): NativeSessionIdentity {
  const grant = input.workspaceGrant, carrier = input.member.carrier;
  if (!input.projectWork || !input.projectContinuity || vm?.historyProtocol !== 'project-session-history-v1' ||
      !grant || grant.mode !== 'project-work' || input.cwd !== grant.path || !grant.memberIds?.includes(input.member.id) ||
      !['codex-app-server','claude-cli'].includes(carrier) || input.account.auth !== 'api') {
    return {supported:false,reason:'当前项目执行器只支持从新会话开始。'};
  }
  const cli = vm.carriers[carrier as keyof ProjectVm['carriers']];
  if (!cli) return {supported:false,reason:'所选成员尚未登记项目会话存储。'};
  try {
    verifyWorkspace(grant);
    const {key,baseUrl} = cliApiSettings(input);
    const fingerprint = digest({protocol:vm.historyProtocol,instance:vm.instance,limaHome:vm.limaHome,runner:vm.runnerSha256,
      cli,carrier,credential:key,account:input.account.id,baseUrl,workspace:[grant.path,grant.device,grant.inode]});
    return {supported:true,fingerprint,version:`CLI SHA256 ${cli.slice(0,12)}`,reason:'已核对项目执行器、CLI、认证身份与授权目录。'};
  } catch { return {supported:false,reason:'项目目录、模型或认证配置无法核验。'}; }
}

/** The controller authenticates through the original CLI using only its dedicated home. */
export async function projectSessionIdentity(input: Parameters<typeof describeProjectSession>[0], vm: ProjectVm | undefined, command: string): Promise<NativeSessionIdentity> {
  if (input.account.codexHome !== 'project') {
    if (input.projectWork && input.member.carrier === 'codex-app-server' && input.account.auth === 'cli') {
      return {supported:false,reason:'此成员使用个人 Codex 登录。追问会携带平台保存的上下文，另开临时项目会话。'};
    }
    return describeProjectSession(input,vm);
  }
  const grant = input.workspaceGrant;
  if (!input.projectWork || !input.projectContinuity || input.account.auth !== 'cli' || input.member.carrier !== 'codex-app-server' ||
      !grant || grant.mode !== 'project-work' || grant.path !== input.cwd || !grant.memberIds?.includes(input.member.id) ||
      !vm?.officialExecutors?.includes('codex-app-server')) {
    return {supported:false, reason:'项目专用登录需要已授权的 Codex 项目执行器。'};
  }
  const scratch = await mkdtemp(join(await realpath(tmpdir()),'collab-project-login-'));
  try {
    verifyWorkspace(grant);
    const home = verifiedProjectCodexHome(grant.path);
    const env = {...cliEnv(), CODEX_HOME:home, CODEX_SQLITE_HOME:scratch};
    const args = await isolatedCodexArgs(command,scratch,env,{stateArgs:['-c',`sqlite_home=${JSON.stringify(scratch)}`]});
    const proc = new JsonProcess(command,args,{env,cwd:scratch});
    const timer = setTimeout(()=>proc.kill('SIGKILL'),8000);
    let account: string | undefined;
    try {
      await initializeCodex(proc);
      account = projectAccountFingerprint(await proc.call('account/read',{refreshToken:false}));
    } finally { clearTimeout(timer); await proc.stop(); }
    if (!account) return {supported:false,reason:'请先为「Codex 项目专用登录」完成官方登录并核对工作区身份。'};
    const version = (await exec(command,['--version'],{env,timeout:6000,maxBuffer:64000})).stdout.trim().slice(0,160);
    const fingerprint = digest(['official-project-history-v1',await fileIdentity(home),account,version,vm.instance,vm.limaHome,
      vm.runnerSha256,vm.carriers['codex-app-server'],grant.path,grant.device,grant.inode]);
    return {supported:true,version,fingerprint,projectAccountFingerprint:account,reason:'已核对项目专用登录、工作区身份和执行器。'};
  } catch { return {supported:false,reason:'无法核验项目专用登录。请检查专用目录并用官方流程登录。'}; }
  finally { await rm(scratch,{recursive:true,force:true}); }
}

async function fileIdentity(path: string) {
  try { const p = await realpath(path), s = await stat(p); return { path: p, device: s.dev, inode: s.ino, ...(s.isFile() ? { size: s.size, mtime: s.mtimeMs } : {}) }; }
  catch { return { path: resolve(path), missing: true }; }
}
/** Discovery runs without model inputs. Only opaque fingerprints, never login tokens, are retained. */
export async function describeNativeSession(input: SessionRequest, command: string, forImport = false): Promise<NativeSessionIdentity> {
  if (input.member.carrier.endsWith('-api')) return { supported: false, reason: 'API 直连没有可续接的原生会话。' };
  try {
    const env = cliEnv();
    const version = (await exec(command, ['--version'], { env, timeout: 6000, maxBuffer: 64_000 })).stdout.trim().slice(0, 160);
    let executable = command;
    if (!isAbsolute(command)) for (const dir of (env.PATH ?? '').split(delimiter)) { try { const p = await realpath(join(dir, command)); if ((await stat(p)).isFile()) { executable = p; break; } } catch { /* next PATH entry */ } }
    let authentication: unknown;
    let historyOwner: NativeSessionIdentity["historyOwner"];
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
        if(forImport) {
          // The local login selects one workspace. Compare the CLI-reported email and both
          // workspace/user identifiers before asking the native index for any thread titles.
          try {
            const file=join(env.CODEX_HOME || join(env.HOME || homedir(),'.codex'),'auth.json');
            const tokens=JSON.parse(await readFile(file,'utf8')).tokens;
            const payload=JSON.parse(Buffer.from(tokens.id_token.split('.')[1],'base64url').toString('utf8'));
            const claims=payload['https://api.openai.com/auth'];
            if(payload.email===account.email && typeof tokens.account_id==='string' && tokens.account_id &&
               claims?.chatgpt_account_id===tokens.account_id && typeof claims.chatgpt_user_id==='string' && claims.chatgpt_user_id){
              historyOwner={account:tokens.account_id,user:claims.chatgpt_user_id};
            }
          }catch{/* Credential stores without comparable identity fields cannot attribute local threads. */}
        }
      } finally { clearTimeout(timer); await proc.stop(); }
    } else {
      const status = JSON.parse((await exec(command, ['auth', 'status', '--json'], { env, timeout: 6000, maxBuffer: 64_000 })).stdout);
      if (!status.loggedIn || typeof status.email !== 'string' || !status.email || !['oauth_token', 'claude.ai', 'oauth', 'claudeAi'].includes(status.authMethod)) return { supported: false, version, reason: '官方账户未提供可核验身份，使用新会话。' };
      authentication = digest({ email: status.email, method: status.authMethod, orgId: status.orgId, accountUuid: status.accountUuid });
    }
    const configRoot = input.member.carrier === 'codex-app-server' ? env.CODEX_HOME || join(env.HOME || homedir(), '.codex') : env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
    return { supported: true, version, ...(historyOwner ? {historyOwner} : {}), fingerprint: digest({ version, executable: await fileIdentity(executable), authentication,
      workspace: await fileIdentity(input.cwd), config: await fileIdentity(configRoot),
      codexConfig: input.member.carrier === 'codex-app-server' ? await fileIdentity(join(configRoot, 'config.toml')) : undefined,
      policy: 'readonly-native-continuity-v1' }), reason: '本机运行版本、目录与认证身份已核对。' };
  } catch { return { supported: false, reason: '原生身份探测不可用，本轮不复用历史会话。' }; }
}

interface TranscriptRecord { uuid: string; parentUuid?: string; sessionId: string; cwd?: string; type: string; isSidechain?: boolean; message?: { content?: unknown } }

/** Scope raw guest transcript records before using them as native evidence. Ancillary Claude
 * entries can lack UUIDs. Duplicate UUIDs would make the parent chain ambiguous. */
export function projectTranscript(rows: unknown, sessionId: string): TranscriptRecord[] | undefined {
  if (!Array.isArray(rows)) return;
  const records: TranscriptRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.isSidechain || typeof row.uuid !== 'string') continue;
    if (row.sessionId !== sessionId || (row.cwd !== undefined && row.cwd !== '/mnt/project') ||
        typeof row.type !== 'string' || (row.parentUuid != null && typeof row.parentUuid !== 'string') || seen.has(row.uuid)) return;
    seen.add(row.uuid);
    records.push(row);
  }
  return records;
}
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
