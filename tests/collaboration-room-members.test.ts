import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Conversation, RoomCollaborationMode } from '../shared/collaboration.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { invokeClaude } from '../server/collaboration/runtime-claude.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { Store } from '../server/store.js';

const rid = randomUUID;
function room(store: CollaborationStore, collaborationMode?: RoomCollaborationMode) {
  return store.create({ title:'测试房间', memberIds:['claude','codex'], defaultMemberId:'claude', requestId:rid(), collaborationMode }).conversation;
}
function send(store: CollaborationStore, c: Conversation, content: string) {
  return store.send(c.id, {content, requestId:rid()}).source;
}
function end(store: CollaborationStore, id: string) {
  store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});
  store.finish(id, 'succeeded', 'OK');
}

test('A: schema 13 upgrades deterministically, preserves frozen old work through mode changes and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-room-migrate-')), db = join(dir,'state.db');
  let owner = new Store(db);
  try {
    let s = new CollaborationStore(owner);
    const c = room(s,'legacy'), old = send(s,c,'original-v13-source');
    const run = s.admitNext()!.invocations[0]!;
    s.startInvocation(run.id);
    const before = JSON.stringify(s.contract(run.id));
    const template = s.roomMembers.resolve(c.id,'claude');
    owner.db.prepare("UPDATE cc_conversations SET value=json_remove(value,'$.collaborationMode') WHERE id=?").run(c.id);
    owner.db.exec('DROP TABLE cc_room_members; UPDATE cc_schema SET version=13');
    owner.close(); owner=new Store(db); s=new CollaborationStore(owner);
    assert.equal(owner.db.prepare('SELECT version FROM cc_schema').get()!.version,17);
    assert.deepEqual(s.roomMembers.resolve(c.id,'claude'),template);
    assert.equal(s.detail(c.id).conversation.collaborationMode,undefined);
    assert.equal(s.detail(c.id).sources.length,1);
    assert.equal(s.detail(c.id).sources[0]!.id,old.id);
    assert.equal(s.obligations.list(c.id).length,0);
    assert.equal(JSON.stringify(s.contract(run.id)),before);
    s.setCollaborationMode(c.id,'continuous');
    const queued=send(s,c,'new-bound-work');
    assert.equal(s.detail(c.id).deliveries.find(d=>d.sourceId===queued.id)?.continuation,undefined);
    assert.equal(s.cooperation.canConsume(run,queued),false);
    s.setCollaborationMode(c.id,'legacy');
    s.recordEvidence(run.id,{kind:'accepted',detail:{}});
    end(s,run.id);
    const next=s.admitNext()!.invocations[0]!;
    assert.equal(next.roomMember?.id,template.id);
    assert.equal(s.contract(next.id).obligationPolicy,true);
    assert.equal(s.detail(c.id).sources.find(row=>row.id===queued.id)!.roomPolicy,'instance-v1');
    owner.close(); owner=new Store(db); s=new CollaborationStore(owner);
    assert.deepEqual(s.roomMembers.resolve(c.id,'claude'),template);
    assert.equal(s.contract(next.id).roomMember?.id,template.id);
  } finally { owner.close(); await rm(dir,{recursive:true,force:true}); }
});

test('A: rejoining creates a distinct generation; late A2A failure cannot reach the replacement', () => {
  const owner = new Store(':memory:'); const s = new CollaborationStore(owner);
  try {
    const c = room(s), first = s.roomMembers.resolve(c.id,'claude');
    send(s,c,'delegate'); const agent = s.admitNext()!.invocations[0]!;
    s.startInvocation(agent.id); s.recordEvidence(agent.id,{kind:'accepted',detail:{}});
    const work = s.requestCollaboration(agent.id, rid(), {targets:['codex'],content:'review this'});
    end(s,agent.id);
    const reviewer=s.admitNext()!.invocations[0]!;
    s.startInvocation(reviewer.id);
    s.updateConversation(c.id,{memberIds:['codex'],defaultMemberId:'codex'});
    assert.equal(s.roomMembers.isCurrent(first),false);
    s.updateConversation(c.id,{memberIds:['codex','claude'],defaultMemberId:'claude'});
    const current=s.roomMembers.resolve(c.id,'claude');
    assert.equal(current.generation,first.generation+1);
    assert.notEqual(current.id,first.id);
    assert.throws(()=>s.recordEvidence(agent.id,{kind:'accepted',detail:{}}), /房间成员已变化/);
    s.recordEvidence(reviewer.id,{kind:'process_exit',detail:{confirmed:true}});
    s.finish(reviewer.id,'failed','fixture review failure');
    assert.ok(s.detail(c.id).sources.find(row=>row.id===work.sourceId));
    assert.equal(s.detail(c.id).sources.filter(row=>row.kind==='a2a_failure').length,0);
    assert.equal(s.admitNext(),undefined);
  } finally { owner.close(); }
});

async function waitFor(condition: () => boolean, description: string) {
  for(let i=0;i<400;i++) { if(condition()) return; await delay(20); }
  throw new Error('Timed out waiting for '+description);
}

