import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {CollaborationRuntime,RuntimeRequest} from '../shared/collaboration.js';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import {CollaborationEngine} from '../server/collaboration/engine.js';

async function until(check:()=>boolean,description:string) {
  const deadline=Date.now()+15000;
  while(!check() && Date.now()<deadline) await delay(10);
  assert(check(),description);
}

test('capacity uses frozen account; a large room keeps three, other rooms and accounts progress, prepared work survives cancel and restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'room-capacity-')),database=join(dir,'platform.sqlite');
  let owner=new Store(database),store=new CollaborationStore(owner,{workspace:dir});
  const waiting=new Map<string,()=>void>(), calls:RuntimeRequest[]=[];
  let stopOnAbort=false,finishImmediately=false;
  const runtime:CollaborationRuntime={async probe(){return [];},async invoke(req) {
    calls.push(req);
    req.onEvent({kind:'accepted',detail:{origin:'capacity-unit-test'}});
    if(!finishImmediately)await new Promise<void>(resolve=>{
      waiting.set(req.invocationId,resolve);
      req.signal.addEventListener('abort',()=>{if(stopOnAbort)resolve();},{once:true});
    });
    waiting.delete(req.invocationId);
    req.onEvent({kind:'process_exit',detail:{confirmed:true}});
    return {text:'已完成当前事项。',continuity:'fresh'};
  }};
  let engine=new CollaborationEngine(store,runtime,{workspace:dir});
  const room=(title:string,ids:string[])=>store.create({requestId:randomUUID(),title,memberIds:ids,defaultMemberId:ids[0]!}).conversation.id;
  const send=(cid:string,ids:string[])=>store.send(cid,{requestId:randomUUID(),content:ids.map(s=>'@'+s).join(' ')+' 各自回复当前进展。'});
  try {
    const member=store.members().find(m=>m.id==='claude')!, sameAccount=member.accountId;
    const names=Array.from({length:12},(_,i)=>'worker'+String(i).padStart(2,'0'));
    for(const id of names)store.saveMember({...member,id,name:id,aliases:[],accountBinding:'override'});
    const first=room('第一房',names),second=room('另一房',names.slice(0,2)),different=room('其他账户',['codex']);
    send(first,names.slice(0,6));send(first,names.slice(6));engine.start();
    await until(()=>calls.length===3 && store.detail(first).invocations.length===12,'three of twelve launches');
    const firstBatch=store.detail(first);
    const queued=firstBatch.invocations.filter(i=>i.status==='prepared');
    assert.equal(queued.length,9);
    assert(queued.every(i=>!i.dispatchStarted && i.acceptance==='unknown'));
    assert.equal(firstBatch.consumptions.length,12);
    send(second,names.slice(0,2));send(different,['codex']);engine.kick();
    await until(()=>calls.length===5,'reserved account slot and independent account');
    assert.equal(calls.filter(c=>c.account.id===sameAccount).length,4);
    assert.equal(calls.filter(c=>c.conversationId===first).length,3);
    assert.equal(calls.filter(c=>c.conversationId===second).length,1);
    assert.equal(calls.filter(c=>c.conversationId===different).length,1);
    const last=queued.at(-1)!;engine.cancel(last.id);
    assert.equal(store.invocation(last.id).status,'cancelled');assert(!store.invocation(last.id).dispatchStarted);
    const live=calls.find(c=>c.conversationId===first)!;engine.cancel(live.invocationId);
    assert(live.signal.aborted);engine.kick();await delay(25);assert.equal(calls.length,5);
    waiting.get(live.invocationId)!();
    await until(()=>calls.length===6,'carrier exit frees one slot');
    assert.equal(calls.at(-1)?.conversationId,first);
    const pending=store.invocations().filter(i=>i.status==='prepared');
    assert(pending.length>0);
    const changed=pending.find(i=>i.conversationId===first)!;
    const otherAccount={...store.accountFor(changed.id),id:'alt-frozen',name:'备用账户'};
    store.saveAccount(otherAccount);store.saveMember({...changed.member,accountId:otherAccount.id,accountBinding:'override'});
    stopOnAbort=true;await engine.stop();owner.close();
    owner=new Store(database);store=new CollaborationStore(owner,{workspace:dir});
    assert(pending.every(i=>store.invocation(i.id).status==='prepared' && !store.invocation(i.id).dispatchStarted));
    finishImmediately=true;engine=new CollaborationEngine(store,runtime,{workspace:dir});engine.start();
    await until(()=>pending.every(i=>store.invocation(i.id).status==='succeeded'),'original prepared invocations finish after restart');
    assert.equal(calls.find(c=>c.invocationId===changed.id)?.account.id,sameAccount);
    assert(!calls.some(c=>c.invocationId===last.id));assert.equal(new Set(calls.map(c=>c.invocationId)).size,calls.length);
    assert(pending.every(i=>store.invocation(i.id).teardown==='confirmed' && store.invocation(i.id).acceptance==='accepted'));
  } finally {
    stopOnAbort=true;finishImmediately=true;for(const release of waiting.values())release();
    await engine.stop();owner.close();rmSync(dir,{recursive:true,force:true});
  }
});
