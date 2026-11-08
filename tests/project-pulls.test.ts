import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { GitDeliveryPreview } from '../shared/collaboration.js';
import { observePull, type GitHubApi } from '../server/collaboration/project-github.js';
import { ProjectPullMonitor, requestsCiRepair, requestsPullRequest } from '../server/collaboration/project-pulls.js';

const commit='a'.repeat(40), other='b'.repeat(40), branch='codex/collab-t';
const plan:GitDeliveryPreview={remote:'https://github.com/example/test.git',local:other,commit,parent:other,
  files:['report.txt'],branch,diff:'+file',message:'Add report',pull:{base:'main',localBranch:'main',expectedHead:null,repair:true}};
const slug={full_name:'example/test'};
const pr=()=>({number:8,state:'open',base:{ref:'main',repo:slug},head:{ref:branch,sha:commit,repo:slug}});
test('recover an acknowledged PR whose create response was lost, then bind checks to the current head',async()=>{
  let created=0,tip=commit,complete=false,empty=false;
  const api:GitHubApi=async(path,fields)=>{
    if (fields) {assert.equal(fields.head,branch);created++;throw new Error('lost response');}
    if (path.includes('/pulls?')) return created?[pr()]:[];
    if (path.includes('/git/ref')) return {object:{sha:commit}};
    if (path.endsWith('/pulls/8')) {const p=pr();p.head.sha=tip;return p;}
    if (path.includes('check-runs')) return {total_count:empty?0:1,check_runs:empty?[]:[{
      id:1,head_sha:commit,name:'verify',status:'completed',conclusion:complete?'success':'failure',
      details_url:'https://github.com/example/test/actions/runs/3/job/4'}]};
    return {sha:commit,total_count:0,statuses:[]};
  };
  api.failedLog=async()=>'Expected 125, actual 0';
  const verify=()=>{};
  await assert.rejects(observePull(plan,undefined,api,verify),/lost response/);
  const failed=await observePull(plan,undefined,api,verify);
  assert.equal(failed.number,8);assert.equal(failed.state,'failed');assert.equal(failed.checks?.[0]?.summary,'Expected 125, actual 0');
  complete=true;assert.equal((await observePull(plan,8,api,verify)).state,'passed');
  empty=true;assert.equal((await observePull(plan,8,api,verify)).state,'waiting');
  tip=other;assert.equal((await observePull(plan,8,api,verify)).state,'superseded');
  assert.equal(created,1);
});
test('reject an unrelated pull and do not open a PR after revocation',async()=>{
  const foreign=pr();foreign.head.repo={full_name:'third/fork'};
  await assert.rejects(observePull(plan,8,async()=>foreign,()=>{}),/仓库或分支/);
  let active=true,posts=0;
  await assert.rejects(observePull(plan,undefined,async(path,fields)=>{
    if(fields) posts++;
    if(path.includes('/git/ref')) {active=false;return {object:{sha:commit}};}
    return [];
  },()=>{if (!active) throw new Error('withdrawn');}),/withdrawn/);
  assert.equal(posts,0);
});
test('explicit CI repair opt-in and ordinary delivery remain distinct',()=>{
  assert(requestsPullRequest('修复漏算，提 PR 到 main，检查失败就继续修'));
  assert(requestsCiRepair('修复漏算，提 PR 到 main，检查失败就继续修'));
  assert(!requestsCiRepair('提 PR，CI 失败等我处理'));
  assert(!requestsCiRepair('CI 失败不要自动修复'));
  assert(!requestsPullRequest('只需要推送，不要提 PR'));
});


