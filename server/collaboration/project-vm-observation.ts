import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { AcceptanceEvidence, ProjectDomainObservation } from '../../shared/collaboration.js';
import type { ProjectVm } from './project-vm.js';

const exec = promisify(execFile);
const tag = 'project_pid_namespace_v1';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const integer = /^[1-9][0-9]{0,19}$/;
const unknown = (reason:string): ProjectDomainObservation => ({state:'unknown',reason});
const backendId = (vm:ProjectVm) => createHash('sha256').update(JSON.stringify([vm.limaHome,vm.instance,vm.runnerSha256])).digest('hex');

// The trusted guest's outer /proc sees both the supervisor in its own PID namespace and all
// enclosed processes. Attach only to this launch's root-owned namespace init while input is gated.
// No project command, VM startup, process signal, or file write is involved in either operation.
const guestProbe = `import json,os,sys
from pathlib import Path
mode,boot,*args=sys.argv[1:]
def report(value):
 print(json.dumps(value));sys.exit(0)
if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=boot: report(None)
def start(pid):
 return (Path('/proc')/pid/'stat').read_text().rsplit(')',1)[1].split()[19]
def namespace(pid):
 return str(os.stat('/proc/'+pid+'/ns/pid').st_ino)
if mode=='capture':
 nonce=args[0]
 matches=[]
 for pid in os.listdir('/proc'):
  if not pid.isdecimal(): continue
  base=Path('/proc')/pid
  try:
   if base.stat().st_uid!=0 or os.readlink(base/'exe')!=os.path.realpath('/usr/bin/python3'):continue
   cmd=(base/'cmdline').read_bytes().decode().rstrip(chr(0)).split(chr(0))
   if cmd[1:3]!=['-I','/opt/multi-agent/project-vm-runner.py'] or cmd[-2:]!=['--nonce',nonce]:continue
   fields=dict(line.split(':',1) for line in (base/'status').read_text().splitlines() if ':' in line)
   if fields['NSpid'].split()!=[pid,'1'] or any(v!='0' for v in fields['Uid'].split()):continue
   matches.append({'pid':pid,'ticks':start(pid),'namespace':namespace(pid)})
  except (FileNotFoundError,ProcessLookupError): continue
 report(matches[0] if len(matches)==1 else None)
pid,ticks,ns=args
try:
 if start(pid)!=ticks: report('exited')
 report('running' if namespace(pid)==ns and start(pid)==ticks else None)
except (FileNotFoundError,ProcessLookupError):
 # A dying task can briefly lose its namespace entry before its PID is reaped.
 try: report(None if start(pid)==ticks else 'exited')
 except (FileNotFoundError,ProcessLookupError):report('exited')`;

async function probe(vm:ProjectVm,args:string[],signal?:AbortSignal):Promise<unknown> {
  const result=await exec(vm.lima,['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--',
    'sudo','-n','/usr/bin/python3','-I','-c',guestProbe,...args],
    {cwd:'/',env:{HOME:homedir(),LIMA_HOME:vm.limaHome,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'},timeout:3500,maxBuffer:4096,signal});
  return JSON.parse(result.stdout);
}
function kernelId(input:unknown): input is {pid:string;ticks:string;namespace:string} {
  if (!input || typeof input!=='object') return false;
  const fields=input as Record<string,unknown>;
  return ['pid','ticks','namespace'].every(k=>typeof fields[k]==='string' && integer.test(fields[k] as string));
}
export async function captureProjectDomain(vm:ProjectVm,invocationId:string,nonce:string,signal:AbortSignal) {
  if (!uuid.test(invocationId) || !/^[a-f0-9]{64}$/.test(nonce)) return;
  const id=await probe(vm,['capture',vm.bootId,nonce],signal);
  if (kernelId(id)) return {observation:tag,invocationId,backend:backendId(vm),bootId:vm.bootId,pid:id.pid,ticks:id.ticks,namespace:id.namespace};
}
export async function observeProjectDomain(vm:ProjectVm|undefined,invocationId:string,evidence:AcceptanceEvidence[]):Promise<ProjectDomainObservation> {
  const matches=evidence.filter(e=>e.invocationId===invocationId && e.kind==='diagnostic' && e.detail.observation===tag);
  const record=matches[0]?.detail;
  const bootId=record?.bootId;
  if (!vm || !uuid.test(invocationId) || matches.length!==1 || !record || record.invocationId!==invocationId ||
      record.backend!==backendId(vm) || typeof bootId!=='string' || !uuid.test(bootId) || !kernelId(record)) {
    return unknown('缺少与原执行相符的虚拟机进程身份。');
  }
  try {
    const state=await probe(vm,['inspect',bootId,record.pid,record.ticks,record.namespace]);
    if (state==='running') return {state,reason:'原启动实例中的执行域进程仍存在。'};
    if (state==='exited') return {state,reason:'同一次虚拟机启动中，原 PID 命名空间的初始化进程已退出。'};
  } catch { /* A disconnected or replaced VM provides no proof of exit. */ }
  return unknown('当前无法从原启动实例核实执行域。');
}
