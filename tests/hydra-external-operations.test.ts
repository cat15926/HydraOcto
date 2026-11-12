import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import type {Obligation} from '../shared/obligations.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';
import {boothAdapter} from './fixtures/booth-operation-adapter.js';

test('E09 a frozen ordinary source never gains host tools; a replacement instance cannot approve the original write',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-scope-')),actor=new Store(join(dir,'state')),store=new CollaborationStore(actor);
  const booth=boothAdapter(join(dir,'ledger'),()=>true,false);
  try {
    const cid=store.create({requestId:randomUUID(),title:'房间',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
    const send=()=>store.send(cid,{requestId:randomUUID(),content:'帮我预订秋展 A12 展位。'});
    const start=()=>{const r=store.admitNext()!.invocations[0]!;store.startInvocation(r.id);store.recordEvidence(r.id,{kind:'accepted',detail:{origin:'unit-test'}});return r.id;};
    const finish=(id:string)=>{store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});store.finish(id,'succeeded','本轮结束。');};
    send();store.options.externalOperations=booth.adapter;
    const old=start();assert(store.contract(old).coordinationPolicy);
    assert(!runtimeTools(store.contract(old)).some(t=>t.name==='obligation_external_request'));finish(old);
    send();const fresh=start();assert(runtimeTools(store.contract(fresh)).some(t=>t.name==='obligation_external_request'));
    const root=(store.obligations.tool(fresh,'obligation_open',{goal:'预约'},'open') as {obligation:Obligation}).obligation;
    const req=await store.obligations.externalTool(fresh,'obligation_external_request',{obligationId:root.id,targetId:booth.target.id});
    finish(fresh);
    store.roomMembers.sync(cid,['claude']);store.roomMembers.sync(cid,['claude','codex']);
    const o=store.obligations.list(cid)[0]!;
    assert.throws(()=>store.obligations.approveExternal(cid,o.id,{operationId:req.operation.id,expectedRevision:o.revision,requestId:randomUUID()}));
    assert.equal(o.externalOperation?.stage,'approval');assert.notEqual(o.owner.instanceId,store.roomMembers.resolve(cid,'codex')?.id);
  } finally {booth.close();actor.close();rmSync(dir,{recursive:true,force:true});}
});

