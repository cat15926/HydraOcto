import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { OpinionRound,SignedOpinion } from '../shared/opinions.js';
import type { Obligation } from '../shared/obligations.js';

function fixture(lockMode:'early'|'deadline',minimum=2) {
  const path=mkdtempSync(join(tmpdir(),'hydra-opinions-')), file=join(path,'state.sqlite');
  let time=Date.now(), owner=new Store(file), store=new CollaborationStore(owner,{clock:()=>time});
  const template=store.members().find(m=>m.id==='claude')!;
  for(const id of ['third','fourth'])store.saveMember({...template,id,name:id});
  const cid=store.create({requestId:randomUUID(),title:'展览',memberIds:['codex','claude','third','fourth'],defaultMemberId:'codex'}).conversation.id;
  store.send(cid,{requestId:randomUUID(),content:'从三名评审收集意见，再决定选稿。附件所引版权声明：展览使用权已书面授予。'});
  const original=store.detail(cid).messages[0]!;
  function start(){const run=store.admitNext()?.invocations[0];assert(run);store.startInvocation(run.id);store.recordEvidence(run.id,{kind:'accepted',detail:{origin:'acceptance-test'}});return run;}
  function end(id:string,text='已登记。'){store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});store.finish(id,'succeeded',text);}
  function tool(id:string,name:string,args:Record<string,unknown>,key:string=randomUUID()){return store.obligations.opinions.tool(id,name,args,key);}
  const opener=start(), root=(store.obligations.tool(opener.id,'obligation_open',{goal:'选择展品'},'open') as {obligation:Obligation}).obligation;
  const args={obligationId:root.id,question:'此稿是否适合本次展览？',targets:['claude','third','fourth'],minimum,lockMode,deadline:new Date(time+300000).toISOString()};
  const round=tool(opener.id,'opinion_open',args,'collect') as OpinionRound;
  assert.equal((tool(opener.id,'opinion_open',args,'collect') as OpinionRound).id,round.id);
  assert.throws(()=>tool(opener.id,'opinion_submit',{roundId:round.id,text:'代投',objection:false}));
  end(opener.id);
  const read=()=>store.obligations.opinions.list(cid)[0]!;
  function vote(id:string,text:string,objection=false,key:string=randomUUID()){return tool(id,'opinion_submit',{roundId:round.id,text,objection},key) as SignedOpinion;}
  function deliver(id:string){return store.obligations.tool(id,'obligation_deliver',{obligationId:root.id,summary:'采用经过核查的资料'},randomUUID());}
  return {get store(){return store;},cid,opener,root,original,read,vote,start,end,deliver,tool,round,
    due(){time+=300001;store.obligations.reconcile();},restart(){owner.close();owner=new Store(file);store=new CollaborationStore(owner,{clock:()=>time});},
    close(){owner.close();rmSync(path,{recursive:true,force:true});}};
}
test('E06 qualified signed revisions, replay, objection evidence, lock and late archival survive restart',()=>{
  const h=fixture('early');try {
    const first=h.start(),v=h.vote(first.id,'建议采用',false,'one');
    assert.equal(h.vote(first.id,'建议采用',false,'one').id,v.id);
    const revised=h.vote(first.id,'建议附出处');
    assert.equal(revised.version,2);assert.equal(h.read().validCount,1);assert.equal(h.read().wakeSourceId,undefined);
    h.end(first.id);
    const second=h.start(),objection=h.vote(second.id,'版权授权待核查',true);h.end(second.id);
    const wake=h.read().wakeSourceId;assert(wake);
    h.restart();h.store.obligations.reconcile();assert.equal(h.read().wakeSourceId,wake);
    const third=h.start(),decider=h.start();
    assert.equal(decider.memberId,'codex');
    const observed=h.tool(decider.id,'opinion_read',{roundId:h.round.id}) as OpinionRound;
    assert.equal(observed.validCount,2);
    assert.throws(()=>h.deliver(decider.id));
    assert.throws(()=>h.tool(decider.id,'opinion_lock',{roundId:h.round.id,expectedRevision:observed.revision-1}));
    h.tool(decider.id,'opinion_lock',{roundId:h.round.id,expectedRevision:observed.revision});
    assert.deepEqual(h.read().lockedOpinionIds,[revised.id,objection.id]);
    assert(h.vote(third.id,'迟到意见',true).late);h.end(third.id);
    assert.throws(()=>h.deliver(decider.id),/异议/);
    const args={roundId:h.round.id,opinionId:objection.id,finding:'已核对书面授权。'};
    assert.throws(()=>h.tool(decider.id,'opinion_resolve',{...args,evidenceMessageId:'missing'}));
    h.tool(decider.id,'opinion_resolve',{...args,evidenceMessageId:h.original.id});
    // Simulate evidence drift between recording the finding and actually delivering.
    const edited={...h.original,revision:(h.original.revision??1)+1,content:'版权文件修订。'};
    h.store.visibility.put('cc_messages',edited);
    const invalid=h.read().resolutions[0]!;
    assert.equal(invalid.valid,false);assert.equal(invalid.evidenceMessageId,undefined);assert.equal(invalid.finding,undefined);
    assert.throws(()=>h.deliver(decider.id),/异议/);
    h.tool(decider.id,'opinion_resolve',{...args,evidenceMessageId:h.original.id,finding:'已复核修订后的版权文件。'});
    assert.deepEqual(h.read().resolutions.map(v=>v.valid),[false,true]);
    h.deliver(decider.id);h.end(decider.id,'采用经过核查的资料');
    assert.equal(h.store.obligations.list(h.cid)[0]!.state,'delivered');assert.equal(h.read().wakeSourceId,wake);
    assert.equal(h.store.admitNext(),undefined);
  }finally{h.close();}
});
test('E06 a fixed cutoff freezes the last pre-cutoff opinions and wakes the owner once',()=>{
  const h=fixture('deadline');try{
    for(let n=0;n<2;n++){const run=h.start();h.vote(run.id,'同意 '+n);h.end(run.id);}
    assert.equal(h.read().state,'collecting');assert.equal(h.read().wakeSourceId,undefined);
    const third=h.start();h.due();const locked=h.read();assert.equal(locked.state,'locked');assert(locked.wakeSourceId);
    assert(h.vote(third.id,'迟到').late);h.end(third.id);
    h.store.obligations.reconcile();h.store.obligations.reconcile();assert.equal(h.read().wakeSourceId,locked.wakeSourceId);
    const owner=h.start();h.deliver(owner.id);h.end(owner.id,'采用经过核查的资料');assert.equal(h.store.admitNext(),undefined);
  }finally{h.close();}
});
test('E06 missing quorum is an owned blockage. Late signatures cannot reverse the cutoff',()=>{
  const h=fixture('early');try{
    const run=h.start();h.vote(run.id,'已读');h.end(run.id);h.due();h.restart();h.store.obligations.reconcile();
    assert.equal(h.read().state,'expired');assert.equal(h.read().validCount,1);assert.equal(h.read().wakeSourceId,undefined);
    const item=h.store.obligations.list(h.cid)[0]!;assert.equal(item.state,'blocked');assert.equal(item.owner.memberId,'codex');
    const late=h.start();assert(h.vote(late.id,'补交').late);assert.equal(h.read().validCount,1);
  }finally{h.close();}
});

