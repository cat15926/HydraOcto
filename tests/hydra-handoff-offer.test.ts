import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
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
      const t = s.tasks.getTask(root.taskId);
      return s.tasks.handoff(t.id,{requestId:randomUUID(),expectedOwnerRevision:t.ownerRevision,expectedRevision:t.revision,targetMemberId:to,reason:'换班'},id).handoff;
    };
    const firstOffer = solicit(first,'claude');
    const candidate = start();
    assert.equal(s.contract(candidate).handoffPolicy,'candidate-v1');
    assert(runtimeTools(s.contract(candidate)).some(t=>t.name==='task_handoff_decide'));
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
