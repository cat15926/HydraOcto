import { captureProjectDomain } from './project-vm-observation.js';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { Carrier, RuntimeRequest, WorkspaceGrant } from '../../shared/collaboration.js';
import type { CliTransport } from './runtime-common.js';
import { createProjectGateway, type ProjectGatewayRequest } from './project-vm-gateway.js';
import { beginProjectHistory, projectHistoryProtocol, type ProjectHistory } from './project-vm-history.js';
import { verifyWorkspace } from './workbench.js';

export const guestProject = '/mnt/project';
export const gatewayPlaceholder = '__PROJECT_GATEWAY__';
const exec = promisify(execFile);
export interface ProjectVm {
  lima: string; limaHome: string; instance: string;
  hostRoot: string; device: number; inode: number; guestDevice: string; guestInode: string;
  runnerSha256: string; bootId: string;
  manageMount?: boolean; historyProtocol?: typeof projectHistoryProtocol;
  /** Enabled individually, only on operator-verified VM registrations. */
  officialExecutors?: ('codex-app-server' | 'claude-cli')[];
  carriers: Partial<Record<'codex-app-server' | 'claude-cli', string>>;
}

export function readProjectVm(file: string | undefined): ProjectVm | undefined {
  if (!file) return;
  if (!isAbsolute(file)) throw new Error('虚拟机登记文件需要绝对路径。');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let vm: ProjectVm;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 8192)
      throw new Error('虚拟机登记文件必须是本机用户私有的普通文件。');
    vm = JSON.parse(readFileSync(fd, 'utf8')) as ProjectVm;
  } finally { closeSync(fd); }
  if (![vm.lima, vm.limaHome, vm.hostRoot].every(v => typeof v === 'string' && isAbsolute(v) && realpathSync(v) === v) ||
      !/^[a-z0-9][a-z0-9-]{0,48}$/.test(vm.instance) || !/^[a-f0-9]{64}$/.test(vm.runnerSha256) ||
      !/^[a-f0-9-]{36}$/.test(vm.bootId) || ![vm.device, vm.inode].every(Number.isSafeInteger) ||
      ![vm.guestDevice, vm.guestInode].every(v => typeof v === 'string' && /^\d{1,20}$/.test(v)) ||
      (vm.historyProtocol !== undefined && vm.historyProtocol !== projectHistoryProtocol) ||
      (vm.manageMount !== undefined && typeof vm.manageMount !== 'boolean') || !vm.carriers || Array.isArray(vm.carriers) || typeof vm.carriers !== 'object' || Object.entries(vm.carriers).some(([k,v]) => !['codex-app-server','claude-cli'].includes(k) || typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) throw new Error('虚拟机能力登记文件无效。');
  if (vm.officialExecutors !== undefined && (!Array.isArray(vm.officialExecutors) ||
      new Set(vm.officialExecutors).size !== vm.officialExecutors.length ||
      vm.officialExecutors.some(k => !['codex-app-server','claude-cli'].includes(k) || !vm.carriers[k]))) throw new Error('官方登录项目执行器登记无效。');
  return vm;
}

export function vmSupports(vm: ProjectVm | undefined, carrier: Carrier, grant?: WorkspaceGrant): boolean {
  return !!vm && (carrier === 'codex-app-server' || carrier === 'claude-cli') && !!vm.carriers[carrier] &&
    (!grant || (grant.path === vm.hostRoot && grant.device === vm.device && grant.inode === vm.inode));
}

