import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {createHash} from 'node:crypto';
import { registerProjectVm } from '../scripts/register-project-vm.js';
import { mkdtemp, realpath, mkdir, writeFile, readFile, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceGrant } from '../shared/collaboration.js';
import { acquireProjectVm, canManageProjectRoot } from '../server/collaboration/project-vm-mount.js';
import type { ProjectVm } from '../server/collaboration/project-vm.js';

async function host(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'project-mount-state-')));
  t.after(() => rm(root,{recursive:true,force:true}));
  const limaHome = join(root,'lima'), bin = join(root,'runtime','bin'), oldRoot = join(root,'A'), newRoot = join(root,'B "quoted"');
  const instanceDir = join(limaHome,'fixture');
  for (const dir of [instanceDir,bin,oldRoot,newRoot]) await mkdir(dir,{recursive:true,mode:0o700});
  const lima = join(bin,'limactl'), yaml = join(instanceDir,'lima.yaml');
  const config = {vmType:'vz',mountType:'virtiofs',mounts:[{location:oldRoot,mountPoint:'/mnt/project',writable:true}],
    ssh:{forwardAgent:false,loadDotSSHPubKeys:false,forwardX11:false},containerd:{system:false,user:false},
    portForwards:[{guestIP:'0.0.0.0',guestIPMustBeZero:false,proto:'any',ignore:true}],propagateProxyEnv:false};
  await writeFile(yaml,JSON.stringify(config));
  const boot = '00000000-0000-4000-b000-000000000001';
  await writeFile(join(instanceDir,'test-state'),JSON.stringify({boot,device:'30',inode:'1',running:true,iteration:1}));
  await writeFile(lima,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), dir=path.join(process.env.LIMA_HOME,'fixture'), yaml=path.join(dir,'lima.yaml'), sf=path.join(dir,'test-state');
