/** Explicit on-host acceptance for a dedicated, idle VM and a disposable initial project. No inference. */
import {execFile} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rmdir, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {readProjectVm} from '../server/collaboration/project-vm.js';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.js';
import type {WorkspaceGrant} from '../shared/collaboration.js';

const run=promisify(execFile);
const {values} = parseArgs({options:{registry:{type:'string'},from:{type:'string'},help:{type:'boolean'}}});
if (values.help || !values.registry || !values.from) {
  console.log('node --import tsx scripts/verify-project-vm-switch.ts --registry /private/project-vm.json --from /currently-mounted/disposable-project');
  process.exit(values.help?0:2);
}
const vm=readProjectVm(values.registry);
if (!vm?.manageMount) throw new Error('需要已单独登记且允许项目切换的空闲专用实例。');
const from=await realpath(values.from);
if (from!==vm.hostRoot) throw new Error('--from 必须明确指定登记时的合成项目。');
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LIMA_HOME:vm.limaHome,HOME:homedir(),LC_ALL:'C'};
const signal=AbortSignal.timeout(480000);
const invoke=(args:string[])=>run(vm.lima,args,{env,cwd:'/',signal,timeout:30000,maxBuffer:256*1024});
const before=JSON.parse((await invoke(['list','--format','json',vm.instance])).stdout);
if (before.status!=='Running' || before.config.mounts.length!==1 || before.config.mounts[0].location!==from) throw new Error('实例当前绑定未匹配，停止验收。');
const output=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-vm-switch/'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output,{recursive:true,mode:0o700});
const tmp=await realpath(await mkdtemp(join(tmpdir(),'project-switch-proof-')));
const marker=randomUUID(), value=randomBytes(32).toString('hex');
const protectedRoots=[resolve(process.env.APP_DATA_DIR||'.local-data'),dirname(resolve(values.registry)),resolve('scripts/runtime/project-vm-runner.py')];
async function grant(path:string):Promise<WorkspaceGrant> {
  const s=await stat(path);
  return {path,device:s.dev,inode:s.ino,mode:'project-work',conversationId:'acceptance',memberIds:['fixture'],authorizedAt:new Date().toISOString(),revision:1};
}
const check: Record<string,unknown>={realModelCalls:0,from,tmp,instance:vm.instance};
try {
  const start=await acquireProjectVm(vm,await grant(from),signal,protectedRoots);
  check.startBoot=start.vm.bootId; await start.release(true);
  await writeFile(join(tmp,marker),value,{flag:'wx',mode:0o644});
  const switched=await acquireProjectVm(vm,await grant(tmp),signal,protectedRoots);
  let known=false;
  try {
    const shell=['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--'];
    const read=(await invoke([...shell,'/bin/cat','/mnt/project/'+marker])).stdout;
    if(read!==value || switched.vm.bootId===start.vm.bootId) throw new Error('合成项目或重启身份不匹配。');
    check.switchedBoot=switched.vm.bootId;
    check.sameDiskMarker=true;
    known=true;
  } finally { await switched.release(known); }
  const restored=await acquireProjectVm(vm,await grant(from),signal,protectedRoots);
  if(restored.vm.bootId===switched.vm.bootId) {await restored.release(false);throw new Error('未取得恢复原目录后的启动身份。');}
  check.restoredBoot=restored.vm.bootId; await restored.release(true);
  check.restored=true;
  if(await readFile(join(tmp,marker),'utf8')!==value)throw new Error('验收文件发生并发变化，保留现场。');
  await unlink(join(tmp,marker)); await rmdir(tmp);
  await writeFile(join(output,'result.json'),JSON.stringify(check,null,2)); console.log(output);
} catch(e) {
  await writeFile(join(output,'failure.json'),JSON.stringify({...check,error:(e as Error).message},null,2));
  console.error('验收未完成，合成目录与不确定的租约保留。详见 '+output);
  process.exitCode=1;
}