// Open the physical directory before touching a marker. A rename racing with setup cannot redirect
// marker creation or removal to a replacement directory. Never unlink a file with different contents.
export const markerScript = `import os,stat,sys
root,dev,ino,name,nonce,action=sys.argv[1:]
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
s=os.fstat(fd)
if s.st_dev!=int(dev) or s.st_ino!=int(ino): raise SystemExit(2)
if action=='create':
 # Linked files are writable through every name. Count names under the authorized root
 # so a project's own internal links work without exposing files shared with another tree.
 links={}
 def unreadable(error): raise error
 try:
  for _,dirs,files,parent in os.fwalk('.',follow_symlinks=False,dir_fd=fd,onerror=unreadable):
   for entry in files:
    meta=os.stat(entry,dir_fd=parent,follow_symlinks=False)
    if stat.S_ISREG(meta.st_mode) and meta.st_nlink>1:
     key=(meta.st_dev,meta.st_ino)
     expected,seen=links.get(key,(meta.st_nlink,0))
     if expected!=meta.st_nlink: raise SystemExit(37)
     links[key]=(expected,seen+1)
  if any(expected!=seen for expected,seen in links.values()): raise SystemExit(37)
 except OSError: raise SystemExit(38)
 f=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd)
 with os.fdopen(f,'wb') as w: w.write(nonce.encode())
else:
 f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(f,'rb') as r:
  if stat.S_ISREG(os.fstat(r.fileno()).st_mode) and r.read(100)==nonce.encode(): os.unlink(name,dir_fd=fd)`;

export interface ProjectCli {
  officialCodex?: {url:string;bearer:string};
  officialClaude?: {run(command:string):Promise<{output:string;exitCode:number}>};
  readonly settled?: Promise<void>;
  readonly history?: ProjectHistory;
  readonly origin: string;
  readonly launched: boolean;
  readonly treeExited: boolean;
  readonly ready: Promise<void>;
  launch(args: string[], env: Record<string,string>): CliTransport;
  close(): Promise<void>;
}

