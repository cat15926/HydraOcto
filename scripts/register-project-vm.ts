/** Register an already running, operator-verified Lima project backend. Never boots or provisions a VM. */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { link, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import type { WorkspaceGrant } from '../shared/collaboration.js';
import { markerScript } from '../server/collaboration/project-vm.js';
import { inspectProjectVmForRegistration, type ProjectVmRegistration } from '../server/collaboration/project-vm-mount.js';

const exec = promisify(execFile);
const usage = 'node --import tsx scripts/register-project-vm.ts --lima /path/bin/limactl --lima-home /private/lima --instance NAME --project /selected/project --carrier codex:VERIFIED_SHA256 [--carrier claude:VERIFIED_SHA256] --output /private/project-vm.json [--manage-mount] [--history] [--official-executor codex|claude]';
export async function registerProjectVm(args: string[]) {
  const {values} = parseArgs({args, options:{
    'lima':{type:'string'}, 'lima-home':{type:'string'}, instance:{type:'string'}, project:{type:'string'}, carrier:{type:'string',multiple:true},
    'official-executor':{type:'string',multiple:true}, 'manage-mount':{type:'boolean',default:false}, history:{type:'boolean',default:false}, output:{type:'string'}, help:{type:'boolean'}
  }});
  if (values.help) { console.log(usage); return; }
  if (![values.lima,values['lima-home'],values.project,values.output].every(p=>p && isAbsolute(p)) || !values.instance || !values.carrier?.length) throw new Error(usage);
  const lima = await realpath(values.lima!), limaHome=await realpath(values['lima-home']!), project=await realpath(values.project!);
  const binary = await stat(lima), privateDir = await stat(dirname(values.output!));
  if (!binary.isFile() || ![0,process.getuid?.()].includes(binary.uid) || binary.mode & 0o022) throw new Error('请选择由本机用户或 root 管理的 limactl。');
  if (await realpath(dirname(values.output!)) !== dirname(values.output!) || !privateDir.isDirectory() || privateDir.uid !== process.getuid?.() || privateDir.mode & 0o077) throw new Error('登记目录必须已存在并仅当前用户可访问。');
  const names = {codex:'codex-app-server',claude:'claude-cli'} as const;
  const carriers: ProjectVmRegistration['carriers'] = {};
  for (const value of values.carrier) {
    const match = /^(codex|claude):([a-f0-9]{64})$/.exec(value);
    if (!match) throw new Error('--carrier 需要 codex 或 claude 及经过核验的 Linux CLI 二进制 SHA-256。');
    const carrier = names[match[1] as keyof typeof names];
    if (carriers[carrier]) throw new Error('每个承载只登记一次。');
    carriers[carrier] = match[2]!;
  }
  const officialExecutors=(values['official-executor'] ?? []).map(value=>{
    const id=names[value as keyof typeof names];
    if (!Object.hasOwn(names,value) || !carriers[id]) throw new Error('--official-executor 需要已登记的 codex 或 claude。');
    return id;
  });
  if (new Set(officialExecutors).size!==officialExecutors.length) throw new Error('请勿重复登记官方执行器。');
  const sourceRoot = fileURLToPath(new URL('../',import.meta.url));
  const runner = join(sourceRoot,'scripts/runtime/project-vm-runner.py');
  const privateRoots = [sourceRoot, resolve(process.env.APP_DATA_DIR ?? join(sourceRoot,'.local-data')),dirname(values.output!),
    ...['.ssh','.aws','.codex','.claude'].map(n=>join(homedir(),n)), ...[process.env.CODEX_HOME,process.env.CLAUDE_CONFIG_DIR].filter((p): p is string=>!!p)];
  const host = await stat(project);
  const grant: WorkspaceGrant={mode:'project-work',path:project,device:host.dev,inode:host.ino,conversationId:'registration',memberIds:['operator'],revision:1,authorizedAt:new Date().toISOString()};
  const config: ProjectVmRegistration = {...(officialExecutors.length ? {officialExecutors} : {}), ...(values.history ? {historyProtocol:"project-session-history-v1"} : {}),lima,limaHome,instance:values.instance,carriers,manageMount:values['manage-mount'],runnerSha256:createHash('sha256').update(await readFile(runner)).digest('hex')};
  const signal=AbortSignal.timeout(90000);
  const lease=await inspectProjectVmForRegistration(config,grant,signal,privateRoots);
  const nonce=randomBytes(32).toString('hex'), name='.multi-agent-bind-'+randomBytes(16).toString('hex');
  const mark = (action:string) => exec('/usr/bin/python3',['-I','-c',markerScript,project,String(host.dev),String(host.ino),name,nonce,action],{cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:action === 'create' ? 120000 : 5000});
  try {
    await mark('create');
    try {
      const {stdout}=await exec(lima,['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',values.instance,'--','/bin/cat','/mnt/project/'+name],{
        cwd:'/',signal,timeout:10000,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:homedir(),LIMA_HOME:limaHome,LC_ALL:'C'},maxBuffer:256});
      if (stdout!==nonce) throw new Error('客体目录未能读到主机在原项目内创建的随机标记。');
    } finally { await mark('remove'); }
    const staging=values.output!+'.new-'+randomBytes(12).toString('hex');
    const file=await open(staging,'wx',0o600);
    try {
      try { await file.writeFile(JSON.stringify(lease.vm,null,2)+'\n'); await file.sync(); } finally { await file.close(); }
      await link(staging,values.output!);
    } finally { await unlink(staging); }
    const parent=await open(dirname(values.output!),'r');
    try { await parent.sync(); } finally { await parent.close(); }
    console.log('已登记 '+Object.keys(carriers).join('、')+'。COLLAB_PROJECT_VM_CONFIG='+values.output);
  } finally { await lease.release(true); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  registerProjectVm(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
}
