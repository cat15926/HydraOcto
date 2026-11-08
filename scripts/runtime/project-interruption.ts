import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {execFile, type ChildProcess} from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { access, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { ConversationDetail } from '../../shared/collaboration.js';
import type { ProjectVm } from '../../server/collaboration/project-vm.js';

export type Fault = 'stop' | 'disconnect';
const exec=promisify(execFile);
type GuestDomain = { members: string[]; namespaces: string[]; matchingRunners: number; otherRunners: number; visibleDomainMembers:number };
// The guest's trusted namespace inventories kernel process identities. No CLI environments,
// descriptors, or process command lines are sent to the host.
async function inspectDomain(vm:ProjectVm, nonce:string, before?:GuestDomain):Promise<GuestDomain> {
  const script = `import json,os,sys
from pathlib import Path
nonce=sys.argv[1]
before=json.loads(sys.argv[2])
ownns=os.readlink("/proc/self/ns/pid")
tasks={}; matched=set(); other=0
for pid in os.listdir("/proc"):
 if not pid.isdecimal(): continue
 try:
  p=Path("/proc",pid)
  ns=os.readlink(p/"ns/pid")
  stats=(p/"stat").read_text().rsplit(")",1)[1].split()
  tasks[pid]=(stats[1],pid+"@"+stats[19],ns)
  if os.readlink(p/"exe")!=os.path.realpath("/usr/bin/python3"): continue
  args=(p/"cmdline").read_bytes().decode(errors="replace").split(chr(0))
  if args[1:3]!=["-I","/opt/multi-agent/project-vm-runner.py"] or "--nonce" not in args:continue
  if args[args.index("--nonce")+1]==nonce:matched.add(pid)
  else:other+=1
 except (OSError,ValueError,IndexError):continue
domain=set(matched)
while True:
 updated=domain|{pid for pid,(ppid,ident,ns) in tasks.items() if ppid in domain}
 if updated==domain:break
 domain=updated
oldids=set(before.get("members",[])); oldns=set(before.get("namespaces",[]))
print(json.dumps(dict(members=sorted(tasks[p][1] for p in domain),namespaces=sorted({tasks[p][2] for p in domain}-{ownns}),matchingRunners=len(matched),otherRunners=other,
  visibleDomainMembers=sum(ident in oldids or ns in oldns for parent,ident,ns in tasks.values()))))`;
  assert.match(nonce,/^[a-f0-9]{64}$/);
  const {stdout}=await exec(vm.lima,['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--','sudo','-n','/usr/bin/python3','-I','-c',script,nonce,JSON.stringify(before ?? {})],
    {cwd:'/',timeout:12000,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LIMA_HOME:vm.limaHome}});
  return JSON.parse(stdout);
}
async function firstWrite(work: string, token: string) {
  const until=Date.now()+35000;
  while (Date.now()<until) {
    const value=await readFile(join(work,'first.txt'),'utf8').catch((e:NodeJS.ErrnoException)=>{ if(e.code!=='ENOENT') throw e; });
    if (value==='FIRST_'+token) return;
    await delay(80);
  }
  throw new Error('CLI did not reach the two-write synchronization point');
}
export async function prepareInterruption(fault: Fault, vm: ProjectVm, work: string, token: string, url: string, cid: string, evidence: string, projectInspectionToken?: string) {
  const modulePath=process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
  const {default:puppeteer}=await import(pathToFileURL(modulePath).href);
  const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,args:['--disable-background-networking','--no-first-run']});
  const page=await browser.newPage(); await page.setViewport({width:1360,height:880});
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const row=`.cc-thread-row[data-thread-id="${cid}"] .cc-thread-main`;
  await page.waitForSelector(row,{visible:true}); await page.click(row);
  let transport:ChildProcess | undefined;
  const spawnChannel=channel('tracing:child_process.spawn:end');
  const observe=(message:unknown)=>{
    const child=(message as {process:ChildProcess}).process;
    if (child.spawnfile===vm.lima && child.spawnargs.includes('/opt/multi-agent/project-vm-runner.py') && child.spawnargs.includes('--marker') && child.spawnargs.includes('--nonce')) transport=child;
  };
  spawnChannel.subscribe(observe);
  return {
    async verify(detail:()=>ConversationDetail,modelCount:()=>number) {
      await firstWrite(work,token);
      assert.equal(detail().sources.length,1); assert.equal(detail().invocations.length,1); assert.equal(modelCount(),1);
      const invocationId=detail().invocations[0]!.id;
      const route=url+'/api/conversations/'+cid+'/project-inspections/'+invocationId;
      async function inspect(mode:'check'|'pick') {
        const res=await fetch(route+'/'+mode,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':projectInspectionToken!},body:'{}'});
        assert.equal(res.status,200);return res.json();
      }
      if(projectInspectionToken){
        const snapshot=await inspect('check');
        assert.equal(snapshot.domain.state,'running','the platform must recognize its precise running PID namespace');
      }
      const button='.cc-native-project-activity button';
      await page.waitForSelector(button,{visible:true,timeout:12000});
      await page.screenshot({path:join(evidence,'working.png')});
      let loss: { nonce:string; before:GuestDomain; lock:string; dev:number; ino:number } | undefined;
      if (fault==='stop') {
        assert.equal(await page.$eval(button,(b:{textContent:string})=>b.textContent.trim()),'停止本次执行');
        const reply=page.waitForResponse((response:{url:()=>string;status:()=>number})=>response.url()===url+'/api/invocations/'+invocationId+'/cancel' && response.status()===200);
        await page.click(button); await reply;
      } else {
        assert(transport?.pid && transport.exitCode===null && transport.signalCode===null,'Only this isolated test invocation may lose its transport');
        const args=transport.spawnargs, nonce=args[args.indexOf('--nonce')+1]!;
        const before=await inspectDomain(vm,nonce);
        assert(before.matchingRunners===2 && before.otherRunners===0 && before.namespaces.length>=2 && before.members.length>=5,
          'Guest process identity/namespace tree not proven; control connection retained');
        const lock=join(vm.limaHome,'.multi-agent-'+vm.instance+'.lock');
        const owner=await lstat(lock);
        assert(owner.isFile() && owner.uid===process.getuid?.() && owner.nlink===1 && (owner.mode & 0o077)===0);
        loss={nonce,before,lock,dev:owner.dev,ino:owner.ino};
        await writeFile(join(evidence,'domain-before.json'),JSON.stringify(before,null,2),{mode:0o600,flag:'wx'});
        process.kill(-transport.pid,'SIGKILL');
      }
      const status=fault==='stop'?'cancelled':'interrupted';
      const until=Date.now()+15000;
      while(Date.now()<until && detail().invocations[0]?.status!==status) await delay(100);
      const terminal=detail().invocations[0]!;
      let scene:Record<string,unknown>|undefined;
      if(loss) {
        // Only the dedicated test operator recovers this test-owned lock. The product continues
        // to record the lost exit receipt and never uses this out-of-band inventory as acceptance.
        let after=await inspectDomain(vm,loss.nonce,loss.before);
        const deadline=Date.now()+15000;
        while(Date.now()<deadline && (after.visibleDomainMembers || after.matchingRunners)) {
          await delay(250); after=await inspectDomain(vm,loss.nonce,loss.before);
        }
        await writeFile(join(evidence,'domain-after.json'),JSON.stringify(after,null,2),{mode:0o600,flag:'wx'});
        assert(after.visibleDomainMembers===0 && after.matchingRunners===0 && after.otherRunners===0,'Guest domain may be active; test VM lock retained');
        if(projectInspectionToken) {
          const beforeCount = modelCount();
          const snapshot=await inspect('pick');
          assert.equal(snapshot.invocationId,invocationId);
          assert.equal(snapshot.domain.state,'exited');
          assert.equal(snapshot.teardown,'unknown');
          assert.equal(snapshot.acceptance,'accepted');
          const f = snapshot.files.find((f:{path:string})=>f.path===basename(work)+'/first.txt');
          assert.equal(f?.sha256,createHash('sha256').update('FIRST_'+token).digest('hex'));
          assert.equal(f.origin,'selected');
          assert(snapshot.operations.some((op:{name:string})=>op.name==='commandExecution'));
          assert.equal((await inspect('check')).domain.state,'exited');
          assert.equal(modelCount(),beforeCount);
          assert.equal(detail().invocations.length,1);
          assert.equal(detail().invocations[0]!.recoveryState,'pending');
          scene={domain:snapshot.domain,teardown:snapshot.teardown,actualFile:f,exactNativeOperations:snapshot.operations.length,modelCount:beforeCount};
        }
        const owner=await lstat(loss.lock);
        assert(owner.dev===loss.dev && owner.ino===loss.ino && owner.nlink===1,'Test VM lock identity changed');
        await rename(loss.lock,join(evidence,'original-vm.lock'));
      }
      assert.equal(terminal.status,status); assert.equal(terminal.acceptance,'accepted');
      assert.equal(terminal.teardown,fault==='stop'?'confirmed':'unknown');
      if(fault==='disconnect') assert.equal(terminal.recoveryState,'pending');
      await writeFile(join(work,'release.flag'),'resume',{flag:'wx'});
      await page.reload({waitUntil:'domcontentloaded'});
      await page.waitForSelector(row,{visible:true}); await page.click(row);
      const note=fault==='stop'?'已写入项目的改动会保留':'执行结果待核查';
      await page.waitForFunction('Array.from(document.querySelectorAll(".cc-native-project-activity .cc-note")).some(el=>el.textContent.includes('+JSON.stringify(note)+'))',{timeout:12000});
      await delay(700);
      await page.screenshot({path:join(evidence,'after-refresh.png')});
      assert.equal(await readFile(join(work,'first.txt'),'utf8'),'FIRST_'+token);
      await assert.rejects(access(join(work,'second.txt')),{code:'ENOENT'});
      const final=detail(); assert.deepEqual(final.invocations.map(i=>i.id),[invocationId]); assert.equal(final.sources.length,1); assert.equal(modelCount(),1);
      return {fault,invocationId,status,...(scene?{projectInspection:scene}:{}),acceptance:terminal.acceptance,teardown:terminal.teardown,recovery:terminal.recoveryState,
        firstWritePreserved:true,secondWriteAbsentAfterRelease:true,browserRefreshed:true,modelRequests:modelCount(),sources:final.sources.length,invocations:final.invocations.length};
    },
    async close(){spawnChannel.unsubscribe(observe); await browser.close();},
  };
}
