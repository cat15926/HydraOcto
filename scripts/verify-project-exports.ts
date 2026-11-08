// An installed CLI creates the project file and requests one managed export through ordinary chat.
// All model traffic goes to loopback. The selected destination is always a new synthetic folder.
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { access,mkdir,mkdtemp,readFile,realpath,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename,join,resolve } from 'node:path';
import { createApplication } from '../server/index.js';
import { readProjectVm } from '../server/collaboration/project-vm.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { sessionFixture } from './runtime/project-session-fixture.js';
import type { ConversationDetail } from '../shared/collaboration.js';

const [id,decision]=process.argv.slice(2);
assert((id==='codex'||id==='claude') && (decision==='allow'||decision==='decline'),'usage: verify-project-exports.ts codex|claude allow|decline');
const vm=readProjectVm(resolve(process.env.P3_VM_CONFIG || '.local-data/validation/native-project-p3/p03.json'));
assert(vm && basename(vm.hostRoot).startsWith('multi-agent-vm-project-'),'dedicated synthetic mount required');
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p3/executions');
await mkdir(out,{recursive:true});
const folder=await mkdtemp(join(out,id+'-'+decision+'-'));
const work=await mkdtemp(join(vm.hostRoot,'p3-')), sub=basename(work), path=sub+'/monthly.csv';
const target=await realpath(await mkdtemp(join(tmpdir(),'monthly-delivery-'))), dest=join(target,'monthly.csv');
const data='month,total,marker\n2026-04,8,'+randomUUID()+'\n', digest=createHash('sha256').update(data).digest('hex');
await writeFile(join(work,'seed.csv'),data,{flag:'wx'});
const credential=randomUUID(), envName='P3_LOCAL_FIXTURE_CREDENTIAL';process.env[envName]=credential;
const fixture=await sessionFixture(id,sub,credential);fixture.phase('export');
const base=createCollaborationRuntime({projectVm:vm,timeoutMs:120000});
const carrier=id==='codex'?'codex-app-server':'claude-cli', name=id==='codex'?'Codex':'Claude Code';
let calls=0, picks=0,cid='';
const app=await createApplication({port:0,dataDir:join(folder,'db'),workspace:join(folder,'default'),folderPicker:async()=>{picks++;return target;},
  collaborationRuntime:{...base,async invoke(input){
    assert(input.projectWork && input.member.id===id && input.account.auth==='api' && input.mayExportProjectFile);
    assert.equal(calls++,0,'single member execution');return base.invoke(input);
  }}});
const store=app.collaborationStore;
const result:Record<string,unknown>={id,decision,model:'scripted loopback',sha256:digest,passed:false};
const delay=()=>new Promise<void>(ok=>setTimeout(ok,125));
try {
  const accountId='p3-'+id;
  store.saveAccount({id:accountId,name:'本地验收账户',provider:id,auth:'api',apiKeyEnv:envName,baseUrl:fixture.baseUrl});
  store.saveMember({id,name,enabled:true,carrier,instructions:'使用本轮工具生成月报并请求用户批准导出。',model:id==='codex'?'gpt-5':'claude-sonnet-4-6',accountId,accountBinding:'override',modelBinding:'override'});
  const {url}=await app.start();
  async function post(path:string,body:unknown) {
    const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
    assert(response.ok,path+' HTTP '+response.status+' '+(response.ok?'':(await response.text()).slice(0,180)));return response.json();
  }
  ({conversation:{id:cid}}=await post('/api/conversations',{title:'月报导出验收',memberIds:[id],defaultMemberId:id,requestId:randomUUID()}));
  const endpoint='/api/conversations/'+cid;
  const {intent}=await post(endpoint+'/messages',{content:'@'+name+' 请在项目的 '+sub+' 子目录生成 monthly.csv 并导出到项目外。',requestId:randomUUID()});
  assert(intent?.id);
  const grant=await post(endpoint+'/workspace-preview',{path:vm.hostRoot,mode:'project-work',intentId:intent.id});
  await post(endpoint+'/workspace-apply',{previewId:grant.id,requestId:randomUUID()});
  async function waitFor(check:(detail:ConversationDetail)=>boolean) {
    for(let n=0;n<960;n++){
      const d=store.detail(cid);
      if(check(d))return d;
      assert(!d.invocations.some(i=>['failed','interrupted','cancelled','succeeded'].includes(i.status)),'execution ended before requested evidence');
      await delay();
    }
    throw Error('Timed out waiting for project evidence');
  }
  const detail=await waitFor(d=>!!d.projectExports?.length), ticket=detail.projectExports![0]!;
  assert.equal(ticket.path,path);assert.equal(ticket.sha256,digest);assert.equal(ticket.state,'pending');
  const api=endpoint+'/project-exports/'+ticket.id;
  const {export:ready}=await post(api+'/pick',{expectedRevision:ticket.revision});
  assert.equal(ready.state,'ready');assert.equal(ready.targetPath,dest);
  await assert.rejects(access(dest),{code:'ENOENT'});
  const answer={requestId:randomUUID(),expectedRevision:ready.revision,payloadDigest:ready.payloadDigest,decision};
  const response=await post(api+'/decide',answer);
  const final=await waitFor(d=>d.invocations[0]?.status==='succeeded');
  const receipt=final.projectExports![0]!;
  const state=decision==='allow'?'written':'declined';
  assert.equal(receipt.state,state);assert.equal(final.projectExports!.length,1);
  assert.deepEqual(final.invocations.map(i=>[i.acceptance,i.teardown]),[['accepted','confirmed']]);
  assert.equal(await readFile(join(work,'monthly.csv'),'utf8'),data);
  if(decision==='allow'){
    assert.equal(await readFile(dest,'utf8'),data);const before=await stat(dest);
    const again=await post(api+'/decide',answer);assert.equal(again.replayed,true);
    const after=await stat(dest);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
  }else{
    assert.equal((await post(api+'/decide',answer)).replayed,true);await assert.rejects(access(dest),{code:'ENOENT'});
  }
  assert.equal(calls,1);assert.equal(picks,1);
  assert(fixture.rounds.some(r=>r.exportResult===state),'model did not receive the real export decision');
  Object.assign(result,{passed:true,state,invocationId:final.invocations[0]!.id,ticketId:receipt.id,approvedOnlyOnce:decision==='allow',initialResponse:response.export?.state});
}catch(error){process.exitCode=1; console.error((error as Error).message);}
finally{
  if(cid) result.invocations=store.detail(cid).invocations.map(i=>({id:i.id,status:i.status,error:i.error}));
  Object.assign(result,{members:calls,picks,rounds:fixture.rounds,diagnostics:fixture.diagnostics});
  await app.close();await fixture.close();delete process.env[envName];
  await writeFile(join(folder,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(folder,result.passed?'passed':'failed');
}