for(const drop of [false,true]) test('E09 single explicit grant and exact external receipt; lost response='+drop,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'external-ledger-')),platform=join(dir,'platform.sqlite'),domain=join(dir,'domain.sqlite');
  let cid='', unavailable=drop, permitted=true;
  const booth=boothAdapter(domain,actor=>permitted && actor.conversationId===cid && actor.memberId==='codex',drop,()=>unavailable);
  let host=new Store(platform), store=new CollaborationStore(host,{externalOperations:booth.adapter});
  const db=new DatabaseSync(domain,{readOnly:true});
  const read=()=>store.obligations.list(cid)[0]!;
  const start=()=>{const run=store.admitNext()?.invocations[0];assert(run);store.startInvocation(run.id);store.recordEvidence(run.id,{kind:'accepted',detail:{origin:'unit-test'}});return run.id;};
  const finish=(id:string,content='已处理本轮。')=>{store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});store.finish(id,'succeeded',content);};
  const startOver=()=>{host.close();host=new Store(platform);store=new CollaborationStore(host,{externalOperations:booth.adapter});};
  const writes=()=>db.prepare('SELECT count(*) AS n FROM reservation_calls').get()!.n;
  try {
    cid=store.create({requestId:randomUUID(),title:"秋展",memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
    store.send(cid,{requestId:randomUUID(),content:'帮我预约秋展的 A12 展位。'});
    const asker=start(), root=(store.obligations.tool(asker,'obligation_open',{goal:'预约秋展展位'},'open') as {obligation:Obligation}).obligation;
    const tool=(run:string,name:string,fields:Record<string,unknown>={})=>store.obligations.externalTool(run,'obligation_external_'+name,{obligationId:root.id,...fields});
    const deliver=(run:string,summary:string)=>store.obligations.tool(run,'obligation_deliver',{obligationId:root.id,summary},randomUUID());
    await assert.rejects(tool(asker,'request',{targetId:'other'}));
    const {operation}=await tool(asker,'request',{targetId:booth.target.id});
    assert.equal((await tool(asker,'request',{targetId:booth.target.id})).operation.id,operation.id);
    await assert.rejects(tool(asker,'execute'));
    const approval={requestId:randomUUID(),operationId:operation.id,expectedRevision:read().revision};
    finish(asker);store.obligations.reconcile();assert.equal(read().state,'waiting');assert.equal(writes(),0);
    assert.throws(()=>store.obligations.approveExternal(cid,root.id,{...approval,operationId:randomUUID()}));
    assert.throws(()=>store.obligations.approveExternal(cid,root.id,{...approval,targetId:'out-of-scope'}));
    store.obligations.approveExternal(cid,root.id,approval);store.obligations.approveExternal(cid,root.id,approval);
    let writer=start();
    if(drop){
      permitted=false;assert.equal((await tool(writer,'execute')).operation.stage,'approval');assert.equal(writes(),0);
      permitted=true;await assert.rejects(tool(writer,'execute'));assert.equal(writes(),0);
      finish(writer);store.obligations.approveExternal(cid,root.id,{...approval,requestId:randomUUID(),expectedRevision:read().revision});
      writer=start();
    }
    const [a,b]=await Promise.all([tool(writer,'execute'),tool(writer,'execute')]);
    assert(a.operation.id===b.operation.id && a.operation.id===operation.id);assert.equal(writes(),1);
    let final=writer;
    if(drop) {
      assert.equal(read().externalOperation?.stage,'unknown');assert.throws(()=>deliver(writer,'已成功'));
      assert.throws(()=>store.obligations.tool(writer,'obligation_wait',{obligationId:root.id,kind:'timer',deadline:new Date(Date.now()+86400000).toISOString(),condition:'稍后查看'},randomUUID()),/不能更换等待/);
      finish(writer);startOver();
      const reader=start();await assert.rejects(tool(reader,'lookup',{operationId:randomUUID()}));
      assert.equal((await tool(reader,'execute')).operation.stage,'unknown');assert.equal(writes(),1);
      await tool(reader,'lookup',{operationId:operation.id});await tool(reader,'lookup',{operationId:operation.id});assert.equal(writes(),1);finish(reader,'仍未知');
      assert.equal(read().state,'blocked');assert.equal(read().owner.instanceId,root.owner.instanceId);
      assert.deepEqual(store.obligations.operatorList(cid)[0]?.recovery?.handoffTargets,[]);
      const task=store.tasks.getTask(root.taskId!);
      assert.throws(()=>store.tasks.handoff(task.id,{requestId:randomUUID(),expectedRevision:task.revision,expectedOwnerRevision:task.ownerRevision,targetMemberId:'claude',reason:'转交其他成员'}),/原负责人仍需核实/);
      startOver();store.obligations.reconcile();assert.equal(read().state,'blocked');
      assert.equal(store.admitNext(),undefined);
      unavailable=false;
      await store.obligations.decide(cid,root.id,{requestId:randomUUID(),decision:'retry',expectedRevision:read().revision});
      final=start();await tool(final,'lookup',{operationId:operation.id});
    }
    const result=read().externalOperation!;assert.equal(result.stage,'recorded');assert(result.receipt);
    assert.equal(db.prepare('SELECT reservation_id FROM reservations WHERE operation_id=?').get(operation.id)?.reservation_id,result.receipt);
    assert.throws(()=>deliver(final,'无编号'));const summary='预约回执 '+result.receipt;
    deliver(final,summary);finish(final,summary);assert.equal(read().state,'delivered');assert.equal(writes(),1);
  } finally {db.close();host.close();booth.close();rmSync(dir,{recursive:true,force:true});}
});
