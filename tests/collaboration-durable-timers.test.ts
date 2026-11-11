import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { Obligation } from '../shared/obligations.js';

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hydra-clock-'));
  const path = join(folder, 'test.sqlite');
  let timestamp = Date.parse('2028-04-20T10:00:00Z');
  let owner = new Store(path);
  let store = new CollaborationStore(owner, {clock: () => timestamp});
  const room = store.create({title: '活动排期', memberIds:['codex'], defaultMemberId:'codex', requestId:randomUUID()}).conversation;
  store.send(room.id, {requestId:randomUUID(), content:'请跟进开放报名的时间。'});
  const invocation = store.admitNext()!.invocations[0]!;
  store.startInvocation(invocation.id);
  store.recordEvidence(invocation.id,{kind:'accepted',detail:{}});
  function tool(name:string, args:Record<string,unknown>) {
    return (store.obligations.tool(invocation.id,name,args,randomUUID()) as {obligation:Obligation}).obligation;
  }
  const root = tool('obligation_open', {goal:'通知报名开放'});
  const until = new Date(timestamp+60000).toISOString();
  return {room,root,until,tool,invocation,get store(){return store;},get owner(){return owner;},
    end(){
      store.recordEvidence(invocation.id,{kind:'process_exit',detail:{confirmed:true}});
      store.finish(invocation.id,'succeeded','已登记。');
    },
    restart(){owner.close(); owner = new Store(path); store = new CollaborationStore(owner,{clock:()=>timestamp}); store.recover();},
    advance(ms:number){timestamp += ms;},
    close(){owner.close();rmSync(folder,{force:true,recursive:true});}
  };
}
test('a room timer survives restart and resumes the same member once, including at the exact deadline',() => {
  const f=fixture();
  try {
    const condition='通知开放报名';
    const w=f.tool('obligation_wait',{obligationId:f.root.id,kind:'timer',condition,deadline:f.until});
    f.end();
    assert.throws(()=>f.store.obligations.signal(f.room.id,w.id,{requestId:randomUUID(),expectedRevision:w.revision,waitId:w.wait!.id,condition,summary:'提前'}),/定时/);
    f.restart(); f.advance(59999);
    assert.equal(f.store.admitNext(),undefined);
    f.advance(1);
    f.store.obligations.reconcile(); f.restart(); f.store.obligations.reconcile();
    const resumed=f.store.admitNext()!.invocations[0]!;
    assert.equal(resumed.memberId,w.owner.memberId);
    assert.equal(resumed.roomMember?.id,w.owner.instanceId);
    assert.equal(f.store.detail(f.room.id).sources.filter(s=>s.kind==='job_result').length,1);
    const row=f.owner.db.prepare('SELECT wait_id,source_id,value FROM cc_obligation_wait_wakes').get()!;
    assert.equal(row.wait_id,w.wait!.id);
    assert.equal(row.source_id,f.store.contract(resumed.id).primarySourceId);
    assert.equal(JSON.parse(String(row.value)).firedAt,f.until);
  } finally {f.close();}
});
test('optional wait kind debits the new contract while an already frozen legacy contract retains its behavior',() => {
  for (const durable of [true, false]) {
    const f = fixture();
    try {
      if (!durable) {
        // Restore the shape of an actual pre-upgrade frozen contract.
        const contract = f.store.contract(f.invocation.id);
        delete contract.continuationPolicy;
        f.owner.db.prepare('UPDATE cc_contracts SET value=? WHERE invocation_id=?').run(JSON.stringify(contract),f.invocation.id);
      }
      const w = f.tool('obligation_wait',{obligationId:f.root.id,condition:'到场',deadline:f.until});
      assert.equal(w.wait?.kind,durable ? 'event' : undefined);
      assert.equal(w.waitCount,durable ? 1 : undefined);
      assert.deepEqual(w.wait?.returnTo,durable ? f.root.owner : undefined);
      f.end();
      const signal = {requestId:randomUUID(),waitId:w.wait!.id,expectedRevision:w.revision,condition:'到场',summary:'已经到场'};
      f.store.obligations.signal(f.room.id,w.id,signal);
      f.store.obligations.signal(f.room.id,w.id,signal);
      assert.equal(f.owner.db.prepare('SELECT count(*) AS n FROM cc_obligation_wait_wakes').get()!.n,durable ? 1 : 0);
      assert.equal(f.store.detail(f.room.id).sources.filter(s=>s.kind==='job_result').length,1);
    } finally {f.close();}
  }
});
test('an expired named event remains blocked; cancelling a live timer before restart creates no wake',async () => {
  for (const kind of ['event','timer']) {
    const f=fixture();
    try {
      const condition='会场开放';const w=f.tool('obligation_wait',{obligationId:f.root.id,kind,condition,deadline:f.until}); f.end();
      const cmd={requestId:randomUUID(),expectedRevision:w.revision,waitId:w.wait!.id,condition:'别的会场',summary:'已开放'};
      if (kind==='event') assert.throws(()=>f.store.obligations.signal(f.room.id,w.id,cmd));
      else await f.store.obligations.decide(f.room.id,w.id,{requestId:randomUUID(),expectedRevision:w.revision,decision:'cancel'});
      f.advance(60001);f.restart();assert.equal(f.store.admitNext(),undefined);
      assert.equal(f.store.obligations.list(f.room.id)[0]!.state,kind==='event'?'blocked':'cancelled');
      assert.throws(()=>f.store.obligations.signal(f.room.id,w.id,{...cmd,condition}));
      assert.equal(f.owner.db.prepare('SELECT count(*) AS n FROM cc_obligation_wait_wakes').get()!.n,0);
    }finally{f.close();}
  }
});
