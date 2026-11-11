import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/index.js';
import type { CollaborationRuntime, ConversationDetail, RuntimeRequest } from '../shared/collaboration.js';

async function fixture(invoke:(r:RuntimeRequest)=>Promise<string>) {
  const dir=await mkdtemp(join(tmpdir(),'hydra-obligation-http-'));
  const calls:string[]=[];
  const runtime:CollaborationRuntime={probe:async()=>[],invoke:async r=>{
    calls.push(r.member.id);r.onEvent({kind:'session',detail:{nativeSessionId:'session-'+r.invocationId}});
    r.onEvent({kind:'accepted',detail:{nativeTurnId:'turn-'+r.invocationId}});
    const text=await invoke(r); r.onEvent({kind:'process_exit',detail:{confirmed:true,code:0}}); return {text,continuity:'fresh'};
  }};
  const app=await createApplication({dataDir:dir,port:0,collaborationRuntime:runtime});
  const {url}=await app.start(), {csrfToken}=await (await fetch(url+'/api/collaboration/bootstrap')).json();
  const post=async(path:string,body:object)=>{const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrfToken},body:JSON.stringify(body)});
    return {status:res.status, data:await res.json()};};
  const {data:{conversation:c}}=await post('/api/conversations',{requestId:crypto.randomUUID(),title:'AB 普通入口',memberIds:['claude','codex'],defaultMemberId:'claude'});
  const path='/api/conversations/'+c.id;
  const wait=async(ok:(d:ConversationDetail)=>boolean)=>{
    let d:ConversationDetail;const start=Date.now();
    do{d=await(await fetch(url+path)).json();if(ok(d))return d;await new Promise(r=>setTimeout(r,20));}while(Date.now()-start<6000);
    throw new Error(JSON.stringify({obligations:d.obligations,traces:d.invocations.map(i=>[i.memberId,i.status,i.error])}));
  };
  return {calls,post,path,wait,send:(content:string)=>post(path+'/messages',{content,requestId:crypto.randomUUID()}),close:async()=>{await app.close();await rm(dir,{recursive:true,force:true});}};
}
test('A+B：自然委托 → 验证子责 → 主责一次交付 → 用户按约定验收',async()=>{
 let root='',step=0;
 const h=await fixture(async r=>{
   assert.equal(r.obligationPolicy,true);const tool=(name:string,args:Record<string,unknown>,key=name)=>r.onToolCall(name,args,key) as Promise<any>;
   if(++step===1){assert.equal(r.member.id,'claude');
     const res=await tool('obligation_open',{goal:'核对样稿并答复',acceptance:'user'});root=res.obligation.id;
     await tool('collaboration_request',{targets:['codex'],content:'检查样稿第二版的日期。',delivery:{obligationId:root,version:'v2',acceptance:'日期一致'}});return '我已请同伴核对日期。';}
   if(step===2){assert.equal(r.member.id,'codex');const c=(await tool('obligation_list',{})).obligations[0];assert.equal(c.parentId,root);
     await tool('obligation_report',{obligationId:c.id,outcome:'passed',version:'v2',summary:'两个日期一致。'});return '第二版日期一致。';}
   assert.equal(step,3);assert.equal(r.member.id,'claude');
   await tool('obligation_deliver',{obligationId:root,summary:'第二版日期已核对。'});return '第二版日期已核对。';
 });
 try{await h.send('@Claude 核对样稿第二版的日期，请同伴验证后交我验收。');
   const d=await h.wait(d=>d.obligations?.some(o=>o.state==='awaiting_acceptance')??false);
   const rootRow=d.obligations!.find(o=>o.id===root)!;assert.ok(rootRow.delivery?.messageId);
   assert.deepEqual(h.calls,['claude','codex','claude']);const p=h.path+'/obligations/'+root+'/accept';
   assert.equal((await h.post(p,{requestId:crypto.randomUUID(),expectedRevision:rootRow.revision-1})).status,409);
   const body={requestId:crypto.randomUUID(),expectedRevision:rootRow.revision};assert.equal((await h.post(p,body)).status,200);assert.equal((await h.post(p,body)).status,200);
   await h.wait(d=>d.obligations?.every(o=>o.state==='delivered')??false);
 }finally{await h.close();}
});
test('A+B：单成员等待精确事件，错配不推进；模式切换不能丢掉未结委托',async()=>{
 let root='',n=0;
 const h=await fixture(async r=>{const tool=(name:string,args:Record<string,unknown>)=>r.onToolCall(name,args,name) as Promise<any>;
   if(++n===1){root=(await tool('obligation_open',{goal:'等校样签收'})).obligation.id;
     await tool('obligation_wait',{obligationId:root,condition:'receipt:123',deadline:new Date(Date.now()+300000).toISOString()});return '等校样签收。';}
   await tool('obligation_deliver',{obligationId:root,summary:'校样已签收。'});return '校样已签收。';
 });
 try{await h.send('帮我等这份校样签收，然后告诉我。');const d=await h.wait(d=>d.obligations?.some(o=>o.state==='waiting')??false);
   const o=d.obligations![0]!, w=o.wait!;const toggle={requestId:crypto.randomUUID(),mode:'legacy',expectedMode:'continuous'};
   assert.equal((await h.post(h.path+'/collaboration-mode',toggle)).status,409);
   const body={requestId:crypto.randomUUID(),expectedRevision:o.revision,waitId:w.id,condition:w.condition,summary:'快递已签收'};
   const p=h.path+'/obligations/'+root+'/signal';
   assert.equal((await h.post(p,{...body,condition:'receipt:124'})).status,409);assert.equal((await h.post(p,body)).status,200);
   assert.equal((await h.post(p,body)).status,200);
   await h.wait(d=>d.obligations?.[0]?.state==='delivered');assert.deepEqual(h.calls,['claude','claude']);
   assert.equal((await h.post(h.path+'/collaboration-mode',toggle)).status,200);
 }finally{await h.close();}
});
test('A+B：普通答复中知会同伴不登记责任、不创建接回来源',async()=>{
 const h=await fixture(async()=> '这是日期格式的含义。\n@Codex 仅供知悉。');
 try {await h.send('这个日期格式是什么意思？');const d=await h.wait(d=>d.invocations.some(i=>i.status==='succeeded'));
   assert.deepEqual(d.obligations,[]);assert.equal(d.sources.length,1);assert.deepEqual(h.calls,['claude']);
 } finally {await h.close();}
});

