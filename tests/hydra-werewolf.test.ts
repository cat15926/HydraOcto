import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {ExecutionContractSnapshot} from '../shared/collaboration.js';
import type {Obligation} from '../shared/obligations.js';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';
import {newGame,registerAction,settlePhase,type Game} from '../server/collaboration/werewolf.js';

const ids=Array.from({length:12},(_,i)=>'seat'+i);
function board(){
 const g=newGame('g','r','host','h',ids.map(memberId=>({memberId,instance:memberId+'i'})));
 const roles=['wolf','wolf','wolf','wolf','villager','villager','villager','villager','seer','witch','hunter','idiot'] as const;
 g.players.forEach((p,i)=>{p.role=roles[i]!;});
 return g;
}
function all(game:Game,choices:(id:number)=>Record<string,unknown>){
 game.players.forEach((p,n)=>{if(p.alive&&!(game.phase==='vote'&&p.revealed))registerAction(game,p,'inv-'+game.epoch+'-'+n,{epoch:game.epoch,...choices(n)});});
 return settlePhase(game);
}
const night=(wolfTarget:number,witch:Record<string,unknown>={},hunter:Record<string,unknown>={})=>(i:number)=>
 i<4?{target:ids[wolfTarget]}:i===8?{target:ids[0]}:i===9?witch:i===10?hunter:{};
const talk=(g:Game)=>all(g,i=>({stance:'suspect',target:g.players.find(s=>s.alive&&s.memberId!==ids[i])!.memberId}));
const vote=(g:Game,pick:number)=>all(g,i=>({target:i===pick?ids.find(id=>id!==ids[pick]&&g.players.find(p=>p.memberId===id)?.alive):ids[pick]}));

