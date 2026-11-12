// Development evidence for scenario 08. Node 24 --import tsx, isolated data, max two paid calls.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedClaude } from './hydra-test-native.mjs';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const args = process.argv.slice(2);
assert(args.length===0 || (args.length===1 && args[0]==='--revoke-before-dispatch'));
const revokeBeforeDispatch = args.length===1;
const output=process.env.VALIDATION_OUTPUT_DIR || tmpdir();await mkdir(output,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(output,'hydra-disclosure-')),workspace=join(dir,'workspace'),profile=join(dir,'cli'),dataDir=join(dir,'service');
await mkdir(workspace,{mode:0o700});await mkdir(profile,{mode:0o700});
const digest=value=>createHash('sha256').update(value).digest('hex');
const marker=randomUUID().slice(0,8),email=marker+'@example.invalid',order='ORDER-'+marker;
const excerpt='资料 '+marker+'。现象：列表把 12 排在 2 前。解决步骤：按编号的数值排序。请用一句话写成帮助说明。';
const content='此为合成客服报告，请确认收到即可。用户 '+email+'，工单 '+order+'。'+excerpt;
const result={case:revokeBeforeDispatch?'08 / revoked before delivery':'08 / approved excerpts',cap:2,calls:[]};
let app,url,home,target,origin;
async function post(path,body) {
  const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
  assert(res.ok,'HTTP '+res.status+' '+path);return res.json();
}
async function settled(cid) {
  const end=Date.now()+150000;
  while(Date.now()<end) {
    const runs=app.collaborationStore.invocations(cid);assert(runs.length<=1);
    const run=runs[0];if(run && ['succeeded','cancelled','interrupted','failed'].includes(run.status)){
      assert.equal(run.status,'succeeded');assert.equal(run.acceptance,'accepted');assert.equal(run.teardown,'confirmed');assert(run.roomMember && run.nativeSessionId);return run;
    }await delay(150);
  }throw Error('Native invocation did not finish');
}
try {
  const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
  const native=createCollaborationRuntime({timeoutMs:90000,privateRoots:[dataDir]});
  const options={workspace,dataDir,port:0,collaborationRuntime:{...native,async invoke(req){
    assert(result.calls.length<result.cap);assert.equal(req.cwd,workspace);
    const entry={id:req.invocationId,room:req.conversationId,inputSha256:digest(req.prompt),tools:[]};result.calls.push(entry);
    if(req.conversationId===target){
      assert.equal(req.prompt.includes(excerpt),!revokeBeforeDispatch);
      for(const v of [email,order,origin.id,digest(content),...(revokeBeforeDispatch?[marker]:[])])
        assert(!req.prompt.includes(v),'Unauthorized source data in recipient input');
      entry.approvedOnly=!revokeBeforeDispatch;
    }
    return native.invoke({...req,async onToolCall(name,args,id){entry.tools.push(name);return req.onToolCall(name,args,id);}});
  }}};
  app=await createApplication(options);
  let s=app.collaborationStore;s.saveAccount(account);
  s.saveMember({id:'writer',name:'阿岚',carrier:selected.carrier,model:selected.model,accountId:account.id,modelBinding:'override',accountBinding:'override',enabled:true,instructions:'根据获准看见的资料回应房间里的请求。'});
  ({url}=await app.start());assert.notEqual(new URL(url).port,'4310');
  async function room(title){return (await post('/api/conversations',{title,memberIds:['writer'],defaultMemberId:'writer'})).conversation.id;}
  home=await room('客服');target=await room('帮助文档');
  await post('/api/conversations/'+home+'/messages',{content});const first=await settled(home);
  origin=s.detail(home).messages.find(m=>m.content===content);assert(origin);
  const cmd={requestId:randomUUID(),homeMemberId:'writer',targetConversationId:target,targetMemberId:'writer',refs:[{messageId:origin.id,revision:origin.revision??1,digest:digest(content),start:content.indexOf(excerpt),end:content.length}]};
  const path='/api/conversations/'+home+'/share-excerpts';
  // Hold only the worker at the specified fault boundary. HTTP authorization and
  // the durable queue remain live until the service is restarted.
  if(revokeBeforeDispatch)await app.collaborationEngine.stop();
  const receipt=(await post(path,cmd)).result;assert.deepEqual((await post(path,cmd)).result,receipt);
  if(revokeBeforeDispatch) {
    const transfer=s.cross.transfers().find(t=>t.id===receipt.transferId);
    assert(transfer?.sourceId && !s.invocations(target).length);
    assert(s.detail(target).deliveries.some(d=>d.sourceId===transfer.sourceId && d.status==='pending'));
    await post('/api/cross-grants/'+receipt.grantId+'/revoke',{expectedRevision:1});
    await app.close();
    app=await createApplication(options);s=app.collaborationStore;
    ({url}=await app.start());
    assert.equal(s.invocations(target).length,0,'Revoked source was admitted on restart');
    assert(!s.detail(target).deliveries.some(d=>d.sourceId===transfer.sourceId && d.status==='pending'));
    for(const endpoint of ['/api/conversations/'+target+'?viewer=writer','/api/conversations/'+target+'/export?viewer=writer']){
      const response=await fetch(url+endpoint);assert(response.ok);
      const view=JSON.stringify(await response.json());
      for(const v of [marker,origin.id,digest(content)])assert(!view.includes(v),'Revoked material leaked via '+endpoint);
    }
    const hits=await s.memory.search({query:marker,conversationId:target,memberId:'writer',mode:'lexical'});
    assert.equal(hits.hits.length,0);
    // An independent ordinary query probes the recipient's real input. It does not
    // continue the revoked delivery and it contains none of the protected text.
    const probe=await post('/api/conversations/'+target+'/messages',{content:'请核对你目前能读取的资料，本房收到客服提供的具体解决步骤了吗？缺少原文就直接说明。'});
    result.revocation={withdrawnSource:transfer.sourceId,probeSource:probe.source.id,searchHits:0};
  }
  const second=await settled(target);assert.notEqual(first.nativeSessionId,second.nativeSessionId);assert.notEqual(first.roomMember.id,second.roomMember.id);
  const detail=s.detail(target);const answer=detail.messages.find(m=>m.author==='member');
  assert(answer && (revokeBeforeDispatch ? /没|未|缺|无法|没有|找不到/.test(answer.content) : /排序|数值|数字/.test(answer.content)));
  for(const v of [email,order,origin.id,...(revokeBeforeDispatch?[marker]:[])])assert(!answer.content.includes(v));
  if(revokeBeforeDispatch)assert(!detail.consumptions.some(c=>c.sourceId===result.revocation.withdrawnSource));
  assert.equal(detail.invocations.length,1);assert.equal(s.cross.transfers().length,1);
  const visible=s.factors.list(target,s.roomMembers.resolve(target,'writer'));
  const allowed=new Set(visible.map(f=>f.id));
  assert(visible.length>0 && visible.every(f=>f.roomId===target && f.parentIds.every(id=>allowed.has(id))));
  const serialized=JSON.stringify(visible);
  for(const hidden of [email,order,origin.id,digest(content),...s.factors.list(home).map(f=>f.id)])assert(!serialized.includes(hidden));
  const transfer=s.cross.transfers()[0];
  if(revokeBeforeDispatch) {
    assert(!visible.some(f=>f.sourceRef.id===transfer.sourceId),'Revoked foreign material still has a target receipt');
  } else {
    const received=visible.find(f=>f.kind==='request' && f.sourceRef.kind==='source' && f.sourceRef.id===transfer.sourceId);
    const delivered=visible.find(f=>f.kind==='message' && f.sourceRef.kind==='message' && f.sourceRef.id===answer.id);
    assert(received && delivered,'Missing a scoped receipt for this transfer or its actual reply');
    assert.deepEqual(received.parentIds,[]);assert.deepEqual(delivered.parentIds,[received.id]);
    assert(!s.factors.list(target).some(f=>f.id===received.id || f.id===delivered.id));
    await post('/api/cross-grants/'+receipt.grantId+'/revoke',{expectedRevision:1});
    const after=s.factors.list(target,s.roomMembers.resolve(target,'writer'));
    assert(!after.some(f=>f.id===received.id || f.id===delivered.id),'Target can read a withdrawn receipt');
    assert.equal(s.detail(target).messages.find(m=>m.id===answer.id)?.content,answer.content,'Persisted historical delivery was rewritten');
    result.afterDeliveryRevocation={targetSourceId:transfer.sourceId,answerId:answer.id,removedFromProjection:true};
  }
  result.visibleFactorEdges=visible.map(f=>({id:f.id,parents:f.parentIds}));

  Object.assign(result,{passed:true,home,target,receipt,consumptions:detail.consumptions.map(({id,sourceId,responseId})=>({id,sourceId,responseId})),answer:answer.content,instances:[first.roomMember.id,second.roomMember.id]});
} catch(e){result.passed=false;result.error=String(e.message).slice(0,300);process.exitCode=1;}
finally{if(app)await app.close();const path=join(dir,'result.json');await writeFile(path,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({passed:result.passed,path,error:result.error}));}