const read=p=>JSON.parse(fs.readFileSync(p)), print=x=>process.stdout.write(JSON.stringify(x)), s=read(sf);
fs.appendFileSync(path.join(dir,'test-log'),args[0]+'\\n');
if(args[0]==='list') print({name:'fixture',dir,LimaHome:process.env.LIMA_HOME,status:s.running?'Running':'Stopped',errors:s.running?undefined:[],config:read(yaml)});
else if(args[0]==='yq') print(read(yaml));
else if(args[0]==='shell'){
 if(fs.existsSync(path.join(dir,'busy')))process.exit(2);
 if(args.includes('/bin/cat')) process.stdout.write(fs.readFileSync(path.join(read(yaml).mounts[0].location,path.basename(args.at(-1)))));
 else print({boot:s.boot,device:s.device,inode:s.inode,runner:s.runner||'a'.repeat(64),binaries:['b'.repeat(64)]});
} else if(args[0]==='stop'){s.running=false;fs.writeFileSync(sf,JSON.stringify(s));}
else if(args[0]==='start'){
 if(fs.existsSync(path.join(dir,'fail-start')))process.exit(3);
 s.running=true;s.iteration++;s.boot=s.boot.slice(0,-1)+s.iteration;s.device=String(30+s.iteration);fs.writeFileSync(sf,JSON.stringify(s));
} else if(args[0]!=='validate')process.exit(2);
`); await chmod(lima,0o700);
  async function grant(path: string): Promise<WorkspaceGrant> {
    const s=await stat(path);
    return {mode:'project-work',conversationId:'c',memberIds:['m'],revision:1,authorizedAt:new Date().toISOString(),path,device:s.dev,inode:s.ino};
  }
  const old=await grant(oldRoot), next=await grant(newRoot);
  const vm: ProjectVm={manageMount:true,lima,limaHome,instance:'fixture',hostRoot:old.path,device:old.device,inode:old.inode,
    guestDevice:'30',guestInode:'1',bootId:boot,runnerSha256:'a'.repeat(64),carriers:{'codex-app-server':'b'.repeat(64)}};
  return {vm,config,yaml,instanceDir,old,next,grant,root,signal:new AbortController().signal};
}
test('managed project switch retains exact config, persists new identity and serializes across caller lifetimes',async t=>{
  const {vm,old,next,yaml,config,signal} = await host(t);
  const first=await acquireProjectVm(vm,next,signal);
  assert.equal(first.vm.hostRoot,next.path); assert.notEqual(first.vm.bootId,vm.bootId);
  assert.deepEqual(JSON.parse(await readFile(yaml,'utf8')),{...config,mounts:[{...config.mounts[0],location:next.path}]});
  await assert.rejects(acquireProjectVm(vm,old,signal),/正在使用/);
  await first.release(true);
  await assert.rejects(acquireProjectVm({...vm,manageMount:false},next,signal),/仅授权/);
  const again=await acquireProjectVm(vm,next,signal); assert.deepEqual(again.vm,first.vm); await again.release(true);
  const back=await acquireProjectVm(vm,old,signal); assert.equal(back.vm.hostRoot,old.path);
  assert.notEqual(back.vm.bootId,first.vm.bootId); await back.release(false);
  await assert.rejects(acquireProjectVm(vm,old,signal),/正在使用/);
});
test('invalid original configuration, unknown runner, unsafe roots and aborted requests cannot stop the instance',async t=>{
  const {vm,config,yaml,old,next,grant,root,instanceDir,signal}=await host(t);
  assert.ok(canManageProjectRoot(vm,next)); assert.equal(canManageProjectRoot(vm,old,[old.path]),false);
  assert.equal(canManageProjectRoot(vm,await grant(root)),false);
  await assert.rejects(acquireProjectVm(vm,old,AbortSignal.abort()));
  await assert.rejects(acquireProjectVm(vm,{...old,inode:old.inode+1},signal));
  await writeFile(join(instanceDir,'busy'),'1');
  await assert.rejects(acquireProjectVm(vm,next,signal));
  await rm(join(instanceDir,'busy'));
  await writeFile(yaml,JSON.stringify({...config,mounts:[...config.mounts,{location:root}]}));
  await assert.rejects(acquireProjectVm(vm,next,signal),/挂载/);
  await writeFile(yaml,JSON.stringify({...config,portForwards:[{...config.portForwards[0],guestIPMustBeZero:true}]}));
  await assert.rejects(acquireProjectVm(vm,next,signal),/转发/);
  assert.ok(!(await readFile(join(instanceDir,'test-log'),'utf8')).split('\n').includes('stop'));
});
test('failed restart leaves a durable unavailable lease and no fabricated new mount identity',async t=>{
  const {vm,next,signal,instanceDir}=await host(t);
  await writeFile(join(instanceDir,'fail-start'),'1');
  await assert.rejects(acquireProjectVm(vm,next,signal));
  await assert.rejects(acquireProjectVm(vm,next,signal),/正在使用/);
  await assert.rejects(stat(join(vm.limaHome,'.multi-agent-fixture.json')),{code:'ENOENT'});
});

test('registration explicitly pins verified carriers, proves both sides of a mount, creates private file and does not replace it',async t=>{
  const {vm,old,root,instanceDir}=await host(t);
  const target=join(root,'registration'); await mkdir(target,{mode:0o700});
  const out=join(target,'verified.json'), sf=join(instanceDir,'test-state');
  const raw=JSON.parse(await readFile(sf,'utf8'));
  raw.runner=createHash('sha256').update(await readFile(new URL('../scripts/runtime/project-vm-runner.py',import.meta.url))).digest('hex');
  await writeFile(sf,JSON.stringify(raw));
  const args=['--lima',vm.lima,'--lima-home',vm.limaHome,'--instance',vm.instance,'--project',old.path,'--output',out,'--manage-mount'];
  await assert.rejects(registerProjectVm(args));
  await chmod(target,0o755);
  await assert.rejects(registerProjectVm([...args,'--carrier','codex:'+'b'.repeat(64)]),/仅当前用户可访问/);
  await chmod(target,0o700);
  await assert.rejects(registerProjectVm([...args,'--carrier','codex:'+'c'.repeat(64)]));
  await registerProjectVm([...args,'--carrier','codex:'+'b'.repeat(64)]);
  assert.equal((await stat(out)).mode & 0o777,0o600);
  const value=JSON.parse(await readFile(out,'utf8'));
  assert.deepEqual(value.carriers,vm.carriers); assert.equal(value.manageMount,true);
  assert.equal(value.hostRoot,old.path); assert.equal(value.bootId,vm.bootId);
  await assert.rejects(registerProjectVm([...args,'--carrier','codex:'+'b'.repeat(64)]),{code:'EEXIST'});
});
