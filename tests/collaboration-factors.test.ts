import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { Obligation } from '../shared/obligations.js';

function setup() {
  const database=new Store(':memory:'), store=new CollaborationStore(database);
  const create=()=>store.create({title:'材料查证',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const cid=create();
  const actor=(id:string)=>store.roomMembers.resolve(cid,id);
  const run=()=>{
    const i=store.admitNext()!.invocations[0]!;
    store.startInvocation(i.id);store.recordEvidence(i.id,{kind:'accepted',detail:{}});
    return i.id;
  };
  const finish=(id:string,content:string)=>{
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});
    store.finish(id,'succeeded',content);
  };
  const tool=(id:string,name:string,args:Record<string,unknown>)=>
    (store.obligations.tool(id,name,args,randomUUID()) as {obligation:Obligation}).obligation;
  return {database,store,cid,actor,create,run,finish,tool,factors:store.factors};
}
test('projections hide private anchors even when the authorized derivative is used in a public turn',()=>{
  const h=setup();
  try{
    const input={requestId:'grant',memberId:'claude',content:'不可披露的检测编号 5173',publicExpression:'我倾向于保留这件展品。'};
    const issued=h.factors.issue(h.cid,input);
    assert.deepEqual(h.factors.issue(h.cid,input),issued);
    assert.throws(()=>h.factors.issue(h.cid,{...input,content:'不同的编号'}));
    const cutoff=h.factors.cutoff(h.cid);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'private').map(f=>f.kind),['observation','expression']);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('codex'),'private'),[]);
    assert.throws(()=>h.factors.snapshot(h.create(),h.actor('claude'),'private'));
    const projected=h.factors.snapshot(h.cid,h.actor('claude'),'public');
    assert.equal(projected.length,1);
    assert.deepEqual(projected[0]!.parentIds,[]);
    assert.equal(projected[0]!.sequence,1);
    assert.ok(!JSON.stringify(projected).includes(issued.factorId));
    h.factors.issue(h.cid,{...input,requestId:'new',content:'第二份材料'});
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'public',cutoff),projected);
    const user=h.store.send(h.cid,{requestId:'ask',content:'@Claude 给出你的公开建议。'});
    const id=h.run();h.finish(id,input.publicExpression);
    const speech=h.store.detail(h.cid).messages.find(m=>m.memberId==='claude')!;
    const own=h.factors.list(h.cid,h.actor('claude')).find(f=>f.sourceRef.id===speech.id)!;
    assert.ok(own.parentIds.includes(issued.expressionId!));
    const publicView=h.factors.list(h.cid),pub=publicView.find(f=>f.id===own.id)!;
    assert.ok(pub.parentIds.some(p=>publicView.some(f=>f.id===p&&f.sourceRef.id===user.source.id)));
    for(const marker of [issued.factorId,issued.expressionId,input.content])assert.ok(!JSON.stringify(publicView).includes(marker!));
    h.factors.revoke(h.cid,{requestId:'revoke',factorId:issued.factorId});
    assert.equal(h.factors.policyRevision(h.cid),1);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'private',cutoff),[]);
    assert.ok(h.factors.list(h.cid).some(f=>f.id===pub.id),'already public statement remains part of the conversation');
  }finally{h.database.close();}
});
test('a private note inherits all frozen inputs and disappears after revoke even without model-supplied citations',()=>{
  const h=setup();
  try{
    const issue=(content:string)=>h.factors.issue(h.cid,{requestId:randomUUID(),memberId:'claude',content});
    const a=issue('私密材料 A');issue('私密材料 B');
    h.store.send(h.cid,{requestId:'private',content:'请记住这次判断。',privateTo:['claude']});
    const id=h.run();
    const later=issue('本次执行尚未看到 C');
    assert.throws(()=>h.factors.note(id,{requestId:'bad',content:'越界',parentIds:[later.factorId]}));
    const n=h.factors.note(id,{requestId:'remember',content:'我将保留审慎意见。'});
    assert.deepEqual(h.factors.note(id,{requestId:'remember',content:'我将保留审慎意见。'}),n);
    assert.ok(!h.factors.list(h.cid,h.actor('codex')).some(f=>f.id===n.factorId));
    assert.ok(!h.factors.snapshot(h.cid,h.actor('claude'),'public').some(f=>f.id===n.factorId));
    const saved=h.factors.snapshot(h.cid,h.actor('claude'),'private').find(f=>f.id===n.factorId)!;
    assert.ok(saved.parentIds.includes(a.factorId));
    assert.ok(!saved.parentIds.includes(later.factorId));
    h.factors.revoke(h.cid,{requestId:'revoke',factorId:a.factorId});
    assert.throws(()=>h.factors.note(id,{requestId:'late',content:'撤销后回写'}));
    assert.ok(!h.factors.snapshot(h.cid,h.actor('claude'),'private').some(f=>f.id===n.factorId));
  }finally{h.database.close();}
});
test('removing a room member and restoring the same template cannot adopt old private facts',()=>{
  const h=setup();
  try{
    const formerly=h.actor('claude');
    h.factors.issue(h.cid,{requestId:'v1',memberId:'claude',content:'旧实例材料'});
    h.store.updateConversation(h.cid,{memberIds:['codex'],defaultMemberId:'codex'});
    h.store.updateConversation(h.cid,{memberIds:['claude','codex'],defaultMemberId:'codex'});
    assert.throws(()=>h.factors.list(h.cid,formerly));
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'private'),[]);
  } finally{h.database.close();}
});
test('a real responsibility revision is linked to the exact subrequest and evidence, with stable replay',()=>{
  const h=setup();
  try{
    h.store.send(h.cid,{requestId:'start',content:'@Codex 核实材料并给出结论。'});
    const owner=h.run(),root=h.tool(owner,'obligation_open',{goal:'核对材料'});
    const args={targets:['claude'],content:'核对目录',delivery:{obligationId:root.id,version:'v1',acceptance:'查到相应目录'}};
    const request=h.store.requestCollaboration(owner,'assign',args);
    h.finish(owner,'已请同伴复核。');
    const verify=h.run();
    const child=h.store.obligations.list(h.cid).find(o=>o.parentId===root.id)!;
    h.store.recordEvidence(verify,{kind:'tool',detail:{name:'catalog_read',state:'complete'}});
    const e=h.store.detail(h.cid).evidence.findLast(e=>e.invocationId===verify && e.kind==='tool')!;
    h.tool(verify,'obligation_report',{obligationId:child.id,version:'v1',outcome:'passed',summary:'目录一致。',evidenceId:e.id});
    h.finish(verify,'目录一致。');
    const resumed=h.run();
    h.tool(resumed,'obligation_deliver',{obligationId:root.id,summary:'已核对。'});h.finish(resumed,'已核对。');
    const views=h.factors.list(h.cid);
    const report=views.findLast(f=>f.obligationRef?.id===child.id)!;
    const evidence=views.find(f=>f.sourceRef.id===e.id)!;
    const source=views.find(f=>f.sourceRef.id===request.sourceId)!;
    assert.ok(report.parentIds.includes(evidence.id));assert.ok(report.parentIds.includes(source.id));
    assert.ok(evidence.parentIds.includes(source.id));
    const final=views.findLast(f=>f.obligationRef?.id===root.id)!;
    const seen=new Set<string>();const walk=(id:string)=>{
      if(seen.has(id))return;seen.add(id);views.find(f=>f.id===id)?.parentIds.forEach(walk);
    };
    walk(final.id);assert.ok(seen.has(report.id));assert.ok(seen.has(evidence.id));
    const state=h.store.obligations.list(h.cid).find(o=>o.id===root.id)!;
    h.factors.recordObligation(state,'repeated_callback');
    assert.deepEqual(h.factors.list(h.cid),views);
  }finally{h.database.close();}
});

