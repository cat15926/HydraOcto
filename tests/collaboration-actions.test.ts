import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { textDigest } from '../server/collaboration/visibility.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import type { ActionRecord, ConversationMessage, CrossGrant } from '../shared/collaboration.js';
const rid=()=>randomUUID();
function fixture(){const root=mkdtempSync(join(tmpdir(),'n9-test-')),workspace=join(root,'project');mkdirSync(workspace);let time=Date.now();const db=join(root,'private','state.sqlite'),owner=new Store(db),store=new CollaborationStore(owner,{workspace,artifactDir:join(root,'private','artifacts'),clock:()=>time});
 const home=store.create({requestId:rid(),title:'Home',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation,target=store.create({requestId:rid(),title:'Target',memberIds:['codex','claude'],defaultMemberId:'claude'}).conversation;
 const grant=()=>store.cross.createGrant(home.id,{requestId:rid(),homeMemberId:'codex',targetConversationId:target.id,targetMemberId:'claude',expiresAt:new Date(time+86400000).toISOString()}).result;
 return {root,workspace,db,owner,store,home,target,grant,now:()=>time,advance:(ms:number)=>{time+=ms;},close(){owner.close();rmSync(root,{recursive:true,force:true});}};}
type H=ReturnType<typeof fixture>;
function start(h:H){const i=h.store.admitNext()!.invocations[0]!;h.store.startInvocation(i.id);h.store.recordEvidence(i.id,{kind:'accepted',detail:{source:'synthetic-test'}});return i;}
function end(h:H,id:string,status:'succeeded'|'failed'='succeeded',exit=true){if(exit)h.store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});h.store.finish(id,status,'Finished synthetic work');h.store.actions.reconcile();}
function create(h:H,g:CrossGrant,extra:Record<string,unknown>={}){return h.store.actions.create(h.home.id,{requestId:rid(),grantId:g.id,title:'Dedicated action',content:'Explicit delegated work',completion:'human_acceptance',...extra}).result;}
const version=(a:ActionRecord)=>({expectedRevision:a.revision,expectedGeneration:a.generation});
const excerpt=(m:ConversationMessage)=>({messageId:m.id,revision:m.revision??1,digest:textDigest(m.content),start:0,end:m.content.length});
function propose(h:H,a:ActionRecord,id:string){return h.store.actions.candidate(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),summary:'CANDIDATE_RESULT'},id).result.candidate;}

test('N9 cross: exact grant, distinct source and real consumption; ordinary success has no return',()=>{const h=fixture();try{
 const g=h.grant();h.store.send(h.home.id,{requestId:rid(),content:'PRIVATE_NOT_FOR_TARGET',privateTo:['codex']});end(h,start(h).id);
 const cmd={requestId:rid(),grantId:g.id,content:'CROSS_PUBLIC_MARKER'},t=h.store.cross.send(h.home.id,cmd).result;
 assert.equal(h.store.cross.send(h.home.id,cmd).result.id,t.id);const i=start(h);assert.equal(i.conversationId,h.target.id);assert.equal(i.memberId,'claude');assert.match(h.store.prompt(i.id),/CROSS_PUBLIC_MARKER/);assert.equal(h.store.prompt(i.id).includes('PRIVATE_NOT_FOR_TARGET'),false);
 assert.ok(h.store.detail(h.target.id).consumptions.some(c=>c.sourceId===t.sourceId&&c.responseId===i.responseId));end(h,i.id);assert.equal(h.store.admitNext(),undefined);assert.equal(h.store.detail(h.home.id).sources.length,1);
 const reverse=h.store.cross.send(h.target.id,{requestId:rid(),grantId:g.id,content:'Explicit reverse'}).result;assert.equal(reverse.to.memberId,'codex');assert.equal(reverse.to.conversationId,h.home.id);
}finally{h.close();}});

test('N9 cross: caller identity is bound; private calls, ungranted endpoints and forged fields fail',()=>{const h=fixture();try{
 const g=h.grant();h.store.send(h.home.id,{requestId:rid(),content:'private',privateTo:['codex']});const i=start(h);assert.throws(()=>h.store.cross.tool(i.id,'cross_send',{grantId:g.id,content:'PRIVATE'},rid()),/私聊/);end(h,i.id);
 h.store.send(h.home.id,{requestId:rid(),content:'@claude public'});const other=start(h);assert.throws(()=>h.store.cross.tool(other.id,'cross_send',{grantId:g.id,content:'forged'},rid()),/发送端/);assert.deepEqual(h.store.cross.tool(other.id,'cross_routes',{},rid()),{routes:[]});end(h,other.id);
 assert.throws(()=>h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'x',memberId:'codex'}),/未知字段/);
 assert.equal(runtimeTools({toolPolicyVersion:'visibility-memory-v1'}).some(t=>t.name==='action_create'),false);assert.equal(runtimeTools({toolPolicyVersion:'cross-action-v1'}).some(t=>t.name==='action_create'),true);
}finally{h.close();}});

