// An existing approved PR is fixture history; every member turn after the user's CI request is native.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';
import { isolatedClaude } from './hydra-test-native.mjs';

const [mode,variant]=process.argv.slice(2);
assert(mode==='--live' && ['passed','failed','expired'].includes(variant));
const base=resolve(process.env.VALIDATION_OUTPUT_DIR||tmpdir());
await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,'hydra-ci-'+variant+'-'));
const workspace=join(dir,'project'),profile=join(dir,'claude');
await Promise.all([workspace,profile].map(path=>mkdir(path,{mode:0o700})));
const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
const native=createCollaborationRuntime({timeoutMs:150_000});
const calls=[],observations=[],commit='a'.repeat(40),other='b'.repeat(40),branch='codex/collab-ci-sample';
const deadline=Date.now()+330_000;
let checkHead=commit,conclusion=null;
const repo={full_name:'example/hydra-ci-sample'};
const pull={number:8,state:'open',base:{ref:'main',repo},head:{ref:branch,sha:commit,repo}};
const plan={remote:'https://github.com/example/hydra-ci-sample.git',local:other,parent:other,commit,branch,
  files:['example.txt'],diff:'+sample',message:'Historical CI fixture',pull:{base:'main',localBranch:'main',expectedHead:null,repair:false}};
async function readGitHub(path,fields) {
  assert(!fields,'The isolated GitHub fixture only accepts observations');
  if(path.includes('/pulls?')) return [pull];
  if(path.endsWith('/pulls/8')) return pull;
  if(path.includes('/commits/'+commit+'/check-runs?')) {
    observations.push({commit:checkHead,conclusion});
    return {total_count:1,check_runs:[{id:101,head_sha:checkHead,name:'test',status:conclusion?'completed':'in_progress',conclusion}]};
  }
  if(path.includes('/commits/'+commit+'/status?'))return {sha:commit,total_count:0,statuses:[]};
  throw Error('Unexpected read: '+path);
}
const runtime={...native,projectWorkAvailability:()=>({available:true}),async invoke(req) {
  assert(calls.length<(variant==='expired'?1:2) && Date.now()<deadline,'Native budget exceeded');
  assert(req.member.id==='claude' && req.account.id===account.id && !req.projectWork && !req.projectReview);
  calls.push({id:req.invocationId,member:req.member.id,role:calls.length?'reporter':'watcher'});
  return native.invoke(req);
}};
const app=await createApplication({dataDir:join(dir,'db'),workspace,port:0,startWorker:false,collaborationRuntime:runtime,projectGitHub:async()=>readGitHub});
const store=app.collaborationStore,report={variant,passed:false,calls,observations,carrier:selected.carrier,model:selected.model,
  externalSource:'isolated read-only GitHub PR/check-run fixture',priorHistory:'synthetic approved delivery, before the actual user request',remoteWrites:0};
