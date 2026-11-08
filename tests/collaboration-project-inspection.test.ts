import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import { ProjectInspection } from '../server/collaboration/project-inspection.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { Store } from '../server/store.js';

function projectExecution(store:CollaborationStore,root:string) {
  const cid=store.create({title:'断连现场',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const preview=store.workbench.previewWorkspace(cid,{path:root,mode:'project-work'});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  const sent=store.projects.submit(cid,{content:'@Codex 请修改项目文件',requestId:randomUUID()});
  assert.ok('source' in sent && sent.source.projectWork);
  const run=store.admitNext()!.invocations[0]!;
  const native={nativeSessionId:randomUUID(),nativeTurnId:randomUUID()};
  store.startInvocation(run.id);
  store.recordEvidence(run.id,{kind:'session',detail:native});
  store.recordEvidence(run.id,{kind:'accepted',detail:{...native,evidence:'turn/started'}});
  return {cid,id:run.id,native};
}
const sha=(input:string)=>createHash('sha256').update(input).digest('hex');

test('P3 inspects a disconnected project after restart, retaining operation, file, process and turn facts independently',async t=>{
  const tmp=mkdtempSync(join(tmpdir(),'project-site-')), project=join(tmp,'project'), database=join(tmp,'data','db.sqlite');
  mkdirSync(project);writeFileSync(join(project,'result.csv'),'first\n');writeFileSync(join(project,'user.txt'),'my own edit');
  let owner=new Store(database);
  t.after(()=>{owner.close();rmSync(tmp,{recursive:true,force:true});});
  const options={workspace:project,projectWorkAvailability:()=>({available:true})};
  let store=new CollaborationStore(owner,options);
  const {cid,id,native}=projectExecution(store,project);
  const event={...native,origin:'native',state:'completed',callId:'file1',name:'fileChange',path:'result.csv'};
  store.recordEvidence(id,{kind:'tool',detail:event});
  store.recordEvidence(id,{kind:'tool',detail:{...event,nativeTurnId:randomUUID(),callId:'other',path:'wrong-file'}});
  store.recordEvidence(id,{kind:'tool',detail:{...event,name:'commandExecution',state:'started',callId:'command2',path:undefined}});
  store.recordEvidence(id,{kind:'diagnostic',detail:{...native,nativeTurnId:randomUUID(),protocol:'codex-app-server',observation:'native_terminal',status:'succeeded'}});
  store.finish(id,'interrupted','回包中断',undefined,8,'runtime_unknown');
  owner.close();owner=new Store(database);store=new CollaborationStore(owner,options);
  let calls=0;
  const probe=new ProjectInspection(store,async()=>{calls++;return {state:'exited',reason:'已核对原内核身份'};});
  const cursor=store.cursor(), before=store.invocation(id);
  const first=await probe.check(cid,id,['user.txt']);
  assert.equal(first.terminal,'unknown'); assert.equal(first.teardown,'unknown'); assert.equal(first.domain.state,'exited');
  assert.deepEqual(first.operations.map(o=>[o.callId,o.state]),[['file1','completed'],['command2','started']]);
  assert.deepEqual(first.files,[{path:'result.csv',origin:'receipt',status:'present',bytes:6,sha256:sha('first\n')},
    {path:'user.txt',origin:'selected',status:'present',bytes:11,sha256:sha('my own edit')}]);
  writeFileSync(join(project,'result.csv'),'changed by editor');
  assert.equal((await probe.check(cid,id,[])).files[0]!.sha256,sha('changed by editor'));
  assert.deepEqual(store.invocation(id),before); assert.equal(store.cursor(),cursor);
  assert.equal(store.detail(cid).sources.length,1);
  assert.equal(store.detail(cid).invocations.length,1);
  assert.equal(store.detail(cid).recoveryChecks?.length??0,0);
  store.recordEvidence(id,{kind:'diagnostic',detail:{...native,protocol:'codex-app-server',observation:'native_terminal',status:'succeeded'}});
  const late=await probe.check(cid,id,[]);
  assert.equal(late.terminal,'succeeded');assert.equal(late.teardown,'unknown');assert.equal(store.invocation(id).status,'interrupted');
  await assert.rejects(()=>probe.check('another',id,[]),/此会话/);
  await assert.rejects(()=>probe.check(cid,id,['../outside']),/项目文件/);
  writeFileSync(join(tmp,'outside'),'outside'); symlinkSync(join(tmp,'outside'),join(project,'link'));
  assert.equal((await probe.check(cid,id,['link'])).files.find(f=>f.path==='link')?.status,'unavailable');
  renameSync(project,project+'-old');mkdirSync(project);writeFileSync(join(project,'result.csv'),'replacement');
  const observed=calls;
  const replaced=await probe.check(cid,id,[]);
  assert.equal(replaced.canPickFile,false); assert.equal(replaced.domain.state,'unknown'); assert.equal(calls,observed);
  assert.deepEqual(replaced.files,[{path:'result.csv',origin:'receipt',status:'unavailable'}]);
  assert.throws(()=>probe.pickRoot(cid,id),/授权/);
});

test('P3 HTTP file selection is scoped to the frozen project, cancels or retries without invoking the model',async t=>{
  const tmp=mkdtempSync(join(tmpdir(),'project-pick-')), project=join(tmp,'账本');
  mkdirSync(project); writeFileSync(join(project,'empty.csv'),'');
  let selected:string|null=null,picks=0,modelCalls=0;
  const app=await createApplication({port:0,workspace:join(tmp,'default'),dataDir:join(tmp,'private'),startWorker:false,
    projectFilePicker:async base=>{assert.equal(base,realpathSync(project));picks++;return selected;},
    collaborationRuntime:{probe:async()=>[],projectWorkAvailability:()=>({available:true}),invoke:async()=>{modelCalls++;throw Error('unexpected execution');}}});
  t.after(async()=>{await app.close();rmSync(tmp,{recursive:true,force:true});});
  const {url}=await app.start(),store=app.collaborationStore;
  const {cid,id}=projectExecution(store,project);
  const endpoint='/api/conversations/'+cid+'/project-inspections/'+id;
  const post=(route:string,body:unknown,token=app.csrfToken)=>fetch(url+endpoint+route,{method:'POST',
    headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify(body)});
  assert.equal((await post('/pick',{},'invalid')).status,403);
  assert.equal((await post('/pick?viewer=codex',{})).status,400);
  assert.equal((await post('/check',{invocationId:'other'})).status,400);
  assert.equal(picks,0);
  // macOS canonicalizes /var to /private/var. Use the real grant just as the system picker does.
  const base=store.workbench.conversation(cid).workspaceGrant!.path;
  assert.deepEqual(await (await post('/pick',{})).json(),{cancelled:true});
  selected=join(tmp,'outside');
  assert.equal((await post('/pick',{})).status,400);
  selected=join(base,'empty.csv');
  const result=await (await post('/pick',{})).json();
  assert.deepEqual(result.files,[{path:'empty.csv',origin:'selected',status:'present',bytes:0,sha256:sha('')}]);
  assert.equal(picks,3);assert.equal(modelCalls,0);
  store.workbench.revokeWorkspace(cid,store.workbench.conversation(cid).revision!,randomUUID());
  assert.equal((await post('/pick',{})).status,409);
  assert.equal((await (await post('/check',{selectedPaths:['empty.csv']})).json()).files[0].sha256,undefined);
  assert.equal(picks,3);
});