test('N9 cross: public exact refs are resolved at send; deleted/changed/private refs and revoked grants cannot dispatch',()=>{const h=fixture();try{
 const g=h.grant();h.store.send(h.home.id,{requestId:rid(),content:'REFERENCE_MARKER'});end(h,start(h).id);const m=h.store.detail(h.home.id).messages[0]!;
 const t=h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'Read reference',refs:[excerpt(m)]}).result;assert.equal(h.store.artifacts.get<any>('cc_sources',t.sourceId).content.includes('REFERENCE_MARKER'),false);
 const i=h.store.admitNext()!.invocations[0]!;assert.match(h.store.prepareInput(i.id).prompt,/REFERENCE_MARKER/);
 h.store.visibility.messageCommand(h.home.id,m.id,{requestId:rid(),expectedRevision:1,action:'delete'});assert.throws(()=>h.store.startInvocation(i.id));h.store.cross.sweep();assert.equal(h.store.invocation(i.id).status,'cancelled');
 h.store.send(h.home.id,{requestId:rid(),content:'private-ref',privateTo:['codex']});end(h,start(h).id);const privateMessage=h.store.detail(h.home.id).messages.find(x=>x.content==='private-ref')!;
 assert.throws(()=>h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'x',refs:[excerpt(privateMessage)]}),/私聊/);
 const pending=h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'Revoked'}).result;h.store.cross.revoke(g.id,{requestId:rid(),expectedRevision:1});assert.equal(h.store.admitNext(),undefined);assert.ok(h.store.artifacts.get<any>('cc_sources',pending.sourceId).withdrawnAt);
}finally{h.close();}});

test('N9 cross: grants expire and project identity changes invalidate both directions',()=>{const h=fixture();try{
 const g=h.grant();const c=h.store.visibility.conversation(h.target.id);c.workspaceGrant={path:h.workspace,device:1,inode:2,revision:1,authorizedAt:new Date().toISOString(),mode:'read-only'};h.store.visibility.put('cc_conversations',c);assert.throws(()=>h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'x'}),/工作区/);
 delete c.workspaceGrant;h.store.visibility.put('cc_conversations',c);h.advance(86400001);h.store.cross.sweep();assert.equal(h.store.cross.grant(g.id).state,'expired');assert.throws(()=>h.store.cross.send(h.target.id,{requestId:rid(),grantId:g.id,content:'x'}),/过期/);
}finally{h.close();}});

test('N9 cross: default and explicitly authorized directories reject physical replacement and permanently revoke the grant',()=>{
 for(const explicit of [false,true]){const h=fixture();try{
  if(explicit){const c=h.store.visibility.conversation(h.home.id),s=statSync(h.workspace);c.workspaceGrant={path:realpathSync(h.workspace),device:s.dev,inode:s.ino,revision:1,authorizedAt:new Date().toISOString(),mode:'read-only'};h.store.visibility.put('cc_conversations',c);}
  const g=h.grant(),t=h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'PHYSICAL_SCOPE'}).result,epoch=h.store.visibility.epoch();
  renameSync(h.workspace,h.workspace+'-original');mkdirSync(h.workspace);
  assert.throws(()=>h.store.cross.valid(g),/工作区/);assert.throws(()=>h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'denied'}),/工作区/);
  assert.equal(h.store.admitNext(),undefined);assert.equal(h.store.cross.grant(g.id).state,'revoked');assert.ok(h.store.cross.transfers()[0]!.invalidatedAt);assert.ok(h.store.visibility.epoch()>epoch);assert.ok(h.store.artifacts.get<any>('cc_sources',t.sourceId).withdrawnAt);
  const after=h.store.visibility.epoch();h.store.cross.sweep();assert.equal(h.store.visibility.epoch(),after);
  rmSync(h.workspace,{recursive:true});renameSync(h.workspace+'-original',h.workspace);assert.throws(()=>h.store.cross.valid(h.store.cross.grant(g.id)),/撤销/);
 }finally{h.close();}}
});