export async function prepareProjectCli(vm: ProjectVm, request: RuntimeRequest): Promise<ProjectCli> {
  const grant = request.workspaceGrant;
  const carrier = request.member.carrier;
  if (!request.projectWork || !grant || !vmSupports(vm, carrier, grant) || grant.mode !== 'project-work' ||
      grant.conversationId !== request.conversationId || !grant.memberIds?.includes(request.member.id) || request.visibility?.kind === 'private' ||
      (carrier !== 'codex-app-server' && carrier !== 'claude-cli') ||
      (request.account.auth !== 'api' && !(request.account.auth === 'cli' && vm.officialExecutors?.includes(carrier)))) throw new Error('该运行时、目录或受众未取得虚拟机项目授权。');
  verifyWorkspace(grant);
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LIMA_HOME: vm.limaHome, LC_ALL: 'C' };
  const shell = ['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--'];
  const cliName = carrier === 'codex-app-server' ? 'codex' : 'claude';
  const runner = '/opt/multi-agent/project-vm-runner.py';
  const cli = '/opt/multi-agent/bin/' + cliName;
  const { stdout } = await exec(vm.lima, [...shell, '/bin/sh','-c',
    'cat /proc/sys/kernel/random/boot_id && sha256sum -- "$1" "$2"', 'project-identity', runner, cli],
    { env, cwd: '/', timeout: 15000, maxBuffer: 1024, signal: request.signal });
  const [boot, runnerLine, cliLine] = stdout.trim().split('\n');
  if (boot !== vm.bootId || runnerLine?.split(/\s+/)[0] !== vm.runnerSha256 || cliLine?.split(/\s+/)[0] !== vm.carriers[carrier]) throw new Error('虚拟机、隔离程序或 CLI 已变化，请重新验证该组合。');
  const nonce = randomBytes(32).toString('hex');
  const name = '.multi-agent-bind-' + randomBytes(16).toString('hex');
  const mark = async (action: 'create' | 'remove') => {
    try {
      await exec('/usr/bin/python3', ['-I','-c',markerScript, grant.path, String(grant.device), String(grant.inode), name, nonce, action],
        {cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:action === 'create' ? 120000 : 4000,signal:action === 'create' ? request.signal : undefined});
    } catch (error) {
      if ((error as {code?:number}).code === 37) throw new Error('项目中有文件通过硬链接与其他目录共用。请将该文件替换为项目内的独立副本，或在独立工作区继续。');
      throw new Error('无法完整核对所选目录。请检查目录是否正在移动及其访问权限，然后重试。');
    }
  };
  const official = request.account.auth === 'cli';
  const gateway = official ? undefined : createProjectGateway(request);
  await mark('create');
  let markerPresent = true;
  const remove = async () => {
    if (!markerPresent) return;
    markerPresent = false;
    await mark('remove').catch(() => {}); // Moving the directory may leave only the random marker in its original location.
  };
  let vault: Awaited<ReturnType<typeof beginProjectHistory>>;
  try {
    if (!official && vm.historyProtocol === projectHistoryProtocol) {
      vault = await beginProjectHistory(request, cliName, async args => (await exec(vm.lima,
        [...shell,'sudo','-n','/usr/bin/python3','-I',runner,...args], {cwd:'/',env,timeout:30000,maxBuffer:20*1024*1024})).stdout);
    }
  } catch {
    await remove();
    throw new Error('无法为本次项目执行准备隔离的原生历史。');
  }
  let acceptStart!: () => void, rejectStart!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { acceptStart = resolve; rejectStart = reject; });
  void started.catch(() => {});
  let resolveExit!: () => void;
  const settled = new Promise<void>(resolve => { resolveExit = resolve; });
  let launched = false, treeExited = false, origin = '', dispose: (() => void) | undefined;
  return {
    ...(vault ? {history:{...vault.history, finish(session:string,anchor?:string) {
      return treeExited && !request.signal.aborted ? vault.history.finish(session,anchor) : Promise.resolve(undefined);
    }}} : {}),
    get origin() { return origin; }, get launched() { return launched; }, get treeExited() { return treeExited; }, ready: started, settled,
    launch(args, environment) {
      if (launched) throw new Error('同一项目执行不能启动第二个 CLI。');
      if (official && (Object.keys(environment).length || (cliName === 'claude' ? args.length !== 0 :
        JSON.stringify(args) !== JSON.stringify(['exec-server','--listen','stdio://'])))) throw new Error('官方登录的客体只接受隔离项目工具。');
      request.signal.throwIfAborted(); verifyWorkspace(grant);
      launched = true;
      const child = spawn(vm.lima, [...shell, 'sudo','-n','/usr/bin/python3','-I', runner, '--project',guestProject,'--device',vm.guestDevice,'--inode',vm.guestInode,'--marker',name,'--nonce',nonce],
        { cwd:'/', env, stdio:'pipe', detached:true });
      let pending = '', finished = false, stopping = false, ready = false, inputReady = false, buffer = '';
      let code: number | null = null;
      const send = (frame: unknown) => {
        if (!finished && child.stdin.writable) child.stdin.write(JSON.stringify(frame)+'\n');
      };
      const stop = () => { if (!stopping) { stopping = true; send({type:'stop'}); } };
      const interrupted = () => { rejectStart(new Error('虚拟机执行已中止。')); stop(); };
      request.signal.addEventListener('abort', interrupted, { once:true });
      if (request.signal.aborted) interrupted();
      dispose = stop;
      const start = { type:'start', carrier:cliName, args, env:environment, ...(official && cliName === 'claude' ? {executor:'claude-project-command-v1'} : {}), ...(vault ? {history:vault.key} : {}) };
      const spool = (data: string, eof: boolean) => {
        if (stopping || finished) throw new Error('虚拟机执行通道已经关闭。');
        // The guest permits 1 MiB per stdin frame. Carry large JSON image messages in
        // order without splitting a Unicode code point between UTF-8 writes.
        const parts: string[] = [];
        for (let i = 0; i < data.length;) {
          let end = Math.min(data.length, i + 240_000);
          if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
          parts.push(JSON.stringify({type:'input',data:data.slice(i,end)}));
          i = end;
        }
        if (eof) parts.push('{"type":"eof"}');
        if (!parts.length) return;
        const frames = parts.join('\n') + '\n';
        if (inputReady) child.stdin.write(frames);
        else { if (pending.length + frames.length > 2_000_000) throw new Error('虚拟机待发送输入过大。'); pending += frames; }
      };
      return {
        pid: child.pid, write: d => spool(d,false), end: d => spool(d,true),
        kill(signal) { if (signal === 'SIGTERM') stop(); else if (!finished && child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* The guest exit may still be unknown. */ } } },
        connect(receive, close, fail) {
          child.stdout.setEncoding('utf8');
          child.stderr.resume();
          child.stdin.on('error', () => fail(new Error('虚拟机控制通道中断。')));
          child.on('error', () => fail(new Error('本机虚拟机管理器未能启动。')));
          child.on('close', (_hostCode, signal) => {
            request.signal.removeEventListener('abort',interrupted);
            finished = true; resolveExit();
            rejectStart(new Error('Linux 执行器在项目目录验证完成前退出。'));
            close(code, signal, treeExited);
          });
          const requests = new Set<string>();
          child.stdout.on('data', (chunk: string) => {
            try {
              buffer += chunk;
              if (buffer.length > 12_000_000) throw new Error();
              let end: number;
              while ((end=buffer.indexOf('\n')) >= 0) {
                const frame = JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
                if (treeExited) throw new Error();
                if (frame.type === 'ready' && !ready && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(frame.gatewayOrigin)) {
                  if (String(frame.device) !== vm.guestDevice || String(frame.inode) !== vm.guestInode) {
                    rejectStart(new Error('客体确认的项目目录与本次授权不一致。'));
                    stop();
                    return;
                  }
                  origin = frame.gatewayOrigin; ready = true; void remove();
                  // Leave native input behind the existing gate while taking the original process identity.
                  const witness = request.mayExportProjectFile
                    ? captureProjectDomain(vm,request.invocationId,nonce,request.signal).catch(() => undefined)
                    : Promise.resolve(undefined);
                  void witness.then(binding => {
                    if (stopping || finished || request.signal.aborted) return;
                    if (binding) request.onEvent({kind:'diagnostic',detail:binding});
                    inputReady = true;
                    acceptStart();
                    if (pending) child.stdin.write(pending);
                    pending = '';
                  }).catch(error => { rejectStart(error); stop(); });
                } else if (frame.type === 'output' && ready && typeof frame.data === 'string') receive(frame.data);
                else if (frame.type === 'request' && gateway && ready && !stopping && typeof frame.id === 'string' && !requests.has(frame.id) && requests.size < 256) {
                  requests.add(frame.id);
                  void gateway(frame as ProjectGatewayRequest).then(response => {
                    if (!stopping) send({type:'response',id:frame.id,...response});
                  }, () => send({type:'response',id:frame.id,status:502,headers:{},bodyBase64:''}));
                } else if (frame.type === 'exit' && frame.treeExited === true && Number.isInteger(frame.code)) {
                  treeExited = true; code = frame.code; child.stdin.end();
                } else if (frame.type === 'error') {
                  rejectStart(new Error('Linux 执行器未能完成目录或隔离检查。'));
                  fail(new Error('客体执行准备失败或运行中断。' + (typeof frame.code === 'string' && /^[a-z_]{1,50}$/.test(frame.code) ? frame.code : '')));
                } else throw new Error();
              }
            } catch { fail(new Error('客体执行器返回了无效或重复的控制帧。')); }
          });
          send(start);
        },
      };
    },
    async close() {
      dispose?.(); await remove();
      if (official && launched && !treeExited) {
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([settled,new Promise<void>(resolve => { timer=setTimeout(resolve,5000); timer.unref(); })]); }
        finally { clearTimeout(timer); }
      }
      if (!launched || treeExited) await vault?.discard().catch(() => {}); },
  };
}