test('a private judgement releases only the chosen authorized expression and cannot be changed or replayed after revocation',()=>{
  const h=setup();
  try{
    const content='私有检测结果 2314', expressionOptions=['我建议展出。','我建议复核。'];
    const base={requestId:'choice-source',memberId:'claude',content,expressionOptions};
    for(const invalid of [
      {...base,publicExpression:'另一种表述'}, {...base,expressionOptions:['只有一句']},
      {...base,expressionOptions:['重复',' 重复 ']},
    ])assert.throws(()=>h.factors.issue(h.cid,invalid));
    const item=h.factors.issue(h.cid,base);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'public'),[]);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'private')[0]?.expressionOptions,expressionOptions);
    h.store.send(h.cid,{requestId:'private-choice',content:'请按检测结果判断。',privateTo:['claude']});
    const id=h.run(), select=(choice:number,req=randomUUID(),observationId=item.factorId)=>
      h.factors.select(id,{requestId:req,observationId,choice});
    for(const v of [0,-1,3,1.2])assert.throws(()=>select(v));
    assert.throws(()=>select(1,randomUUID(),randomUUID()));
    const chosen=select(2);
    assert.deepEqual(select(2),chosen);
    assert.throws(()=>select(1));
    const views=h.factors.snapshot(h.cid,h.actor('claude'),'public');
    assert.equal(views.length,1);
    assert.equal(views[0]!.id,chosen.expressionId);
    assert.equal(views[0]!.content,expressionOptions[1]);
    assert.deepEqual(views[0]!.parentIds,[]);
    for(const marker of [content,item.factorId,expressionOptions[0],'expressionOptions','observationId','"choice"']){
      assert.ok(!JSON.stringify(views).includes(marker!));
    }
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('codex'),'private'),[]);
    assert.ok(!JSON.stringify(h.factors.list(h.cid)).includes(chosen.expressionId));
    h.factors.revoke(h.cid,{requestId:'withdraw-choice',factorId:item.factorId});
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'public'),[]);
    assert.throws(()=>select(2));
  }finally{h.database.close();}
});

test('withdrawing the private turn that produced a judgement hides it and its dependent notes',()=>{
  const h=setup();
  try{
    const options=['公开方案甲。','公开方案乙。'];
    const observation=h.factors.issue(h.cid,{requestId:'observation',memberId:'claude',content:'个人材料',expressionOptions:options});
    const first=h.store.send(h.cid,{requestId:'one',privateTo:['claude'],content:'请结合我的私聊指示，作出判断。'});
    const claude=h.run();
    const old=h.factors.note(claude,{requestId:'note',content:'依照本轮指示的笔记'});
    const selection=h.factors.select(claude,{requestId:'select',observationId:observation.factorId,choice:2});
    h.finish(claude,'已保存。');
    h.store.send(h.cid,{requestId:'two',privateTo:['claude'],content:'回顾上次判断。'});
    const next=h.run(), later=h.factors.note(next,{requestId:'derived',content:'上次的判断仍适用。'});
    h.finish(next,'已复核。');
    h.store.cooperation.withdraw(first.source.id,{requestId:'remove',expectedRevision:first.source.revision});
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'private').map(f=>f.id),[observation.factorId]);
    assert.deepEqual(h.factors.snapshot(h.cid,h.actor('claude'),'public'),[]);
    const view=JSON.stringify(h.factors.list(h.cid,h.actor('claude')));
    for(const hidden of [old.factorId,later.factorId,selection.expressionId,first.source.id])assert.ok(!view.includes(hidden));
  } finally{h.database.close();}
});