test('N9 cross: endpoint disable, removal, archive and workspace reauthorization invalidate native context before further dispatch',()=>{
 for(const change of ['disable','remove','archive','workspace'] as const){const h=fixture();try{
  h.store.saveMember({...h.store.members().find(m=>m.id==='claude')!,model:'fixture-model'});
  const g=h.grant();h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'OLD_CROSS_CONTEXT'});
  const i=h.store.admitNext()!.invocations[0]!,identity={supported:true,fingerprint:'same-runtime',version:'fixture',reason:'fixture'};
  h.store.prepareSession(i.id,identity);h.store.startInvocation(i.id);h.store.recordEvidence(i.id,{kind:'session',detail:{nativeSessionId:'fixture-session',continuity:'fresh',anchor:'fixture-anchor',historyVerified:true}});h.store.recordEvidence(i.id,{kind:'accepted',detail:{source:'synthetic'}});end(h,i.id);
  const epoch=h.store.visibility.epoch();
  if(change==='disable'){const m=h.store.members().find(m=>m.id==='codex')!;h.store.saveMember({...m,enabled:false});h.store.saveMember({...m,enabled:true});}
  if(change==='remove')h.store.updateConversation(h.home.id,{memberIds:['claude'],defaultMemberId:'claude'});
  if(change==='archive')h.store.workbench.organize(h.home.id,{requestId:rid(),expectedRevision:1,action:'archive'});
  if(change==='workspace'){const next=join(h.root,'next-project');mkdirSync(next);const p=h.store.workbench.previewWorkspace(h.home.id,{path:next});h.store.workbench.applyPreview({requestId:rid(),previewId:p.id},h.home.id);}
  assert.equal(h.store.cross.grant(g.id).state,'revoked');assert.ok(h.store.visibility.epoch()>epoch);
  h.store.send(h.target.id,{requestId:rid(),content:'@claude continue'});const next=h.store.admitNext()!.invocations[0]!;
  assert.equal(h.store.prepareSession(next.id,identity).mode,'replace');assert.equal(h.store.prepareInput(next.id).prompt.includes('OLD_CROSS_CONTEXT'),false);
 }finally{h.close();}}
});

test('N9 cross: withdrawing original caller work invalidates delivered context once while the grant remains valid',()=>{const h=fixture();try{
 const g=h.grant();h.store.send(h.home.id,{requestId:rid(),content:'original caller'});const origin=start(h);
 const t=h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'CHILD_CONTEXT'},origin.id).result;end(h,origin.id);end(h,start(h).id);
 const epoch=h.store.visibility.epoch(),s=h.store.visibility.primary(origin.id);h.store.cooperation.withdraw(s.id,{requestId:rid(),expectedRevision:s.revision});h.store.cross.sweep();
 assert.equal(h.store.cross.grant(g.id).state,'active');assert.ok(h.store.cross.transfers().find(x=>x.id===t.id)!.invalidatedAt);assert.ok(h.store.visibility.epoch()>epoch);assert.equal(h.store.visibility.readable(h.target.id,'claude').some(m=>m.content.includes('CHILD_CONTEXT')),false);
 const after=h.store.visibility.epoch();h.store.cross.sweep();assert.equal(h.store.visibility.epoch(),after);
}finally{h.close();}});

test('N9 action: candidate is separate from success and human authority; exact confirmed exit gates completion',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h),c=propose(h,a,i.id);const cmd={requestId:rid(),...version(h.store.actions.get(a.id)),operation:'verify',candidateId:c.id};assert.throws(()=>h.store.actions.command(a.id,cmd),/退出证据/);
 end(h,i.id,'succeeded',false);assert.equal(h.store.actions.get(a.id).state,'candidate');assert.throws(()=>h.store.actions.command(a.id,{...cmd,...version(h.store.actions.get(a.id))}),/退出证据/);
 h.store.recordEvidence(i.id,{kind:'process_exit',detail:{confirmed:true}});h.store.actions.reconcile();const accept={...cmd,...version(h.store.actions.get(a.id))};h.store.actions.command(a.id,accept);assert.equal(h.store.actions.get(a.id).state,'completed');assert.equal(h.store.actions.command(a.id,accept).replayed,true);assert.equal(h.store.artifacts.rows('cc_action_verdicts').length,1);
}finally{h.close();}});