test('A: actual Claude protocol adapter launches two independent fixture processes; stopping A preserves B', async () => {
  const dir=await mkdtemp(join(tmpdir(),'hydra-room-process-'));
  const owner=new Store(':memory:'), s=new CollaborationStore(owner,{workspace:dir});
  const command=join(dir,'fixture.cjs');
  // The executable emits the documented CLI stream protocol. No model or subscription is used.
  await writeFile(command, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const sid=process.argv[process.argv.indexOf('--session-id')+1];
let input=''; process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  const room=input.includes('ONLY-ROOM-ALPHA')?'A':'B';
  fs.writeFileSync(path.join(process.cwd(),room+'.json'),JSON.stringify({pid:process.pid,sid,input}));
  const emit=message=>console.log(JSON.stringify({...message,session_id:sid}));
  emit({type:'system',subtype:'init'});
  emit({type:'assistant',uuid:'fixture',message:{id:'receipt',content:[{type:'text',text:'received'}]}});
  const timer=setInterval(()=>{
    if(!fs.existsSync(path.join(process.cwd(),'finish-'+room)))return;
    clearInterval(timer);emit({type:'result',subtype:'success',is_error:false,result:'finished '+room});
  },20);
});`,{mode:0o700});
  const engine=new CollaborationEngine(s,{probe:async()=>[],invoke:r=>invokeClaude(r,command)},{workspace:dir});
  try {
    const a=room(s), b=room(s);
    for(const [c,content] of [[a,'ONLY-ROOM-ALPHA'],[b,'ONLY-ROOM-BETA']] as const) {
      s.send(c.id,{privateTo:['claude'],content,requestId:rid()});
    }
    engine.start();
    await waitFor(()=>s.invocations().filter(i=>i.acceptance==='accepted').length===2,'both independent Claude child receipts');
    const ia=s.invocations(a.id)[0]!, ib=s.invocations(b.id)[0]!;
    assert.notEqual(ia.roomMember!.id,ib.roomMember!.id);
    assert.equal(s.contract(ia.id).obligationPolicy,undefined);
    assert.equal(s.contract(ib.id).obligationPolicy,undefined);
    const alpha=JSON.parse(await readFile(join(dir,'A.json'),'utf8'));
    const beta=JSON.parse(await readFile(join(dir,'B.json'),'utf8'));
    assert.notEqual(alpha.pid,beta.pid); assert.notEqual(alpha.sid,beta.sid);
    assert.match(alpha.input,/ONLY-ROOM-ALPHA/); assert.doesNotMatch(alpha.input,/ONLY-ROOM-BETA/);
    assert.match(beta.input,/ONLY-ROOM-BETA/); assert.doesNotMatch(beta.input,/ONLY-ROOM-ALPHA/);
    assert.throws(()=>s.recordEvidence(ia.id,{kind:'accepted',detail:{roomMemberId:ib.roomMember!.id}}),/身份不一致/);
    assert.throws(()=>s.recordEvidence(ia.id,{kind:'accepted',detail:{nativeSessionId:beta.sid}}),/会话不一致/);
    const count=s.detail(b.id).evidence.length;
    engine.cancel(ia.id);
    await waitFor(()=>s.invocation(ia.id).teardown==='confirmed' && s.invocation(ia.id).status==='cancelled','A exited');
    assert.equal(s.invocation(ib.id).status,'running');
    assert.equal(s.detail(b.id).evidence.length,count);
    process.kill(beta.pid,0);
    await writeFile(join(dir,'finish-B'),'done');
    await waitFor(()=>s.invocation(ib.id).status==='succeeded','B delivered');
    assert.equal(s.detail(b.id).responses[0]!.content,'finished B');
  } finally {await engine.stop();owner.close();await rm(dir,{recursive:true,force:true});}
});

test('A: a replacement instance cannot recover previous private messages, quoted material or private library memory', () => {
  const owner = new Store(':memory:'), s = new CollaborationStore(owner);
  try {
    const c=room(s), other=room(s);
    s.send(c.id,{content:'OLD_PRIVATE_MATERIAL',privateTo:['claude'],requestId:rid()});
    const run=s.admitNext()!.invocations[0]!;
    s.startInvocation(run.id);end(s,run.id);
    const original = s.visibility.messages(c.id)[0]!;
    const p=s.memory.propose(c.id,{requestId:rid(),key:'Private fact',content:'OLD_LIBRARY_PRIVATE',scope:'library',privateTo:['claude']}).result;
    s.memory.transition(p.version.id,{requestId:rid(),action:'approve',expectedRevision:1,expectedEntryRevision:1});
    s.memory.transition(p.version.id,{requestId:rid(),action:'materialize',expectedRevision:2,expectedEntryRevision:1});
    assert.equal(s.memory.current(c.id,'claude','private:claude').length,1);
    assert.equal(s.memory.current(other.id,'claude','private:claude').length,0);
    s.updateConversation(c.id,{memberIds:['codex'],defaultMemberId:'codex'});
    s.updateConversation(c.id,{memberIds:['codex','claude'],defaultMemberId:'claude'});
    assert.deepEqual(s.visibility.readable(c.id,'claude'),[]);
    assert.equal(s.memory.current(c.id,'claude').length,0);
    assert.throws(()=>s.send(c.id,{requestId:rid(),content:'reply',replyTo:original.id,privateTo:['claude']}),/私聊/);
    assert.match(JSON.stringify(s.visibility.export(c.id)),/OLD_PRIVATE_MATERIAL/);
    s.send(c.id,{content:'NEW_PRIVATE_MATERIAL',privateTo:['claude'],requestId:rid()});
    const after=s.admitNext()!.invocations[0]!;
    const {prompt}=s.prepareInput(after.id);
    assert.match(prompt,/NEW_PRIVATE_MATERIAL/);assert.doesNotMatch(prompt,/OLD_(?:LIBRARY_)?PRIVATE/);
  } finally {owner.close();}
});