test('A+B：实机原话要求负责人汇报，成员自选人工验收仍在公开交付后完成',async()=>{
  let root='', phase=0;
  const h=await fixture(async r=>{
    const call=(name:string,args:Record<string,unknown>)=>r.onToolCall(name,args,name) as Promise<any>;
    phase++;
    if(phase===1) {
      const result=await call('obligation_open',{goal:'修复后请同伴核验，再向用户汇报',acceptance:'user'});
      assert.equal(result.obligation.acceptBy,'delivery');root=result.obligation.id;
      await call('collaboration_request',{targets:['codex'],content:'独立核对固定版本并回报。',delivery:{obligationId:root,acceptance:'通过核验',version:'v2'}});
      return '已请同伴核验。';
    }
    if(phase===2) {
      const sub=(await call('obligation_list',{})).obligations[0];
      await call('obligation_report',{obligationId:sub.id,version:'v2',outcome:'passed',summary:'已独立核验。'});
      return '已回报。';
    }
    await call('obligation_deliver',{obligationId:root,summary:'修复已通过独立核验。'}); return '修复已通过独立核验。';
  });
  try{
    await h.send('@Claude 等收到通过的结果后，请你本人向我汇报一次最终结果。');
    const result=await h.wait(d=>d.obligations?.some(o=>o.id===root&&o.state==='delivered')??false);
    assert.equal(result.obligations!.find(o=>o.id===root)?.userAcceptance,undefined);
    assert.deepEqual(h.calls,['claude','codex','claude']);
    assert.equal(result.tasks!.find(t=>t.id===result.obligations!.find(o=>o.id===root)!.taskId)?.status,'done');
  } finally {await h.close();}
});

test('A+B：最终由用户确认的委托保留签收权，即使成员建议直接交付',async()=>{
  const h=await fixture(async r=>{
    const opened=await r.onToolCall('obligation_open',{goal:'整体验证完成后交付',acceptance:'delivery'},'open') as {obligation:{id:string;acceptBy:string}};
    assert.equal(opened.obligation.acceptBy,'user');
    await r.onToolCall('obligation_deliver',{obligationId:opened.obligation.id,summary:'验证结果已送达。'},'deliver');
    return '验证结果已送达。';
  });
  try{
    await h.send('先自动检查所有材料，最终由我确认。');
    const d=await h.wait(s=>s.obligations?.some(o=>o.state==='awaiting_acceptance')??false);
    const root=d.obligations!.find(o=>!o.parentId)!;
    assert.equal(root.userAcceptance?.quote,'最终由我确认');
    assert.notEqual(d.tasks!.find(t=>t.id===root.taskId)?.status,'done');
    assert.equal((await h.post(h.path+'/obligations/'+root.id+'/accept',{requestId:crypto.randomUUID(),expectedRevision:root.revision})).status,200);
    await h.wait(s=>s.obligations?.some(o=>o.id===root.id&&o.state==='delivered')??false);
  } finally {await h.close();}
});