test('N9 action: plain model success never completes an action; retry fences the old generation',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h);end(h,i.id);assert.equal(h.store.actions.get(a.id).state,'replaceable');
 const cmd={requestId:rid(),...version(h.store.actions.get(a.id)),operation:'retry',reason:'Explicit new attempt'};h.store.actions.command(a.id,cmd);assert.equal(h.store.actions.get(a.id).generation,2);assert.throws(()=>propose(h,a,i.id));
 const second=start(h);assert.notEqual(second.id,i.id);assert.equal(h.store.actions.command(a.id,cmd).replayed,true);assert.throws(()=>h.store.actions.command(a.id,{...cmd,requestId:rid()}),/代次/);end(h,second.id);
}finally{h.close();}});

test('N9 action: return waits for teardown, changes holder/generation once and has actual return delivery',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h);h.store.actions.command(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),operation:'return',reason:'Wrong responsibility'},i.id);assert.equal(h.store.actions.get(a.id).holder.memberId,'claude');
 end(h,i.id,'succeeded',false);assert.equal(h.store.actions.get(a.id).generation,1);assert.equal(h.store.admitNext(),undefined);
 h.store.recordEvidence(i.id,{kind:'process_exit',detail:{confirmed:true}});h.store.actions.reconcile();const returned=h.store.actions.get(a.id);assert.equal(returned.generation,2);assert.equal(returned.holder.memberId,'codex');assert.equal(returned.state,'queued');
 h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).currentSourceId,returned.currentSourceId);const second=start(h);assert.equal(second.conversationId,h.home.id);assert.ok(h.store.detail(h.home.id).consumptions.some(c=>c.sourceId===returned.currentSourceId));end(h,second.id);
}finally{h.close();}});

test('N9 task delegation: home owner stays, original run releases first, target candidate requires human task completion',()=>{const h=fixture();try{
 const g=h.grant(),t=h.store.tasks.create(h.home.id,{requestId:rid(),title:'Home task',description:'Delegate implementation',ownerMemberId:'codex'}).task,i=start(h),latest=h.store.tasks.getTask(t.id);
 const a=create(h,g,{taskId:t.id,expectedTaskRevision:latest.revision,expectedOwnerRevision:latest.ownerRevision});assert.equal(a.state,'preparing');assert.equal(h.store.tasks.getTask(t.id).ownerMemberId,'codex');assert.equal(h.store.admitNext(),undefined);
 assert.throws(()=>h.store.tasks.update(t.id,{requestId:rid(),expectedRevision:h.store.tasks.getTask(t.id).revision,expectedOwnerRevision:latest.ownerRevision,status:'done'}),/委托/);
 end(h,i.id);const target=start(h);assert.equal(target.memberId,'claude');assert.equal(h.store.tasks.getTask(t.id).ownerMemberId,'codex');const c=propose(h,a,target.id);end(h,target.id);assert.notEqual(h.store.tasks.getTask(t.id).status,'done');h.store.actions.command(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),operation:'verify',candidateId:c.id});assert.equal(h.store.tasks.getTask(t.id).status,'done');assert.equal(h.store.tasks.getTask(t.id).ownerRevision,latest.ownerRevision);
}finally{h.close();}});

test('N9 condition: signal evidence waits for exact exit and cooldown; repeats produce one wake',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h);const w=h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition:{kind:'signal',name:'review-ready'},deadline:new Date(h.now()+60000).toISOString(),cooldownMs:1000},i.id).result.wait;
 const signal={requestId:rid(),operation:'signal',expectedRevision:w.revision,episode:w.episode,name:'review-ready',eventId:'external-1'};h.store.actions.conditionCommand(w.id,signal);h.store.actions.conditionCommand(w.id,signal);h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).generation,1);assert.equal(h.store.actions.waits()[0]!.state,'ready');
 assert.throws(()=>h.store.actions.tool(i.id,'action_candidate',{actionId:a.id,...version(h.store.actions.get(a.id)),summary:'late'},rid()));end(h,i.id);assert.equal(h.store.actions.get(a.id).generation,1);h.advance(1001);h.store.actions.reconcile();const awakened=h.store.actions.get(a.id);assert.equal(awakened.generation,2);const source=awakened.currentSourceId;h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).currentSourceId,source);assert.equal(h.store.artifacts.rows('cc_condition_evidence').length,1);assert.equal(h.store.actions.waits()[0]!.state,'fired');assert.equal(h.store.actions.conditionCommand(w.id,signal).replayed,true);end(h,start(h).id);
}finally{h.close();}});