let cid,card,userSource,failure;
try {
  store.saveAccount(account);
  store.saveMember({id:'claude',name:'林',carrier:'claude-cli',accountId:account.id,model:selected.model,accountBinding:'override',modelBinding:'override',enabled:true,
    instructions:'根据用户的委托跟进，并把真实结果如实汇报。'});
  cid=store.create({title:'CI 观察',memberIds:['claude'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
  const grant=store.workbench.previewWorkspace(cid,{path:workspace,mode:'project-work'});
  store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},cid);
  store.projects.submit(cid,{content:'@林 把项目改动提 PR 到 main。',requestId:randomUUID()});
  const past=store.admitNext().invocations[0];
  store.startInvocation(past.id);store.recordEvidence(past.id,{kind:'accepted',detail:{source:'historical fixture'}});
  const approval=store.interactions.wait(past.id,{operation:'project_git_deliver',kind:'approval',providerRequestId:'ci-fixture',nativeItemId:'ci-fixture',
    gitDelivery:plan,payload:{grantRevision:store.contract(past.id).workspaceGrant.revision}},'project-git',new AbortController().signal);
  card=store.interactions.list(cid)[0];
  store.interactions.answer(card.id,{requestId:randomUUID(),expectedRevision:card.revision,payloadDigest:card.payloadDigest,decision:'allow_once'});await approval;
  store.recordEvidence(past.id,{kind:'tool',detail:{origin:'project_git',state:'completed',callId:'ci-fixture',commit}});
  store.recordEvidence(past.id,{kind:'process_exit',detail:{confirmed:true}});
  store.finish(past.id,'succeeded','PR #8 已创建，正在等测试。');
  const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
  app.collaborationEngine.pulls.tick();
  const waits=async fn=>{while(Date.now()<deadline){const v=fn();if(v)return v;await delay(250);}throw Error('Timed out waiting for the next observable state');};
  await waits(()=>store.interactions.get(card.id).pullStatus?.number===8);
  assert.equal(store.interactions.get(card.id).pullStatus.state,'pending');
  const before=store.detail(cid);
  const until=new Date(Math.floor(Date.now()/1000)*1000+8*60_000).toISOString();
  const text='@林 请只读跟进刚刚获准的 PR #8 的提交 '+commit+'。等它的 CI 实际跑完，把通过或失败及对应提交告诉我。截止 '+until+'。如果到时还没有结果，就在这份委托上标明已逾期，留给我核查。';
  const res=await fetch(url+'/api/conversations/'+cid+'/messages',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({content:text,requestId:randomUUID()})});
  assert(res.ok,'Submit returned '+res.status);
  const input=await res.json();userSource=input.source.id;
  app.collaborationEngine.start();
  const root=()=>store.obligations.list(cid).find(o=>!o.parentId&&o.originSourceId===userSource);
  const newlyFailed=()=>store.detail(cid).invocations.find(i=>i.id!==past.id && ['failed','cancelled','interrupted'].includes(i.status));
  function checkDone() {const f=newlyFailed();assert(!f,'Member '+f?.memberId+' '+f?.status+' '+(f?.error??''));return calls.length>0 && calls.every(c=>store.invocation(c.id).status==='succeeded');}
  await waits(()=>checkDone() && root()?.state==='waiting');
  const waiting=root(),owner=waiting.owner,condition='ci:'+card.id+':'+commit;
  assert.equal(waiting.wait.condition,condition);assert.deepEqual(waiting.wait.returnTo,owner);
  assert.equal(Date.parse(waiting.wait.deadline),Date.parse(until));
  assert.equal(calls.length,1);
  const jobSources=()=>store.detail(cid).sources.filter(s=>s.kind==='job_result'&&!before.sources.some(old=>old.id===s.id));
  report.wait={rootId:waiting.id,owner,initialUserSource:userSource,waitId:waiting.wait.id,condition,deadline:waiting.wait.deadline};
  if(variant==='expired') {
    store.options.clock=()=>Date.parse(waiting.wait.deadline)+1;
    store.obligations.reconcile();
    const overdue=root();
    assert.equal(overdue.state,'blocked');assert.match(overdue.reason,/到期/);assert.deepEqual(overdue.owner,owner);
    assert.equal(jobSources().length,0);assert(!overdue.delivery);assert.equal(calls.length,1);
    report.expiry={state:overdue.state,reason:overdue.reason,clock:'isolated server clock advanced past the actual registered deadline'};
  } else {
    if(variant==='failed') {
      checkHead=other;conclusion='success';
      await app.collaborationEngine.pulls.refresh(card.id);store.obligations.reconcile();
      assert.equal(root().state,'waiting');assert.equal(jobSources().length,0);
      assert(observations.some(o=>o.commit===other&&o.conclusion==='success'));
      report.unrelatedCheckIgnored={commit:other,wakes:0};
    }
    checkHead=commit;conclusion=variant==='passed'?'success':'failure';
    await app.collaborationEngine.pulls.refresh(card.id);store.obligations.reconcile();
    await app.collaborationEngine.pulls.refresh(card.id);store.obligations.reconcile();
    await waits(()=>checkDone() && root()?.state==='delivered');
    const final=root(),wakes=jobSources(),d=store.detail(cid);
    const word=variant==='passed'?'通过':'失败';
    assert.equal(wakes.length,1);assert(wakes[0].content.includes(commit)&&wakes[0].content.includes('CI '+word));
    assert.equal(d.consumptions.filter(c=>c.sourceId===wakes[0].id&&c.memberId==='claude').length,1);
    assert.deepEqual(final.owner,owner);assert.equal(calls.length,2);
    const message=d.messages.find(m=>m.id===final.delivery.messageId);
    assert(message.memberId==='claude' && message.content.includes(word) && message.content.includes(commit.slice(0,8)));
    report.result={wake:wakes[0].id,status:store.interactions.get(card.id).pullStatus.state,message:message.id,content:message.content};
  }
  const d=store.detail(cid);
  assert.equal(d.messages.filter(m=>m.author==='user').length-before.messages.filter(m=>m.author==='user').length,1);
  report.executions=calls.map(c=>store.invocation(c.id)).map(i=>({id:i.id,member:i.memberId,nativeSessionId:i.nativeSessionId,status:i.status,acceptance:i.acceptance,teardown:i.teardown}));
  assert(report.executions.every(i=>i.status==='succeeded'&&i.acceptance==='accepted'&&i.teardown==='confirmed'&&i.nativeSessionId));
  report.passed=true;
} catch(e){failure=e;report.error=String(e.message).slice(0,480);process.exitCode=1;}
finally{
  if(cid)report.states=store.obligations.list(cid).map(o=>({id:o.id,state:o.state,reason:o.reason}));
  await app.close();
  const out=join(dir,'result.json');
  await writeFile(out,JSON.stringify(report,null,2).replaceAll(process.env[account.apiKeyEnv],'[redacted]')+'\n',{mode:0o600,flag:'wx'});
  console.log(failure?'failed':'passed',out);
}