test('Standard role allocation, sealed observations, simultaneous potion and gun decisions',()=>{
 const g=board(),seer=g.players[8]!;
 assert.throws(()=>registerAction(g,g.players[9]!,'witch',{epoch:1,saveIf:[ids[9]]}));
 assert.throws(()=>registerAction(g,g.players[0]!,'wolf',{epoch:1,target:ids[1]}));
 assert.throws(()=>registerAction(g,g.players[4]!,'civilian',{epoch:1,target:ids[0]}));
 const receipt=registerAction(g,seer,'inv-1-8',{epoch:1,target:ids[0]});
 assert.equal(receipt.investigations![0]!.wolf,true);
 assert.equal(registerAction(g,seer,'inv-1-8',{epoch:1,target:ids[0]}).investigations!.length,1);
 assert.throws(()=>registerAction(g,seer,'inv-1-8',{epoch:1,target:ids[1]}));
 assert.throws(()=>settlePhase(g));
 const day=all(g,night(10,{saveIf:[ids[10]],poison:ids[2]},{shoot:ids[1]}));
 assert(g.players.every(p=>p.alive));assert.equal(g.antidote,false);assert.equal(g.poison,true);
 assert(!JSON.stringify(day).includes(receipt.investigations![0]!.seal));
 talk(g);vote(g,11);
 assert(g.players[11]!.alive&&g.players[11]!.revealed);
 all(g,night(10,{poison:ids[10]},{shoot:ids[1]}));
 assert(!g.players[10]!.alive&&g.players[1]!.alive);assert.equal(g.poison,false);
 talk(g);
 assert.throws(()=>registerAction(g,g.players[11]!,'late',{epoch:g.epoch,target:ids[0]}));
 vote(g,11);assert(!g.players[11]!.alive);
});
test('Public debate reflects signed choices, tied votes do not exile, hunter shot and both terminal edges',()=>{
 const g=board();
 all(g,night(10,{}, {shoot:ids[0]}));
 assert(!g.players[0]!.alive&&!g.players[10]!.alive);
 talk(g);assert(g.history.some(t=>t.includes('怀疑')));
 const alive=g.players.filter(p=>p.alive);
 all(g,i=>({target:alive[(alive.findIndex(p=>p.memberId===ids[i])+1)%alive.length]!.memberId}));
 assert(g.history.some(t=>t.includes('平票')));assert.equal(g.players.filter(s=>s.alive).length,10);
 // Terminal fixtures retain the full twelve-seat deal and exercise each edge.
 for(const goal of ['wolves','villagers','gods']){
  const p=board();p.phase='vote';
  const side=p.players.filter(s=>goal==='wolves'?s.role==='wolf':goal==='villagers'?s.role==='villager':s.role!=='wolf'&&s.role!=='villager');
  side.slice(1).forEach(s=>s.alive=false);
  const state=vote(p,p.players.indexOf(side[0]!));
  assert.equal(state.winner,goal==='wolves'?'好人胜利':'狼人胜利');assert.equal(state.phase,'finished');
  assert.throws(()=>settlePhase(p));
 }
});
test('Frozen room authorizations protect old sources, collector, public projections and early delivery',()=>{
 const path=mkdtempSync(join(tmpdir(),'hydra-game-contract-')),owner=new Store(join(path,'state.sqlite'));
 try{
  const store=new CollaborationStore(owner),template=store.members().find(m=>m.id==='claude')!;
  for(const id of ids)store.saveMember({...template,id,name:id});
  const cid=store.create({title:'标准局',memberIds:['claude',...ids],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
  const post=()=>store.send(cid,{requestId:randomUUID(),content:'请本房十二位参赛成员完成标准局。'});
  const start=()=>{const r=store.admitNext()?.invocations;assert(r?.length);for(const i of r){store.startInvocation(i.id);store.recordEvidence(i.id,{kind:'accepted',detail:{}});}return r;};
  const end=(id:string,text='已登记')=>{store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});store.finish(id,'succeeded',text);};
  const tools=(c:ExecutionContractSnapshot)=>runtimeTools(c).map(t=>t.name);
  post();
  const old=JSON.parse(String(store.db.prepare('SELECT value FROM cc_sources LIMIT 1').get()!.value));delete old.roomRuleTurn;
  store.db.prepare('UPDATE cc_sources SET value=? WHERE id=?').run(JSON.stringify(old),old.id);
  const legacy=start()[0]!;assert(!tools(store.contract(legacy.id)).includes('game_open'));end(legacy.id);
  post();const host=start()[0]!,contract=store.contract(host.id);
  assert(tools(contract).includes('game_open'));assert(!tools({...contract,roomRuleTurn:undefined}).includes('game_open'));
  const root=(store.obligations.tool(host.id,'obligation_open',{goal:'标准局'},'open') as {obligation:Obligation}).obligation;
  const group=(targets:string[],obligationId?:string)=>store.cooperation.createGroup(cid,{requestId:randomUUID(),question:'按本房规则独立行动',targets,...(obligationId&&{obligationId})},host.id);
  assert.throws(()=>group(ids));assert.throws(()=>group(ids,root.id));
  store.werewolf.tool(host.id,'game_open',{obligationId:root.id});
  assert.throws(()=>store.obligations.tool(host.id,'obligation_deliver',{obligationId:root.id,summary:'结束'},'early'));
  const g=group(ids,root.id).group;assert.equal(g.targets.length,12);
  const ttl=Date.parse(g.deadline)-Date.parse(g.createdAt);
  assert(ttl>=24*60_000&&ttl<=24*60_000+100);
  end(host.id);
  const runs=start(),game=store.werewolf.get(root.id,cid)!;
  const seer=game.players.find(s=>s.role==='seer')!,s=runs.find(i=>i.memberId===seer.memberId)!;
  const target=game.players.find(p=>p!==seer)!.memberId;
  assert.deepEqual(tools(store.contract(s.id)).toSorted(),['game_act','game_read']);
  const seen=store.werewolf.tool(s.id,'game_act',{epoch:1,target});
  assert('investigations' in seen&&seen.investigations?.length===1);
  const mark=seen.investigations[0]!.seal;
  const other=runs.find(i=>i.id!==s.id)!;
  assert(!JSON.stringify(store.werewolf.tool(other.id,'game_read',{})).includes(mark));
  assert.throws(()=>store.werewolf.tool(other.id,'game_settle',{epoch:1}));
  assert.throws(()=>store.visibility.assertTool(s.id,'collaboration_request'));
  for(const kind of ['diagnostic','tool'] as const)store.recordEvidence(s.id,{kind,detail:{text:mark,args:{secret:mark}}});
  // The seer signed before its process failed. Only the original immutable choice
  // may be acknowledged on a new accepted execution; the old response remains failed.
  store.recordEvidence(s.id,{kind:'process_exit',detail:{confirmed:true,code:143}});
  store.finish(s.id,'failed',mark);
  for(const run of runs.filter(i=>i.id!==s.id)){
   const p=game.players.find(p=>p.memberId===run.memberId)!;
   const target=p.role==='wolf'?game.players.find(s=>s.role!=='wolf')!.memberId:undefined;
   store.werewolf.tool(run.id,'game_act',{epoch:1,...(target&&{target})});
   end(run.id);
  }
  store.cooperation.groupTick();
  assert(!JSON.stringify(store.detail(cid)).includes(mark));
  const resumed=start()[0]!;
  const state=store.werewolf.tool(resumed.id,'game_read',{obligationId:root.id});
  assert('missing' in state);assert.deepEqual(state.missing,[seer.memberId]);
  assert.throws(()=>store.werewolf.tool(resumed.id,'game_settle',{obligationId:root.id,epoch:1}));
  const repair=(targets:string[])=>store.cooperation.createGroup(cid,{requestId:randomUUID(),question:'核实本席原先决定',targets,obligationId:root.id},resumed.id);
  assert.throws(()=>repair([other.memberId]));
  assert.deepEqual(repair([seer.memberId]).group.targets,[seer.memberId]);end(resumed.id);
  const retry=start()[0]!,view=store.werewolf.tool(retry.id,'game_read',{});
  assert('reaffirm' in view&&view.reaffirm);
  const different=game.players.find(p=>p.memberId!==seer.memberId&&p.memberId!==target)!.memberId;
  assert.throws(()=>store.werewolf.tool(retry.id,'game_act',{epoch:1,target:different}));
  for(let replay=0;replay<2;replay++)store.werewolf.tool(retry.id,'game_act',{epoch:1,confirmPrior:true});
  end(retry.id);store.cooperation.groupTick();
  const judge=start()[0]!;
  store.werewolf.tool(judge.id,'game_settle',{epoch:1,obligationId:root.id});
  const final=store.werewolf.get(root.id,cid)!;
  assert.equal(final.investigations.length,1);assert.equal(final.investigations[0]!.seal,mark);
  assert.equal(final.actions.filter(a=>a.epoch===1).length,12);
  const entry=final.actions.find(a=>a.by===seer.memberId)!;
  assert.equal(entry.invocation,retry.id);assert.deepEqual(entry.previousInvocations,[s.id]);
  assert.equal(store.invocation(s.id).status,'failed');
  const responsibility=store.obligations.list(cid)[0]!;
  responsibility.groupCount=32;
  store.db.prepare('UPDATE cc_obligations SET value=? WHERE id=?').run(JSON.stringify(responsibility),root.id);
  const dayTargets=final.players.filter(s=>s.alive).map(s=>s.memberId);
  assert.throws(()=>store.cooperation.createGroup(cid,{requestId:randomUUID(),question:'获取白天意见',obligationId:root.id,targets:dayTargets},judge.id));
  const blocked=store.obligations.list(cid)[0]!;
  assert.equal(blocked.state,'blocked');assert.equal(blocked.owner.instanceId,root.owner.instanceId);
  assert.equal(store.cooperation.groups(cid).length,2);assert.equal(store.admitNext(),undefined);
 }finally{owner.close();rmSync(path,{recursive:true,force:true});}
});