test('N9 condition: cancellation and expiry never wake; unrelated signals cannot satisfy a wait',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h),w=h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition:{kind:'signal',name:'expected'},deadline:new Date(h.now()+1000).toISOString()},i.id).result.wait;
 assert.throws(()=>h.store.actions.conditionCommand(w.id,{requestId:rid(),operation:'signal',expectedRevision:1,episode:1,name:'wrong',eventId:rid()}),/信号/);end(h,i.id);h.advance(1001);h.store.actions.reconcile();assert.equal(h.store.actions.waits()[0]!.state,'expired');assert.equal(h.store.actions.get(a.id).generation,1);assert.equal(h.store.admitNext(),undefined);
 h.store.actions.command(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),operation:'retry',reason:'retry'});const second=start(h),w2=h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition:{kind:'timer',at:new Date(h.now()+100).toISOString()},deadline:new Date(h.now()+1000).toISOString()},second.id).result.wait;
 h.store.actions.conditionCommand(w2.id,{requestId:rid(),operation:'cancel',expectedRevision:1,episode:2});end(h,second.id);h.advance(500);h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).generation,2);assert.equal(h.store.admitNext(),undefined);
}finally{h.close();}});

test('N9 condition: restart preserves episode and one wake; no lost memory timer or replayed source',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h);h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition:{kind:'timer',at:new Date(h.now()+100).toISOString()},deadline:new Date(h.now()+60000).toISOString()},i.id);end(h,i.id);h.owner.close();h.advance(101);
 const owner=new Store(h.db);try{const s=new CollaborationStore(owner,{workspace:h.workspace,artifactDir:join(h.root,'private','artifacts'),clock:h.now});s.actions.reconcile();assert.equal(s.actions.get(a.id).generation,2);const id=s.actions.get(a.id).currentSourceId;s.actions.reconcile();assert.equal(s.actions.get(a.id).currentSourceId,id);assert.equal(s.actions.waits()[0]!.state,'fired');}finally{owner.close();}
}finally{rmSync(h.root,{recursive:true,force:true});}});

test('N9 action: grant withdrawal cancels pending work and blocks candidates while unknown execution remains occupied',()=>{const h=fixture();try{
 const g=h.grant(),a=create(h,g),i=start(h);h.store.cross.revoke(g.id,{requestId:rid(),expectedRevision:1});h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).state,'blocked');assert.equal(h.store.invocation(i.id).status,'cancel_requested');assert.throws(()=>propose(h,a,i.id));assert.equal(h.store.actions.get(a.id).executionId,i.id);assert.equal(h.store.admitNext(),undefined);
}finally{h.close();}});

test('N9 action: verdict and delegated task completion roll back together on storage failure',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h),c=propose(h,a,i.id);end(h,i.id);h.owner.db.exec("CREATE TRIGGER fail_verdict BEFORE UPDATE ON cc_actions BEGIN SELECT RAISE(ABORT,'injected'); END");
 const cmd={requestId:rid(),...version(h.store.actions.get(a.id)),operation:'verify',candidateId:c.id};assert.throws(()=>h.store.actions.command(a.id,cmd),/injected/);assert.equal(h.store.artifacts.rows('cc_action_verdicts').length,0);assert.equal(h.store.actions.get(a.id).state,'candidate');h.owner.db.exec('DROP TRIGGER fail_verdict');h.store.actions.command(a.id,cmd);assert.equal(h.store.actions.get(a.id).state,'completed');
}finally{h.close();}});

test('N9 cross: reference drift without revision update cannot reuse a frozen payload',()=>{const h=fixture();try{const g=h.grant();h.store.send(h.home.id,{requestId:rid(),content:'ORIGINAL'});end(h,start(h).id);const m=h.store.detail(h.home.id).messages[0]!;h.store.cross.send(h.home.id,{requestId:rid(),grantId:g.id,content:'ref',refs:[excerpt(m)]});const i=h.store.admitNext()!.invocations[0]!;h.store.prepareInput(i.id);h.store.visibility.put('cc_messages',{...m,content:'DRIFT'});assert.throws(()=>h.store.startInvocation(i.id));assert.equal(h.store.invocation(i.id).dispatchStarted,false);}finally{h.close();}});

