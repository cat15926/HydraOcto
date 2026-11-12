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
  const g=group(ids,root.id).group;assert.equal(g.targets.length,12);end(host.id);
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
  end(s.id,mark);assert(!JSON.stringify(store.detail(cid)).includes(mark));
 }finally{owner.close();rmSync(path,{recursive:true,force:true});}
});