test('E06 an invitation belongs to its room instance, and a departed signer cannot fill quorum',()=>{
  const h=fixture('deadline');try{
    const first=h.start();h.vote(first.id,'同意');h.end(first.id);
    const next=h.start();
    const roster=h.store.detail(h.cid).conversation.memberIds;
    h.store.roomMembers.sync(h.cid,roster.filter(v=>v!==first.memberId && v!==next.memberId));
    h.store.roomMembers.sync(h.cid,roster);
    assert.notEqual(h.store.roomMembers.resolve(h.cid,next.memberId).id,next.roomMember!.id);
    assert.throws(()=>h.vote(next.id,'用离房前的执行提交'));
    h.due();assert.equal(h.read().validCount,0);assert.equal(h.read().state,'expired');
  }finally{h.close();}
});

test('E06 revoking the first invitation removes its signature from a pending cutoff',()=>{
  const h=fixture('deadline');try {
    const first=h.start();h.vote(first.id,'同意');h.end(first.id);
    const source=h.store.visibility.primary(first.id);
    h.store.cooperation.withdraw(source.id,{requestId:randomUUID(),expectedRevision:source.revision});
    const second=h.start();h.vote(second.id,'赞同');h.end(second.id);h.due();
    assert.equal(h.read().validCount,1);assert.equal(h.read().state,'expired');
  }finally{h.close();}
});