test('A released player who only read must return one failure and be re-invited by the exact owner before counting one successful action', async()=>{
 const {inspectFailedPlayer,verifyPlayerRecovery}=await import('../scripts/hydra-werewolf-recovery.mjs');
 const path=mkdtempSync(join(tmpdir(),'hydra-game-release-')),owner=new Store(join(path,'state.sqlite'));
 try{
  const store=new CollaborationStore(owner),template=store.members().find(m=>m.id==='claude')!;
  for(const id of ids)store.saveMember({...template,id,name:id});
  const cid=store.create({title:'重启分支',memberIds:['claude',...ids],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
  const calls:{id:string;room:string;member:string;session:string;pid:number;spawn:number;exit?:number;end?:number;tools:Record<string,unknown>[]}[]=[];
  const start=()=>{
   const runs=store.admitNext()?.invocations;assert(runs?.length);
   for(const r of runs){
    store.startInvocation(r.id);
    const pid=calls.length+100,session=r.id;
    store.recordEvidence(r.id,{kind:'prepared',detail:{pid}});
    store.recordEvidence(r.id,{kind:'session',detail:{nativeSessionId:session,continuity:'fresh'}});
    store.recordEvidence(r.id,{kind:'accepted',detail:{nativeSessionId:session}});
    if(store.contract(r.id).roomRuleTurn?.kind==='player')store.recordEvidence(r.id,{kind:'diagnostic',detail:{observation:'game_player_tools'}});
    calls.push({id:r.id,room:cid,member:r.memberId,session,pid,spawn:1,tools:[]});
   }
   return runs;
  };
  const trace=(id:string)=>calls.find(c=>c.id===id)!;
  const end=(id:string,success=true)=>{
   trace(id).end=trace(id).exit=success?100:300_001;
   store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:success?0:143}});
   store.finish(id,success?'succeeded':'failed',success?'完成':'原生进程超时');
  };
  store.send(cid,{requestId:randomUUID(),content:'请本房十二位参赛成员完成标准局。'});
  const host=start()[0]!,root=(store.obligations.tool(host.id,'obligation_open',{goal:'完成本局'},'open') as {obligation:Obligation}).obligation;
  store.werewolf.tool(host.id,'game_open',{obligationId:root.id});
  const invite=(id:string,targets:string[])=>{
   const group=store.cooperation.createGroup(cid,{requestId:randomUUID(),question:'请各席签发决定',targets,obligationId:root.id},id).group;
   trace(id).tools.push({name:'multi_mention',ok:true,group:group.id,obligation:root.id,targets});
   return group;
  };
  const original=invite(host.id,ids);end(host.id);
  const seats=start(),play=()=>store.werewolf.get(root.id,cid)!;
  const missing=seats.find(r=>r.memberId===play().players.find(p=>p.role==='villager')!.memberId)!;
  store.werewolf.tool(missing.id,'game_read',{});trace(missing.id).tools.push({name:'game_read',ok:true});end(missing.id,false);
  const audit=store.detail(cid),contract=store.contract(missing.id),run=store.invocation(missing.id);
  const input={mode:'--restart',run,contract,game:play(),groups:audit.groups,evidence:audit.evidence,call:trace(missing.id)};
  const attempt=inspectFailedPlayer(input);
  assert.equal(attempt.exitCode,143);assert.equal(attempt.group,original.id);
  for(const changes of [{mode:'--normal'},{run:{...run,teardown:'unknown'}},{run:{...run,status:'interrupted'}},
   {run:{...run,cancelRevision:1}},{contract:{...contract,roomRuleTurn:{kind:'host'}}},
   {call:{...input.call,tools:[{name:'game_act',ok:false}]}},
   {game:{...input.game,actions:[{epoch:1,by:missing.memberId,invocation:missing.id}]}},
   {groups:[]},{evidence:input.evidence.filter(e=>e.kind!=='process_exit')}])assert.throws(()=>inspectFailedPlayer({...input,...changes}));
  assert.equal(store.obligations.list(cid)[0]!.activeGroupId,original.id);
  const act=(id:string)=>{
   const g=play(),p=g.players.find(p=>p.memberId===store.invocation(id).memberId)!;
   const target=p.role==='wolf'?g.players.find(s=>s.role==='villager')!.memberId:p.role==='seer'?g.players.find(s=>s!==p)!.memberId:undefined;
   store.werewolf.tool(id,'game_act',{epoch:1,...(target&&{target})});
   trace(id).tools.push({name:'game_act',epoch:1,ok:true});
  };
  for(const s of seats.filter(r=>r.id!==missing.id)){act(s.id);end(s.id);}
  store.cooperation.groupTick();store.cooperation.groupTick();
  const resumed=start()[0]!,read=store.werewolf.tool(resumed.id,'game_read',{obligationId:root.id});
  assert('missing' in read);assert.deepEqual(read.missing,[missing.memberId]);
  trace(resumed.id).tools.push({name:'game_read',ok:true,epoch:1,missing:read.missing});
  assert.throws(()=>store.werewolf.tool(resumed.id,'game_settle',{epoch:1,obligationId:root.id}));
  const repair=invite(resumed.id,read.missing);end(resumed.id);
  const replacement=start()[0]!;act(replacement.id);act(replacement.id);end(replacement.id);
  store.cooperation.groupTick();const judge=start()[0]!;
  store.werewolf.tool(judge.id,'game_settle',{epoch:1,obligationId:root.id});
  const details=store.detail(cid),game=play();
  assert.equal(game.epoch,2);assert.equal(game.actions.length,12);
  const verify=(overrides={})=>verifyPlayerRecovery(attempt,{details,game,calls,contractFor:(id:string)=>store.contract(id),...overrides});
  const recovered=verify();assert.equal(recovered.repairGroup,repair.id);assert.equal(recovered.replacement,replacement.id);
  const consumed=details.consumptions.find(c=>c.sourceId===recovered.wake)!;
  assert.throws(()=>verify({details:{...details,consumptions:[...details.consumptions,consumed]}}));
  assert.throws(()=>verify({details:{...details,groups:details.groups.filter(g=>g.id!==repair.id)}}));
  assert.throws(()=>verify({calls:calls.filter(c=>c.id!==replacement.id)}));
  assert.throws(()=>verify({game:{...game,actions:[...game.actions,game.actions.find(a=>a.by===missing.memberId)!]}}));
 }finally{owner.close();rmSync(path,{recursive:true,force:true});}
});
