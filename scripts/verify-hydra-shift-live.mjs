// Node 24 --import tsx scripts/verify-hydra-shift-live.mjs [--decline-first]
// One ordinary user message. The server and the real members produce every subsequent source.
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedClaude } from './hydra-test-native.mjs';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const rejectFirst = process.argv.includes('--decline-first'), maxCalls = rejectFirst ? 5 : 3;
const base = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation');
await mkdir(base,{recursive:true,mode:0o700});
const dir = await mkdtemp(join(base,'hydra-shift-')), profile = join(dir,'native'), workspace = join(dir,'workspace'), dataDir=join(dir,'service');
await mkdir(profile,{mode:0o700}); await mkdir(workspace,{mode:0o700});
const proof = { accepted: false, rejectFirst, maxCalls, calls:[], submittedUserSources:[] };
let app, store, cid;
try {
  const {selected,account} = await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT || '.'),profile);
  const native = createCollaborationRuntime({timeoutMs:180000,privateRoots:[dataDir]});
  app = await createApplication({dataDir,workspace,port:0,collaborationRuntime:{...native,async invoke(req) {
    assert(proof.calls.length < maxCalls,'Carrier call limit');
    assert.equal(req.cwd,workspace); assert(!req.projectWork && !req.webResearch);
    const c={id:req.invocationId,member:req.member.id,tools:[]}; proof.calls.push(c);
    return native.invoke({...req,async onToolCall(name,args,id){
      const result = await req.onToolCall(name,args,id); c.tools.push(name); return result;
    }});
  }}});
  const {url} = await app.start(); assert.notEqual(new URL(url).port,'4310');
  async function post(path,body) {
    const resp=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
    assert(resp.ok,path+' HTTP '+resp.status);return resp.json();
  }
  store=app.collaborationStore;store.saveAccount(account);
  const members=[
    ['morning','阿岚','早班客服。你的班次已结束，不能代晚班完成核账，需把尚未了结的整项责任正式交班；首选当日排班中的向宁。若首选无法接手，改找文昭。'],
    ['evening','向宁',rejectFirst?'晚班客服，本日请假，收到交班邀请应明确拒绝，说明缘由。':'晚班客服，本日值班，可以接手整项核账并对用户交付。'],
    ['standby','文昭','后备晚班客服，可以接手整项核账并对用户交付。'],
  ];
  for (const [id,name,instructions] of members) store.saveMember({id,name,instructions,carrier:'claude-cli',accountId:account.id,accountBinding:'override',modelBinding:'override',model:selected.model,enabled:true});
  proof.model=selected.model;
  cid=(await post('/api/conversations',{title:'账单核对',memberIds:members.map(m=>m[0]),defaultMemberId:'morning'})).conversation.id;
  proof.room=cid;
  const serial='CW'+randomInt(10000,99999), cents=randomInt(100,999);
  const sent=await post('/api/conversations/'+cid+'/messages',{content:'@阿岚 帮我查清这笔疑似重复收费并给答复。现在是换班时间，按排班把整件工作交给晚班；请最终接手的人核对并直接答复我。房间里可核验的账本：订单'+serial+'存在两条金额'+cents+'元的流水，第一条已入账，第二条被银行作废，实扣笔数以有效流水为准。'});
  proof.submittedUserSources.push(sent.source.id);
  const deadline=Date.now()+maxCalls*180000;
  while (Date.now()<deadline) {
    const d=store.detail(cid), root=store.obligations.list(cid).find(o=>!o.parentId);
    const failed=d.invocations.find(i=>['failed','cancelled','interrupted'].includes(i.status));
    assert(!failed,failed?.memberId+' '+failed?.error);
    if(d.invocations.length && d.invocations.every(i=>i.status==='succeeded') && !d.deliveries.some(x=>x.status==='pending')) {
      assert.equal(root?.state,'delivered','No final delivery or autonomous continuation');
      const shifts=store.tasks.handoffs(cid);
      assert.deepEqual(shifts.map(h=>h.offer?.decision?.choice),rejectFirst?['decline','accept']:['accept']);
      assert.deepEqual(shifts.map(h=>h.state),rejectFirst?['refused','applied']:['applied']);
      assert.equal(root.owner.memberId,rejectFirst?'standby':'evening');
      const final=d.messages.find(m=>m.id===root.delivery?.messageId);
      assert(final && final.memberId===root.owner.memberId && final.content.includes(serial) && final.content.includes(String(cents)));
      assert(/一[笔次]|1[笔次]|未重复|没有重复|未被重复|并未重复/.test(final.content));
      assert.equal(d.messages.filter(m=>m.author==='user').length,1);
      assert(d.invocations.every(i=>i.acceptance==='accepted' && i.teardown==='confirmed' && i.nativeSessionId && i.roomMember?.id));
      proof.final=final.id;proof.accepted=true;break;
    }
    await delay(300);
  }
  assert(proof.accepted,'Timed out');
} catch(e){proof.error=String(e.message).slice(0,480);}
finally {
  if(store && cid) {
    const d=store.detail(cid);
    proof.runs=d.invocations.map(i=>({id:i.id,member:i.roomMember?.id,status:i.status,acceptance:i.acceptance,teardown:i.teardown,nativeSessionId:i.nativeSessionId}));
    proof.handoffs=store.tasks.handoffs(cid);proof.roots=store.obligations.list(cid);proof.consumptions=d.consumptions;
    proof.factors=store.factors.list(cid).map(({id,kind,sourceRef,version,parentIds})=>({id,kind,sourceRef,version,parentIds}));
  }
  await app?.close();
  const report=join(dir,'result.json');await writeFile(report,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({accepted:proof.accepted,calls:proof.calls.length,error:proof.error,report}));
}
if(!proof.accepted)process.exitCode=1;
