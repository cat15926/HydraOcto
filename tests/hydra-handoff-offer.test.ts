import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { Obligation } from '../shared/obligations.js';
import type { TaskHandoff } from '../shared/collaboration.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';

test('tracked handoff: two candidates, decline resumes original owner, acceptance survives restart without early ownership', () => {
  const dir = mkdtempSync(join(tmpdir(),'hydra-handoff-')), path = join(dir,'state.sqlite');
  let db = new Store(path), s = new CollaborationStore(db);
  const start = () => {
    const i = s.admitNext()!.invocations[0]!;
    s.startInvocation(i.id); s.recordEvidence(i.id,{kind:'accepted',detail:{origin:'protocol-test'}});
    return i.id;
  };
  const exit = (id: string) => s.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});
  const end = (id: string, message: string) => { exit(id); s.finish(id,'succeeded',message); };
  try {
    s.saveMember({...s.members().find(m=>m.id==='claude')!,id:'late',name:'晚班'});
    const cid = s.create({requestId:randomUUID(),title:'轮班',memberIds:['codex','claude','late'],defaultMemberId:'codex'}).conversation.id;
    s.send(cid,{requestId:randomUUID(),content:'查清重复账单并给我答复。'});
    const first = start();
    const {obligation:root} = s.obligations.tool(first,'obligation_open',{goal:'核查账单并答复'},'root') as any;
    const solicit = (id:string,to:string) => {
      const args = {obligationId:root.id,targetMemberId:to,reason:'换班'}, call = randomUUID();
      const invoke = () => s.obligations.tool(id,'obligation_handoff',args,call) as {handoff:TaskHandoff};
      s.visibility.assertTool(id,'obligation_handoff');
      const result = invoke(); assert.equal(invoke().handoff.id,result.handoff.id);
      assert.equal(result.handoff.offer!.obligationId,root.id);
      return result.handoff;
    };
    assert.equal(s.contract(first).handoffPolicy,'consent-v2');
    assert(runtimeTools(s.contract(first)).some(tool=>tool.name==='obligation_handoff'));
    assert.match(s.prompt(first),/直接调用 obligation_handoff/);
    const firstOffer = solicit(first,'claude');
    const candidate = start();
    assert.equal(s.contract(candidate).handoffPolicy,'candidate-v1');
    assert(runtimeTools(s.contract(candidate)).some(t=>t.name==='task_handoff_decide'));
    assert(!runtimeTools(s.contract(candidate)).some(t=>t.name==='obligation_handoff'));
    assert(!runtimeTools(s.contract(first)).some(t=>t.name==='task_handoff_decide'));
    assert.throws(()=>s.tasks.tool(first,'task_handoff_decide',{handoffId:firstOffer.id,decision:'accept',reason:'代答'},'forge'));
    s.tasks.tool(candidate,'task_handoff_decide',{handoffId:firstOffer.id,decision:'decline',reason:'已在另一班次'},'no');
    end(candidate,'本轮不能接手'); end(first,'等待交班回复');
    let t = s.tasks.getTask(root.taskId);
    assert.equal(t.ownerMemberId,'codex'); assert.equal(t.ownerRevision,1);
    const returned = start(); assert.equal(s.invocation(returned).memberId,'codex');
    assert(s.prompt(returned).includes('已在另一班次'));
    assert.equal(s.obligations.context(returned)[0]!.id,root.id);
    const secondOffer = solicit(returned,'late'), yes = start();
    const args = {handoffId:secondOffer.id,decision:'accept',reason:'晚班接手'};
    s.tasks.tool(yes,'task_handoff_decide',args,'yes');
    assert.equal(s.tasks.tool(yes,'task_handoff_decide',args,'yes').replayed,true);
    end(yes,'接受邀请'); s.finish(returned,'succeeded','请晚班继续'); // original process exit is still unproved
    assert.equal(s.tasks.getTask(t.id).ownerMemberId,'codex');
    db.close(); db = new Store(path); s = new CollaborationStore(db);
    s.tasks.reconcile(); assert.equal(s.tasks.getTask(t.id).ownerMemberId,'codex');
    exit(returned); s.tasks.reconcile(); s.tasks.reconcile();
    t = s.tasks.getTask(t.id);
    assert.equal(t.ownerMemberId,'late'); assert.equal(t.ownerRevision,2);
    assert.equal(s.obligations.list(cid).find(o=>o.id===root.id)!.owner.memberId,'late');
    assert.equal(s.detail(cid).deliveries.filter(d=>d.sourceId===secondOffer.sourceId).length,1);
    assert.throws(()=>s.obligations.tool(returned,'obligation_deliver',{obligationId:root.id,summary:'迟到结论'},'late'));
    const worker = start();
    s.obligations.tool(worker,'obligation_deliver',{obligationId:root.id,summary:'账单核查完成'},'done');
    end(worker,'账单核查完成'); assert.equal(s.tasks.getTask(t.id).status,'done');
    assert.equal(s.obligations.list(cid).find(o=>o.id===root.id)!.state,'delivered');
    assert.equal(s.admitNext(),undefined);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('a second ordinary task created by the same source cannot substitute for its registered root', () => {
  const db = new Store(':memory:'), s = new CollaborationStore(db);
  try {
    const cid = s.create({requestId:randomUUID(),title:'交班',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
    s.send(cid,{requestId:randomUUID(),content:'完成账单核对，需要时交接。'});
    const run = s.admitNext()!.invocations[0]!;
    s.startInvocation(run.id); s.recordEvidence(run.id,{kind:'accepted',detail:{origin:'protocol-test'}});
    const {obligation} = s.obligations.tool(run.id,'obligation_open',{goal:'核对账单'},'register') as {obligation:Obligation};
    const side = s.tasks.tool(run.id,'task_create',{title:'核对账单',description:'独立备忘',ownerMemberId:'codex'},'another').task;
    assert.notEqual(side.id,obligation.taskId);
    const count = s.detail(cid).sources.length;
    assert.throws(()=>s.tasks.tool(run.id,'task_handoff',{taskId:side.id,expectedRevision:side.revision,
      expectedOwnerRevision:side.ownerRevision,targetMemberId:'claude',reason:'整项转交'},'transfer'),/obligation_handoff/);
    assert.equal(s.tasks.handoffs(cid).length,0); assert.equal(s.detail(cid).sources.length,count);
    assert.equal(s.tasks.getTask(side.id).ownerMemberId,'codex');
    assert.equal(s.obligations.list(cid)[0]!.state,'open');
    assert.throws(()=>s.obligations.tool(run.id,'obligation_handoff',{obligationId:side.id,targetMemberId:'claude',reason:'错误对象'},'wrong-id'));
    const other=s.create({requestId:randomUUID(),title:'隔离房间',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
    s.send(other,{requestId:randomUUID(),content:'核对其他事项'});
    const outsider=s.admitNext()!.invocations[0]!;
    s.startInvocation(outsider.id); s.recordEvidence(outsider.id,{kind:'accepted',detail:{origin:'protocol-test'}});
    assert.throws(()=>s.obligations.tool(outsider.id,'obligation_handoff',{obligationId:obligation.id,targetMemberId:'claude',reason:'越权'},'other-room'));
    assert.equal(s.tasks.handoffs(cid).length,0);
    const independent = s.tasks.tool(outsider.id,'task_create',{title:'独立备忘',description:'',ownerMemberId:'codex'},'separate').task;
    const result=s.tasks.tool(outsider.id,'task_handoff',{taskId:independent.id,expectedRevision:independent.revision,
      expectedOwnerRevision:independent.ownerRevision,targetMemberId:'claude',reason:'转交独立备忘'},'ordinary');
    assert.equal(result.handoff.taskId,independent.id); assert.equal(result.handoff.offer,undefined);
  } finally {db.close();}
});

test('a stored consent-v1 source keeps its original tool list, prompt and descendant policy', () => {
  const db = new Store(':memory:'), s = new CollaborationStore(db);
  try {
    const cid = s.create({requestId:randomUUID(),title:'旧契约',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
    s.admitSource({conversationId:cid,kind:'user',requestedTargets:['codex'],depth:0,content:'旧委托，请核对材料。',handoffPolicy:'consent-v1'});
    const run=s.admitNext()!.invocations[0]!;
    s.startInvocation(run.id); s.recordEvidence(run.id,{kind:'accepted',detail:{origin:'protocol-test'}});
    const c=s.contract(run.id);
    assert.equal(c.handoffPolicy,'consent-v1'); assert(!runtimeTools(c).some(t=>t.name==='obligation_handoff'));
    assert.doesNotMatch(s.prompt(run.id),/obligation_handoff/);
    const {obligation}=s.obligations.tool(run.id,'obligation_open',{goal:'核对材料'},'old-open') as {obligation:Obligation};
    assert.throws(()=>s.visibility.assertTool(run.id,'obligation_handoff'));
    assert.throws(()=>s.obligations.tool(run.id,'obligation_handoff',{obligationId:obligation.id,targetMemberId:'claude',reason:'新工具'},'new-tool'),/冻结/);
    const task=s.tasks.getTask(obligation.taskId!);
    const handoff=s.tasks.handoff(task.id,{requestId:randomUUID(),expectedRevision:task.revision,expectedOwnerRevision:task.ownerRevision,
      targetMemberId:'claude',reason:'通过原有工具交班'},run.id).handoff;
    const detail=s.detail(cid);
    assert.equal(handoff.offer?.obligationId,obligation.id);
    assert.equal(detail.sources.find(v=>v.id===handoff.sourceId)?.handoffPolicy,'consent-v1');
    assert.equal(detail.sources.find(v=>v.id===handoff.offer!.sourceId)?.handoffPolicy,'candidate-v1');
  } finally {db.close();}
});
