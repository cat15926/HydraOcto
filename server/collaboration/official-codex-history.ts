import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RuntimeRequest } from '../../shared/collaboration.js';
import { digest } from './continuity.js';
import { boundedFile, uuid } from './history-files.js';

export const projectCodexAccountId = 'codex-project-cli';
export function projectCodexHome() {
  const configured = process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME;
  if (configured && !isAbsolute(configured)) throw new Error('Codex 项目专用登录目录需要绝对路径。');
  return resolve(configured || '.local-data/project-runtime/codex-login');
}
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** Run the vendor login only in the selected private home. Never handle native credentials. */
export function verifiedProjectCodexHome(project?: string) {
  const home = projectCodexHome();
  const personal = [resolve(homedir(), '.codex'), resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))];
  if (personal.some(path => overlaps(home, path)) || (project && overlaps(home, project))) {
    throw new Error('Codex 项目专用登录目录必须与个人登录目录、项目目录分开。');
  }
  const info = lstatSync(home);
  if (!info.isDirectory() || realpathSync(home) !== home || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
    throw new Error('请核对 Codex 项目专用登录目录的归属和私有权限。');
  }
  for (const relativePath of ['sessions','auth.json','platform-checkpoints']) {
    const path = join(home, relativePath);
    const entry = lstatSync(path,{throwIfNoEntry:false});
    if (entry && (entry.isSymbolicLink() || entry.uid !== info.uid || (entry.isFile() && entry.nlink!==1))) {
      throw new Error('项目专用登录目录内存在不属于此目录的状态文件。');
    }
  }
  return home;
}
export function projectAccountFingerprint(reply: Record<string, any>) {
  const {account,workspaceRouting} = reply;
  if (account?.type !== 'chatgpt' || typeof account.email !== 'string' || !account.email ||
      typeof workspaceRouting?.chatgptAccountId !== 'string' || !workspaceRouting.chatgptAccountId) return;
  return digest([account.email, workspaceRouting.chatgptAccountId, workspaceRouting.backendOrigin]);
}

function checkpointPath(home:string, invocationId:string) {
  if (!uuid.test(invocationId)) throw new Error('项目运行标识无效。');
  const dir = join(home,'platform-checkpoints');
  mkdirSync(dir,{mode:0o700,recursive:true});
  if (realpathSync(dir)!==dir) throw new Error('原生检查点目录已变化。');
  return {dir, path:join(dir,invocationId+'.json')};
}
function rolloutProof(home:string, path:string, session:string) {
  if (!uuid.test(session) || !isAbsolute(path)) throw new Error('原生历史定位无效。');
  const root = join(home,'sessions'), name=relative(root,path);
  if (!/^\d{4}\/\d{2}\/\d{2}\/rollout-[0-9T:-]{19}-[0-9a-f-]{36}\.jsonl$/.test(name) ||
      !name.endsWith('-'+session+'.jsonl') || realpathSync(root)!==root || realpathSync(path)!==path || statSync(path).nlink!==1) {
    throw new Error('原生历史不属于该专用账户的项目会话。');
  }
  return boundedFile(root,path,12*1024*1024).revision;
}
function scope(request:RuntimeRequest) {
  if (!request.sessionPlan?.fingerprint || !request.workspaceGrant) throw new Error('项目会话缺少冻结的身份。');
  return digest([request.conversationId,request.member.id,request.account.id,request.sessionPlan.fingerprint]);
}
export function restoreOfficialCheckpoint(home:string,request:RuntimeRequest) {
  const plan=request.sessionPlan;
  if (plan?.mode!=='resume' || !plan.previousInvocationId || !plan.nativeSessionId || !plan.previousAnchor) return;
  try {
    const file=checkpointPath(home,plan.previousInvocationId);
    const saved=JSON.parse(boundedFile(file.dir,file.path,4096).bytes.toString('utf8'));
    if (saved.scope===scope(request) && saved.session===plan.nativeSessionId && saved.anchor===plan.previousAnchor &&
        saved.revision===rolloutProof(home,saved.rollout,saved.session)) return String(saved.rollout);
  } catch { /* A lost or changed history starts a fresh thread before input. */ }
}
export function saveOfficialCheckpoint(home:string,request:RuntimeRequest,rollout:string,session:string,anchor:string) {
  if (request.sessionPlan?.imageTurnOnly || !uuid.test(anchor)) return false;
  try {
    const revision=rolloutProof(home,rollout,session);
    const file=checkpointPath(home,request.invocationId);
    writeFileSync(file.path,JSON.stringify({scope:scope(request),rollout,session,anchor,revision}),
      {mode:0o600,flag:'wx'});
    return true;
  } catch { return false; }
}