test('N9 action: artifact candidate requires actual published bytes and exact version; approval is insufficient',()=>{const h=fixture();try{
 const a=create(h,h.grant(),{completion:'artifact_published'}),i=start(h),p=h.store.artifacts.propose(h.target.id,{requestId:rid(),name:'result.txt',content:'EXACT_ARTIFACT'},i.id);
 const c=h.store.actions.candidate(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),summary:'Artifact ready',artifactVersionId:p.version.id,artifactDigest:p.version.digest},i.id).result.candidate;end(h,i.id);
 const verify={requestId:rid(),...version(h.store.actions.get(a.id)),operation:'verify',candidateId:c.id};assert.throws(()=>h.store.actions.command(a.id,verify));h.store.artifacts.decide(p.approval.id,{requestId:rid(),expectedRevision:p.approval.revision,operationDigest:p.approval.operationDigest,decision:'approve'});assert.throws(()=>h.store.actions.command(a.id,verify));h.store.artifacts.processJobs();h.store.actions.command(a.id,verify);assert.equal(h.store.actions.get(a.id).state,'completed');assert.equal(h.store.artifacts.rows<any>('cc_action_verdicts')[0]!.evidence.versionId,p.version.id);
}finally{h.close();}});

test('N9 condition: managed job and artifact signals use actual receipts, not a client success flag',()=>{
 for(const kind of ['job_succeeded','artifact_published'] as const){const h=fixture();try{
  const a=create(h,h.grant()),i=start(h),p=h.store.artifacts.propose(h.target.id,{requestId:rid(),name:'waiting.txt',content:'WAIT_JOB'});
  h.store.artifacts.decide(p.approval.id,{requestId:rid(),expectedRevision:p.approval.revision,operationDigest:p.approval.operationDigest,decision:'approve'});
  const job=h.store.artifacts.detail(h.target.id).jobs[0]!;
  const condition=kind==='job_succeeded'?{kind,jobId:job.id}:{kind,versionId:p.version.id,digest:p.version.digest};
  const w=h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition,deadline:new Date(h.now()+60000).toISOString()},i.id).result.wait;end(h,i.id);assert.equal(h.store.actions.waits()[0]!.state,'waiting');
  assert.throws(()=>h.store.actions.conditionCommand(w.id,{requestId:rid(),expectedRevision:1,episode:1,operation:'signal',eventId:rid(),name:'success'}));h.store.artifacts.processJobs();h.store.actions.reconcile();assert.equal(h.store.actions.waits()[0]!.state,'fired');assert.equal(h.store.artifacts.rows<any>('cc_condition_evidence')[0]!.authority,kind==='job_succeeded'?'managed_job':'artifact_receipt');assert.equal(h.store.actions.get(a.id).generation,2);
 }finally{h.close();}}
});

test('N9 condition: wake source and evidence transaction roll back, explicit re-scan creates just one successor',()=>{const h=fixture();try{
 const a=create(h,h.grant()),i=start(h);h.store.actions.wait(a.id,{requestId:rid(),...version(h.store.actions.get(a.id)),condition:{kind:'timer',at:new Date(h.now()+100).toISOString()},deadline:new Date(h.now()+60000).toISOString()},i.id);end(h,i.id);h.advance(101);h.owner.db.exec("CREATE TRIGGER fail_wake BEFORE INSERT ON cc_sources BEGIN SELECT RAISE(ABORT,'wake-fault'); END");assert.throws(()=>h.store.actions.reconcile(),/wake-fault/);assert.equal(h.store.actions.get(a.id).generation,1);assert.equal(h.store.actions.waits()[0]!.state,'waiting');assert.equal(h.store.artifacts.rows('cc_condition_evidence').length,0);h.owner.db.exec('DROP TRIGGER fail_wake');h.store.actions.reconcile();h.store.actions.reconcile();assert.equal(h.store.actions.get(a.id).generation,2);assert.equal(h.store.artifacts.rows('cc_condition_evidence').length,1);
}finally{h.close();}});

test('N9 migration: schema 8 rows and accepted contracts survive, no historical cross authorization is invented',()=>{const h=fixture();try{
 h.store.send(h.home.id,{requestId:rid(),content:'preserved'});end(h,start(h).id);const tables=['cc_accounts','cc_members','cc_sources','cc_messages','cc_contracts','cc_conversations'],before=tables.map(t=>h.owner.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());h.owner.db.exec('UPDATE cc_schema SET version=8');h.owner.close();const owner=new Store(h.db);try{const s=new CollaborationStore(owner,{workspace:h.workspace,artifactDir:join(h.root,'private','artifacts')});tables.forEach((t,n)=>assert.deepEqual(owner.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),before[n]));assert.equal((owner.db.prepare('SELECT version FROM cc_schema').get() as any).version,9);assert.equal(s.cross.grants().length,0);assert.equal(s.actions.list().length,0);}finally{owner.close();}
}finally{rmSync(h.root,{recursive:true,force:true});}});
