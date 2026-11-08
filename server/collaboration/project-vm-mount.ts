import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { constants, existsSync, realpathSync, statSync } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceGrant } from '../../shared/collaboration.js';
import { canonical } from '../store.js';
import type { ProjectVm } from './project-vm.js';
import { verifyWorkspace } from './workbench.js';

const exec = promisify(execFile);
export type ProjectVmRegistration = Pick<ProjectVm,'lima'|'limaHome'|'instance'|'runnerSha256'|'carriers'|'manageMount'|'historyProtocol'|'officialExecutors'>;
type MountState = Pick<ProjectVm,'bootId'|'hostRoot'|'device'|'inode'|'guestDevice'|'guestInode'>;
const contains = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
function safeRoot(vm: ProjectVmRegistration, grant: WorkspaceGrant, privateRoots: readonly string[]) {
  if (grant.mode !== 'project-work' || !grant.conversationId || !grant.memberIds?.length || !isAbsolute(grant.path) || contains(grant.path, realpathSync(homedir()))) return false;
  verifyWorkspace(grant);
  const protectedPaths = [vm.limaHome, dirname(dirname(vm.lima)), ...privateRoots];
  return protectedPaths.every(root => {
    if (!isAbsolute(root)) return false;
    const path = existsSync(root) ? realpathSync(root) : resolve(root);
    return !contains(path, grant.path) && !contains(grant.path, path);
  });
}
export function canManageProjectRoot(vm: ProjectVm, grant: WorkspaceGrant, privateRoots: readonly string[] = []) {
  try { return vm.manageMount === true && safeRoot(vm, grant, privateRoots); } catch { return false; }
}
function settingsFile(vm: ProjectVmRegistration, suffix: string) {
  return join(vm.limaHome, '.multi-agent-' + vm.instance + suffix);
}
async function privateFile(path: string): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await fd.stat();
    if (s.uid !== process.getuid?.() || (s.mode & 0o077) || !s.isFile() || s.nlink !== 1 || s.size > 8192) throw new Error('项目虚拟机的宿主状态文件不可信。');
    return await fd.readFile('utf8');
  } finally { await fd.close(); }
}
async function atomicWrite(path: string, text: string) {
  const staging = path + '.new-' + randomUUID();
  const fd = await open(staging,'wx',0o600);
  try {
    await fd.writeFile(text); await fd.sync(); await fd.close();
    await rename(staging,path);
    const dir = await open(dirname(path),'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await fd.close(); await unlink(staging).catch(() => {}); }
}
function metadata(vm: MountState): MountState {
  return {bootId:vm.bootId,hostRoot:vm.hostRoot,device:vm.device,inode:vm.inode,guestDevice:vm.guestDevice,guestInode:vm.guestInode};
}
async function loadState(vm: ProjectVm, registration: string): Promise<MountState> {
  let text;
  try { text = await privateFile(settingsFile(vm,'.json')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return metadata(vm); throw e; }
  const {identity, mount} = JSON.parse(text);
  if (identity !== registration || !mount || !isAbsolute(mount.hostRoot) || !Number.isSafeInteger(mount.device) ||
      !Number.isSafeInteger(mount.inode) || !/^[a-f\d-]{36}$/.test(mount.bootId) ||
      ![mount.guestDevice,mount.guestInode].every(v => typeof v === 'string' && /^\d{1,20}$/.test(v))) throw new Error('项目虚拟机登记或运行身份已改变，请重新核验。');
  return metadata(mount);
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function single(value: unknown) {
  return Array.isArray(value) && value.length === 1 && object(value[0]) ? value[0] : undefined;
}
function checkConfig(config: Record<string, unknown>, hostRoot: string, managed: boolean) {
  const mount = single(config.mounts), forward = single(config.portForwards);
  if (config.vmType !== 'vz' || config.mountType !== 'virtiofs' || !mount || mount.location !== hostRoot ||
      mount.mountPoint !== '/mnt/project' || mount.writable !== true ||
      !object(config.ssh) || config.ssh.forwardAgent !== false || config.ssh.loadDotSSHPubKeys !== false ||
      config.ssh.forwardX11 !== false || !forward || forward.ignore !== true || forward.proto !== 'any' ||
      forward.guestIP !== '0.0.0.0' || config.propagateProxyEnv !== false ||
      !object(config.containerd) || config.containerd.system !== false || config.containerd.user !== false)
    throw new Error('此实例的目录挂载、转发或宿主代理不符合专用项目实例配置。');
  if (managed) {
    const fullRange = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 2 && v[0] === 1 && v[1] === 65535);
    if (forward.guestIPMustBeZero !== false || forward.guestPort !== undefined || forward.hostPort !== undefined ||
        forward.guestSocket !== undefined || forward.hostSocket !== undefined || forward.reverse === true ||
        !fullRange(forward.guestPortRange) || !fullRange(forward.hostPortRange) || config.ssh.forwardX11Trusted === true)
      throw new Error('自动切换需要禁用所有接口上的端口和 SSH 转发。');
  }
  return mount;
}
const allowedYamlKeys = new Set(['minimumLimaVersion','vmType','arch','cpus','memory','disk','images','mountType','mounts','ssh','containerd','portForwards','propagateProxyEnv']);
const guestInspect = `import hashlib,json,os,stat,sys
from pathlib import Path
runner='/opt/multi-agent/project-vm-runner.py'
bins=[Path('/opt/multi-agent/bin',n).resolve(strict=True) for n in sys.argv[1:]]
for p in Path('/proc').iterdir():
 if not p.name.isdigit(): continue
 try:
  args=(p/'cmdline').read_bytes().split(b'\\0')
  exe=(p/'exe').resolve(strict=True)
 except (FileNotFoundError,ProcessLookupError): continue
 if runner.encode() in args or exe in bins or exe.name=='bwrap': raise SystemExit('active project process')
def digest(p):
 p=Path(p)
 for part in (p,*p.parents):
  s=part.stat()
  if s.st_uid or s.st_mode & 0o022: raise SystemExit('untrusted guest installation')
 with p.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
roots=[l.split()[4] for l in Path('/proc/self/mountinfo').read_text().splitlines() if l.split(' - ')[1].split()[0]=='virtiofs']
if roots!=['/mnt/project']: raise SystemExit('unexpected guest mounts')
s=os.stat('/mnt/project')
print(json.dumps(dict(boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip(),device=str(s.st_dev),inode=str(s.st_ino),runner=digest(runner),binaries=[digest(p) for p in bins])))`;

async function lockVm(vm: ProjectVmRegistration) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(vm.instance) || vm.limaHome !== realpathSync(vm.limaHome) || vm.lima !== realpathSync(vm.lima))
    throw new Error('项目虚拟机登记路径无效。');
  const instanceDir = join(vm.limaHome,vm.instance);
  for (const path of [vm.limaHome,instanceDir]) {
    const dir = await lstat(path);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw new Error('虚拟机必须位于当前用户的私有实例目录。');
  }
  const lockPath = settingsFile(vm,'.lock'), token = randomUUID();
  let lock;
  try { lock = await open(lockPath,'wx',0o600); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('项目虚拟机正在使用或上次退出待核查。'); throw e; }
  try { await lock.writeFile(token); await lock.sync(); } finally { await lock.close(); }
  const parent = await open(vm.limaHome, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  let released = false;
  async function release(safe: boolean) {
    if (released) return;
    released = true;
    if (safe && await privateFile(lockPath) === token) await unlink(lockPath);
  }
  return release;
}
function vmCommands(vm: ProjectVmRegistration, signal: AbortSignal) {
  const instanceDir = join(vm.limaHome,vm.instance);
  const env = {LIMA_HOME:vm.limaHome, HOME:homedir(), PATH:'/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL:'C'};
  const command = async (args: string[], timeout = 30000) => {
    const {stdout} = await exec(vm.lima,args,{env,cwd:'/',timeout,signal,maxBuffer:512*1024});
    return stdout.trim();
  };
  async function instance(expected: 'Running'|'Stopped', path: string) {
    const info = JSON.parse(await command(['list','--format','json',vm.instance]));
    if (info.name !== vm.instance || info.dir !== instanceDir || info.status !== expected || info.LimaHome !== vm.limaHome ||
        (info.errors !== undefined && (!Array.isArray(info.errors) || info.errors.length > 0)) || !object(info.config)) throw new Error('专用虚拟机不在预期状态，无法安全切换项目。');
    checkConfig(info.config,path,vm.manageMount === true);
  }
  async function inspect() {
    const carriers = Object.entries(vm.carriers);
    const names = carriers.map(([k]) => k === 'claude-cli' ? 'claude' : 'codex');
    const args = ['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--','sudo','-n','/usr/bin/python3','-I','-c',guestInspect,...names];
    const obs = JSON.parse(await command(args,60000));
    if (obs.runner !== vm.runnerSha256 || !Array.isArray(obs.binaries) || obs.binaries.length !== carriers.length || !carriers.every(([,sha],i)=>obs.binaries[i]===sha) ||
        !/^[a-f\d-]{36}$/.test(obs.boot) || ![obs.device,obs.inode].every(v=>typeof v==='string' && /^\d{1,20}$/.test(v))) throw new Error('虚拟机、客体执行器或 CLI 身份无法核验。');
    return {bootId:String(obs.boot),guestDevice:String(obs.device),guestInode:String(obs.inode)};
  }
  return {command,instance,inspect};
}

export async function inspectProjectVmForRegistration(vm: ProjectVmRegistration, grant: WorkspaceGrant, signal: AbortSignal, privateRoots: readonly string[]) {
  signal.throwIfAborted();
  if (!safeRoot(vm,grant,privateRoots)) throw new Error('登记项目与私有数据或运行器重叠。');
  const release = await lockVm(vm);
  try {
    const {instance,inspect} = vmCommands(vm,signal);
    await instance('Running',grant.path);
    const observed = await inspect();
    const registered: ProjectVm = {...vm, hostRoot:grant.path,device:grant.device,inode:grant.inode,...observed};
    if (existsSync(settingsFile(vm,'.json'))) throw new Error('此实例已有受管挂载记录，请沿用该登记并核验其状态。');
    return {vm:registered,release};
  } catch (e) { await release(true); throw e; }
}

export async function acquireProjectVm(vm: ProjectVm, grant: WorkspaceGrant, signal: AbortSignal, privateRoots: readonly string[] = []) {
  signal.throwIfAborted();
  if (!safeRoot(vm,grant,privateRoots)) throw new Error('项目目录与平台、运行器或私有数据重叠。');
  const release = await lockVm(vm);
  let uncertain = false;
  const instanceDir = join(vm.limaHome,vm.instance);
  const {command,instance,inspect} = vmCommands(vm,signal);
  const yaml = join(instanceDir,'lima.yaml');
  const registration = createHash('sha256').update(canonical({...metadata(vm),instance:vm.instance,lima:vm.lima,limaHome:vm.limaHome,runner:vm.runnerSha256,carriers:vm.carriers})).digest('hex');
  try {
    const state = vm.manageMount === true ? await loadState(vm,registration) : metadata(vm);
    const same = grant.path === state.hostRoot && grant.device === state.device && grant.inode === state.inode;
    if (!same && vm.manageMount !== true) throw new Error('此实例仅授权登记时的项目目录。');
    const old = statSync(state.hostRoot);
    if (realpathSync(state.hostRoot) !== state.hostRoot || old.dev !== state.device || old.ino !== state.inode) throw new Error('原项目目录身份已变化，请重新核验。');
    await instance('Running',state.hostRoot);
    const observed = await inspect();
    if (observed.bootId !== state.bootId || observed.guestDevice !== state.guestDevice || observed.guestInode !== state.guestInode) throw new Error('原实例启动身份或挂载身份已改变。');
    if (same) return {vm:{...vm,...state},release};
    for (const config of ['override.yaml','default.yaml']) if (existsSync(join(vm.limaHome,'_config',config))) throw new Error('专用实例不能继承额外宿主配置。');
    const file = await lstat(yaml);
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o022) || file.size > 32768) throw new Error('实例配置文件不可信。');
    const before = await readFile(yaml,'utf8');
    const config = JSON.parse(await command(['yq','-o=json','-I=0','.',yaml])) as Record<string,unknown>;
    if (Object.keys(config).some(k=>!allowedYamlKeys.has(k))) throw new Error('实例包含不适用于自动切换的附加配置。');
    const mount = checkConfig(config,state.hostRoot,true);
    if (Object.keys(mount).some(k=>!['location','mountPoint','writable'].includes(k))) throw new Error('项目挂载含额外选项。');
    verifyWorkspace(grant);
    uncertain = true;
    await command(['stop',vm.instance],90000);
    await instance('Stopped',state.hostRoot);
    if (await readFile(yaml,'utf8') !== before) throw new Error('停机期间实例配置已变化。');
    verifyWorkspace(grant);
    mount.location = grant.path;
    await atomicWrite(yaml,JSON.stringify(config,null,2)+'\n');
    await command(['validate',yaml]);
    await instance('Stopped',grant.path);
    verifyWorkspace(grant);
    await command(['start','--tty=false',vm.instance],180000);
    await instance('Running',grant.path);
    const current = await inspect();
    if (current.bootId === state.bootId) throw new Error('未取得重新启动后的实例身份。');
    verifyWorkspace(grant);
    const mountState: MountState = { ...current, hostRoot:grant.path, device:grant.device, inode:grant.inode };
    await atomicWrite(settingsFile(vm,'.json'),JSON.stringify({identity:registration,mount:mountState}));
    return {vm:{...vm,...mountState},release};
  } catch (e) { await release(!uncertain); throw e; }
}
