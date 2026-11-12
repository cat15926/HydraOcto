// Node 24 --import tsx. Each invocation runs one isolated native scenario.
// Only the requested venue change is injected, through the ordinary operator HTTP command.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';
import { isolatedClaude } from './hydra-test-native.mjs';

const scenario = process.argv[2];
assert(['opinions','objection','materials','relocation'].includes(scenario), 'Choose opinions, objection, materials or relocation');
const opinions = ['opinions','objection'].includes(scenario);
const maxCalls = opinions ? 8 : 5;
const turnTimeoutMs = opinions ? 180000 : 360000;
const output = process.env.VALIDATION_OUTPUT_DIR || tmpdir();
await mkdir(output, {recursive:true,mode:0o700});
const folder = await mkdtemp(join(output,'hydra-'+scenario+'-'));
const profile=join(folder,'cli'), workspace=join(folder,'workspace'), dataDir=join(folder,'service');
await Promise.all([mkdir(profile,{mode:0o700}),mkdir(workspace,{mode:0o700})]);
const token=randomUUID().slice(0,6), venue='秋枫厅'+token, revisedVenue='海棠厅'+token;
const evidence = {scenario,maxCalls,token,calls:[],venueChanges:0};
let app,url,cid,before,afterChange;
async function post(path,body) {
  const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},
    body:JSON.stringify({requestId:randomUUID(),...body})});
  const value=await response.json();
  assert(response.ok, path+' '+response.status+' '+String(value.error||''));
  return value;
}
async function detail() {
  const response=await fetch(url+'/api/conversations/'+cid);
  assert(response.ok); return response.json();
}
async function moveVenueIfReady() {
  if(scenario!=='relocation'||before)return;
  const pkg=(await detail()).versionPackages?.[0];
  if(!pkg || pkg.parts.length!==3 || !pkg.parts.every(p=>p.state==='accepted'))return;
  const location=pkg.materials.find(m=>m.content.includes(venue)); assert(location,'Missing immutable original venue');
  before=pkg;
  await post('/api/conversations/'+cid+'/version-packages/'+pkg.id+'/change',{expectedRevision:pkg.revision,expectedMaterialVersionId:location.versionId,key:location.key,content:revisedVenue});
  evidence.venueChanges++;
  afterChange=(await detail()).versionPackages[0];
}
function assess(d) {
  const root=d.obligations.find(o=>!o.parentId);
  assert.equal(root?.state,'delivered','The original commitment was not delivered');
  const answer=d.messages.find(m=>m.id===root.delivery?.messageId);
  assert(answer && answer.memberId===root.owner.memberId && answer.content.includes(token),'Missing owner delivery for the requested object');
  assert.equal(d.messages.filter(m=>m.author==='user').length,1);
  assert(d.invocations.every(i=>i.acceptance==='accepted' && i.teardown==='confirmed' && i.nativeSessionId));
  Object.assign(evidence,{root:root.id,final:answer.id,answer:answer.content,runs:d.invocations.map(i=>({id:i.id,instance:i.roomMember?.id,status:i.status,teardown:i.teardown}))});
  if(opinions) {
    const [round]=d.opinionRounds;
    assert(round?.obligationId===root.id && round.minimum===2 && round.participants.length===3 && round.state==='locked');
    const locked=round.opinions.filter(o=>round.lockedOpinionIds.includes(o.id));
    assert(new Set(locked.map(o=>o.instanceId)).size>=2 && round.wakeSourceId);
    const objections=round.objectionIds??[];
    if(scenario==='objection') {
      assert(objections.length>0,'Expected signed objection');
      assert(objections.every(id=>round.resolutions.some(r=>r.opinionId===id && d.messages.some(m=>m.id===r.evidenceMessageId))));
    } else assert.equal(objections.length,0);
    evidence.round=round;
  } else {
    const [pkg]=d.versionPackages;
    assert(pkg?.edition && pkg.obligationId===root.id && pkg.parts.length===3);
    assert(pkg.parts.every(p=>p.state==='accepted' && pkg.edition.parts.some(item=>item.key===p.key && item.versionId===p.versionId && item.reviewId===p.evidenceId)));
    const finalVenue=scenario==='relocation' ? revisedVenue : venue;
    const location=pkg.materials.find(m=>m.content===finalVenue);
    assert(location?.versionId,'Expected the requested venue as a readable immutable input');
    const usesVenue=pkg.parts.filter(p=>p.basis?.some(b=>b.key===location.key && b.versionId===location.versionId));
    assert.equal(usesVenue.length,2,'Both the notice and the route must cite the exact venue version they use');
    assert(usesVenue.every(p=>p.content.includes(finalVenue)),'The two submitted texts must also contain the current venue');
    const standalone=pkg.parts.filter(p=>p.dependsOn?.length===0 && p.basis?.length===0);
    assert.equal(standalone.length,1,'Only the guest biography was requested as independent of the venue');
    assert(standalone[0].content.includes('青林') && standalone[0].content.includes('摄影师'));
    if(scenario==='relocation') {
      assert.equal(evidence.venueChanges,1); assert(afterChange);
      const changed=before.parts.filter(p=>p.dependsOn?.length),independent=before.parts.filter(p=>p.dependsOn?.length===0);
      assert.equal(changed.length,2);assert.equal(independent.length,1);
      for(const old of changed) {
        const part=pkg.parts.find(p=>p.key===old.key);
        assert.equal(afterChange.parts.find(p=>p.key===old.key)?.state,'needs_review');
        assert(part.versionId!==old.versionId && part.evidenceId!==old.evidenceId);
        assert(part.content.includes(revisedVenue) && !part.content.includes(venue));
      }
      const kept=independent[0],final=pkg.parts.find(p=>p.key===kept.key);
      assert(final.versionId===kept.versionId && final.evidenceId===kept.evidenceId);
      Object.assign(evidence,{before,afterChange});
    }
    evidence.package=pkg;
  }
}
try {
  const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
  const native=createCollaborationRuntime({timeoutMs:turnTimeoutMs,privateRoots:[dataDir]});
  app=await createApplication({dataDir,workspace,port:0,collaborationRuntime:{...native,async invoke(request) {
    assert(evidence.calls.length<maxCalls,'Native call budget reached');
    assert.equal(request.cwd,workspace);assert(!request.projectWork && !request.gitDelivery);
    const call={id:request.invocationId,member:request.member.id,tools:[]};evidence.calls.push(call);
    return native.invoke({...request,async onToolCall(name,args,id) {
      const event={name};call.tools.push(event);
      try {
        const result=await request.onToolCall(name,args,id);event.ok=true;
        if(name==='package_review')await moveVenueIfReady();
        return result;
      }catch(e){event.error=String(e.message).slice(0,180);throw e;}
    }});
  }}});
  const store=app.collaborationStore;store.saveAccount(account);
  const roster=opinions?[['lead','顾宁','负责策展决定和向用户交付。'],['print','林青','独立评审印制授权。'],['art','周平','独立评审设计和印刷可行性。'],['editor','沈晗','独立评审编辑和印刷用途。']]:[['lead','顾宁','编辑并核对活动资料包。']];
  for(const [id,name,instructions] of roster)store.saveMember({id,name,instructions,carrier:selected.carrier,model:selected.model,accountId:account.id,modelBinding:'override',accountBinding:'override',enabled:true});
  ({url}=await app.start());assert.notEqual(new URL(url).port,'4310');
  cid=(await post('/api/conversations',{title:scenario+' '+token,memberIds:roster.map(([id])=>id),defaultMemberId:'lead'})).conversation.id;
  const license=scenario==='objection'?'第一条征件登记写着“网络展示”。三位评审都应把印刷用途的限制登记为署名异议，由策展人逐条核查。原始补充记录编号 '+token+' 明确：作者只准在线展示，不准印刷。请以这条公开材料为核查凭据。':'作者授权记录 '+token+' 明确许可本次纸质展签印刷，尺寸和校样都已通过。';
  const until=new Date(Date.now()+20*60_000).toISOString();
  const content=opinions
    ? '@顾宁 请决定作品《松径'+token+'》是否可以印作展签。请向林青、周平、沈晗三位征询署名意见，两位不同评审提交后你就可以锁定采用的意见版本。最迟'+until+'。如有任何署名异议，先按公开证据核查，再由你作决定并回复我，交付注明作品编号。'+license
    : '@顾宁 请制作并交付活动 '+token+' 的资料包。唯一可能变动的资料是地点“'+venue+'”。登记活动资料包和不可变的资料依据，分别完成、验收三个分项：通知文案和路线说明必须写明所依据的地点，嘉宾简介只写“青林，摄影师”，与地点无关。你负责编辑和逐项校对，可以独立完成。汇编时只使用对当前地点有效的已核对版本。回复我活动编号、地点和三个分项。';
  evidence.request=(await post('/api/conversations/'+cid+'/messages',{content})).source.id;
  const deadline=Date.now()+maxCalls*turnTimeoutMs;
  while(Date.now()<deadline){
    const d=await detail(), roots=d.obligations.filter(o=>!o.parentId);
    assert(!d.invocations.some(i=>['failed','interrupted','cancelled'].includes(i.status)),'Unsuccessful native execution');
    if(d.invocations.length && d.invocations.every(i=>i.status==='succeeded') && !d.deliveries.some(v=>v.status==='pending')){
      assert(roots.length===1);assess(d);evidence.passed=true;break;
    }
    await delay(400);
  }
  assert(evidence.passed,'Timeout waiting for delivery');
} catch(e){evidence.error=String(e.message).slice(0,420);process.exitCode=1;}
finally {
  if(cid && app) {
    const d=await detail().catch(()=>undefined);
    if(d) Object.assign(evidence,{room:cid,roots:d.obligations,sources:d.sources.map(({id,kind,requestedTargets})=>({id,kind,requestedTargets})),consumptions:d.consumptions,rounds:d.opinionRounds,packages:d.versionPackages});
  }
  if(app)await app.close();
  const path=join(folder,'result.json');await writeFile(path,JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify({scenario,passed:!!evidence.passed,calls:evidence.calls.length,path,error:evidence.error}));
}