test('an approved CI failure survives restart and routes a single project repair to its author',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'pr-checks-'))), folder=join(root,'project');
  mkdirSync(folder);
  const owner=new Store(join(root,'db','test.sqlite'));
  t.after(()=>{owner.close();rmSync(root,{recursive:true,force:true});});
  const store=new CollaborationStore(owner,{workspace:folder,projectWorkAvailability:()=>({available:true})});
  const cid=store.create({title:'PR checks',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const grant=store.workbench.previewWorkspace(cid,{path:folder,mode:'project-work'});
  store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},cid);
  store.projects.submit(cid,{content:'@Codex 把项目改动提 PR 到 main，CI 失败就继续修',requestId:randomUUID()});
  const run=store.admitNext()!.invocations[0]!;
  assert.equal(store.visibility.primary(run.id).allowCiRepair,true);
  store.startInvocation(run.id);
  store.recordEvidence(run.id,{kind:'accepted',detail:{source:'fixture'}});
  const choice=store.interactions.wait(run.id,{operation:'project_git_deliver',kind:'approval',providerRequestId:'git:test',
    nativeItemId:'test',gitDelivery:plan,payload:{grantRevision:store.contract(run.id).workspaceGrant!.revision}},'project-git',new AbortController().signal);
  const card=store.interactions.list(cid)[0]!;
  store.interactions.answer(card.id,{requestId:randomUUID(),expectedRevision:card.revision,payloadDigest:card.payloadDigest,decision:'allow_once'});
  await choice;
  store.recordEvidence(run.id,{kind:'tool',detail:{origin:'project_git',state:'completed',callId:'test',commit}});
  store.recordEvidence(run.id,{kind:'process_exit',detail:{confirmed:true}});
  store.finish(run.id,'succeeded','Branch pushed');
  const mock:GitHubApi=async path=>{
    if(path.includes('/pulls?')) return [pr()];
    if(path.endsWith('/pulls/8')) return pr();
    if(path.includes('/check-runs?')) return {total_count:1,check_runs:[{id:4,name:'test',head_sha:commit,status:'completed',conclusion:'failure',
      details_url:'https://github.com/example/test/actions/runs/3/job/4'}]};
    return {sha:commit,total_count:0,statuses:[]};
  };
  mock.failedLog=async()=>'AssertionError: expected -125';
  const monitor=new ProjectPullMonitor(store,async()=>mock);
  monitor.tick();
  for(let n=0;n<40 && !store.interactions.get(card.id).repairSourceId;n++) await delay(25);
  await monitor.stop();
  const resumed=new ProjectPullMonitor(store,async()=>mock);
  try {
    await Promise.all([resumed.refresh(card.id),resumed.refresh(card.id)]);
    const repairs=store.detail(cid).sources.filter(s=>s.projectCiRepair);
    assert.equal(repairs.length,1);
    assert.deepEqual(repairs[0]!.requestedTargets,[run.memberId]);
    assert.match(repairs[0]!.content,/expected -125/);
    assert.equal(repairs[0]!.id,store.interactions.get(card.id).repairSourceId);
    const revision=store.admitNext()!.invocations[0]!;
    assert.equal(revision.memberId,run.memberId);
    assert.equal(store.contract(revision.id).gitDelivery,true);
    store.startInvocation(revision.id);
    store.recordEvidence(revision.id,{kind:'accepted',detail:{source:'fixture'}});
    assert.equal(store.requireProjectCapability(revision.id,'gitDelivery').path,folder);
    store.workbench.revokeWorkspace(cid,store.workbench.conversation(cid).revision!,randomUUID());
    await assert.rejects(resumed.refresh(card.id));
    assert.throws(()=>store.requireProjectCapability(revision.id,'gitDelivery'));
  } finally {await resumed.stop();}
});


test('a PR update stays pending when GitHub still reports the approved predecessor',async()=>{
  const next={...plan,commit:other,pull:{...plan.pull!,number:8,expectedHead:commit}};
  let heads:string[]=[];
  let checks=0;
  const api:GitHubApi=async path=>{
    if(path.endsWith('/pulls/8')) {
      const item=pr();item.head.sha=heads.shift()!;return item;
    }
    if(path.includes('check-runs')) {
      checks++;
      assert(path.includes('/commits/'+other+'/'));
      return {total_count:1,check_runs:[{id:1,head_sha:other,name:'verify',status:'completed',conclusion:'success'}]};
    }
    return {sha:other,total_count:0,statuses:[]};
  };
  const observe=()=>observePull(next,8,api,()=>{});
  heads=[commit];assert.equal((await observe()).state,'waiting');assert.equal(checks,0);
  heads=[other,commit];assert.equal((await observe()).state,'waiting');
  heads=[other,other];assert.equal((await observe()).state,'passed');
  heads=['f'.repeat(40)];const superseded=await observe();
  assert.equal(superseded.state,'superseded');assert.equal(superseded.observedHead,'f'.repeat(40));
});
