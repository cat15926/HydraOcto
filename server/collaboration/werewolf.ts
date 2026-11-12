import { randomInt, randomUUID } from 'node:crypto';
import { AppError, canonical } from '../store.js';
import type { RoomCollectionAuthorization } from './room-rules.js';
import type { CollaborationStore } from './store.js';
import type { RoomRuleTurn, RuntimeEvent } from '../../shared/collaboration.js';

// Twelve-seat seer, witch, hunter and idiot game. The referee asks the room to
// participate through ordinary collaboration tools. These rules never dispatch.
export const rules = '12人预女猎白，无警长，4狼4民4神，屠边。狼投票取最高票，同票取最小座次。预言家每夜查一位他人。女巫两药各一瓶，不能自救或同夜双药；可对各可能刀口预先选择是否救、否则是否毒。猎人预选自己当次出局的枪口，可不开枪，中毒不开枪。白痴首次被放逐翻牌存活，失去投票权。白天讨论后公开投票，最高平票不放逐。狼全灭好人胜，民或神全灭狼人胜。';
type Role='wolf'|'villager'|'seer'|'witch'|'hunter'|'idiot';
type Phase='night'|'discuss'|'vote'|'finished';
type Stance='suspect'|'defend'|'uncertain'|'claim_good'|'claim_wolf';
const labels:Record<Stance,string>={suspect:'怀疑',defend:'倾向相信',uncertain:'希望再观察',claim_good:'声称查验为好人',claim_wolf:'声称查验为狼人'};
type Action={target?:string;stance?:Stance;saveIf?:string[];poison?:string;shoot?:string};
interface Seat { memberId:string; instance:string; role:Role; alive:boolean; revealed?:boolean }
interface PhaseActions { epoch:number; by:string; invocation:string; action:Action; publicText:string }
export interface Game {
 id:string; room:string; host:string; hostInstance:string; players:Seat[]; phase:Phase; day:number; epoch:number; antidote:boolean; poison:boolean;
 actions:PhaseActions[]; history:string[]; investigations:{seer:string;target:string;wolf:boolean;seal:string;epoch:number}[]; winner?:string;
}
const bad=(message:string):never=>{throw new AppError(409,message,'room_rules_conflict');};
export function newGame(id:string,room:string,host:string,hostInstance:string,players:{memberId:string;instance:string}[]):Game{
 if(players.length!==12||new Set(players.map(s=>s.memberId)).size!==12)bad('需要十二位不同的参赛成员。');
 const roles:Role[]=['wolf','wolf','wolf','wolf','villager','villager','villager','villager','seer','witch','hunter','idiot'];
 for(let i=roles.length-1;i>0;i--){const j=randomInt(i+1);[roles[i],roles[j]]=[roles[j]!,roles[i]!];}
 return {id,room,host,hostInstance,players:players.map((s,i)=>({...s,alive:true,role:roles[i]!})),day:1,epoch:1,phase:'night',antidote:true,poison:true,actions:[],investigations:[],history:['标准局开局。']};
}
function living(g:Game){return g.players.filter(s=>s.alive);}
function needed(g:Game){return living(g).filter(s=>g.phase!=='vote'||!s.revealed);}
function current(g:Game){return g.actions.filter(a=>a.epoch===g.epoch);}
function publicState(g:Game){return {gameId:g.id,epoch:g.epoch,phase:g.phase,day:g.day,rules,alive:living(g).map(s=>s.memberId),eligible:needed(g).map(s=>s.memberId),history:g.history,...(g.winner&&{winner:g.winner})};}
function privateState(g:Game,s:Seat){
 const observations=g.investigations.filter(o=>o.seer===s.memberId);
 return {...publicState(g),yourRole:s.role,...(s.role==='wolf'&&{wolves:g.players.filter(x=>x.role==='wolf').map(x=>x.memberId)}),
 ...(s.role==='seer'&&{investigations:observations}),...(s.role==='witch'&&{antidote:g.antidote,poison:g.poison}),
 submitted:current(g).some(a=>a.by===s.memberId),yourAction:current(g).find(a=>a.by===s.memberId)?.action};
}
export function registerAction(g:Game,s:Seat,invocation:string,input:Record<string,unknown>){
 if(g.phase==='finished'||!needed(g).includes(s)||input.epoch!==g.epoch)bad('请重新读取本局阶段和可行动成员。');
 const action:Action={};
 const target=(value:unknown,others=true)=>{const found=living(g).find(t=>t.memberId===value&&(!others||t!==s));if(!found) return bad('请选择符合房规的存活目标。');return found;};
 const allowed=['epoch'];
 if(g.phase==='discuss'){
  allowed.push('target','stance');if(typeof input.stance!=='string'||!Object.hasOwn(labels,input.stance))bad('请选择公开观点。');
  action.stance=input.stance as Stance;action.target=target(input.target).memberId;
 }else if(g.phase==='vote'||s.role==='wolf'||s.role==='seer'){
  allowed.push('target');const t=target(input.target);
  if(g.phase==='night'&&s.role==='wolf'&&t.role==='wolf')bad('本局夜袭对象必须是其他阵营成员。');
  action.target=t.memberId;
 }else if(s.role==='witch'){
  allowed.push('saveIf','poison');const ids=input.saveIf??[];
  if(!Array.isArray(ids)||ids.length>11||new Set(ids).size!==ids.length||(!g.antidote&&ids.length))return bad('解药选择无效。');
  action.saveIf=ids.map(v=>target(v).memberId).sort();
  if(input.poison){if(!g.poison)bad('毒药已用完。');action.poison=target(input.poison).memberId;}
 }
 if(s.role==='hunter'&&g.phase!=='discuss'){allowed.push('shoot');if(input.shoot)action.shoot=target(input.shoot).memberId;}
 if(Object.keys(input).some(k=>!allowed.includes(k)))bad('当前阶段不能使用这些动作字段。');
 const prior=current(g).find(a=>a.by===s.memberId);
 if(prior&&canonical(prior.action)!==canonical(action))bad('本阶段已登记了另一个决定。');
 if(!prior){
  g.actions.push({epoch:g.epoch,by:s.memberId,invocation,action,publicText:g.phase==='discuss'?s.memberId+'：'+labels[action.stance!]+' '+action.target+'。':'本席行动已登记。'});
  if(g.phase==='night'&&s.role==='seer')g.investigations.push({seer:s.memberId,target:action.target!,wolf:target(action.target).role==='wolf',seal:randomUUID(),epoch:g.epoch});
 }
 return privateState(g,s);
}
function mostVotes(g:Game,votes:string[],breakTie:boolean){
 const counts=living(g).map(s=>({s,n:votes.filter(v=>v===s.memberId).length})).sort((a,b)=>b.n-a.n);
 return counts[0]?.n&&(breakTie||counts[0].n!==counts[1]?.n)?counts[0].s:undefined;
}
export function settlePhase(g:Game){
 const actions=current(g);
 if(g.phase==='finished'||!needed(g).every(s=>actions.some(a=>a.by===s.memberId)))bad('当前阶段尚未收齐有效行动。');
 const action=(s:Seat)=>actions.find(a=>a.by===s.memberId)?.action;
 const initial=living(g),prefix='第'+g.day;
 const remove=(seat:Seat,canShoot:boolean)=>{seat.alive=false;const shot=canShoot&&seat.role==='hunter'&&action(seat)?.shoot;
  const t=shot&&living(g).find(s=>s.memberId===shot);if(t){t.alive=false;g.history.push('猎人开枪，'+t.memberId+' 出局。');}};
 if(g.phase==='night'){
  const attackers=initial.filter(s=>s.role==='wolf');
  const victim=mostVotes(g,attackers.map(s=>action(s)!.target!),true)!;
  const witch=initial.find(s=>s.role==='witch'),plan=witch&&action(witch);
  const saved=g.antidote&&plan?.saveIf?.includes(victim.memberId);
  const poisoned=!saved&&g.poison&&plan?.poison&&initial.find(s=>s.memberId===plan.poison);
  if(saved)g.antidote=false;
  if(poisoned){g.poison=false;remove(poisoned,false);}
  if(!saved&&victim.alive)remove(victim,true);
  const deaths=initial.filter(s=>!s.alive);g.history.push(prefix+'夜结束。'+(deaths.length?'出局：'+deaths.map(s=>s.memberId).join('、'):'平安夜。'));g.phase='discuss';
 }else if(g.phase==='discuss'){
  g.history.push(prefix+'天讨论。'+actions.map(a=>a.publicText).join(' '));g.phase='vote';
 }else{
  const out=mostVotes(g,actions.map(a=>a.action.target!),false);
  g.history.push(prefix+'天投票。'+actions.map(a=>a.by+'→'+a.action.target).join('，'));
  if(out?.role==='idiot'&&!out.revealed){out.revealed=true;g.history.push(out.memberId+' 白痴翻牌，存活并失去投票权。');}
  else if(out){remove(out,true);g.history.push(out.memberId+' 被放逐。');}
  else g.history.push('平票，本轮无人放逐。');
  g.phase='night';g.day++;
 }
 g.epoch++;
 const alive=living(g);
 if(!alive.some(s=>s.role==='wolf'))g.winner='好人胜利';
 else if(!alive.some(s=>s.role==='villager')||!alive.some(s=>s.role!=='wolf'&&s.role!=='villager'))g.winner='狼人胜利';
 if(g.winner){g.phase='finished';g.history.push(g.winner);}
 return publicState(g);
}

export function gameTools(kind:RoomRuleTurn['kind']) {
 const field={type:'string',minLength:1},epoch={type:'integer',minimum:1};
 const spec=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
 if(kind==='host')return [
  spec('game_open','Open or recover a standard twelve-seat game on your own existing main obligation. Only public facts are returned. The referee manages invitations through multi_mention, passing obligationId and eligible members, then ends the turn until replies arrive.',{obligationId:field},['obligationId']),
  spec('game_read','Read public game history, current epoch, and eligible or missing participants on your own obligation.',{obligationId:field},['obligationId']),
  spec('game_settle','Confirm the current epoch only after the actual signed decisions and terminal executions are available. Returns the public result, next epoch, eligible players and any winner. You decide on the next invitation or final delivery. Include the returned winner label verbatim in the final summary.',{obligationId:field,epoch},['obligationId','epoch'])
 ];
 return [
  spec('game_read','Read your seat, role, permitted observations, public history and current epoch. No input is needed.',{},[]),
  spec('game_act','Register your own choice in the epoch from game_read. Send only applicable fields: at night wolf/seer must choose target, witch may send saveIf (list excluding self) or poison, hunter may preselect shoot, others send only epoch. During discuss send target and stance; during vote send target (hunter may also send shoot). Use exact living member IDs, exclude yourself. A successful receipt commits your action: end your turn.',{epoch,target:field,stance:{type:'string',enum:Object.keys(labels)},saveIf:{type:'array',items:field,maxItems:11},poison:field,shoot:field},['epoch'])
 ];
}

// Public evidence may retain process and input identities; free-form native output and
// tool arguments can contain a private role, even when the member promises to hide it.
export function playerEvidence(event:RuntimeEvent):RuntimeEvent|undefined {
 const d=event.detail;
 if(event.kind==='diagnostic'&&d.observation==='game_player_tools')return {kind:'diagnostic',detail:{observation:'game_player_tools',tools:['mcp__platform__game_act','mcp__platform__game_read']}};
 if(!['prepared','exposed','session','accepted','not_accepted','process_exit','transport_settled','usage'].includes(event.kind))return;
 const safe:Record<string,unknown>={};
 for(const key of ['pid','characters','code','processStarted','confirmed','providerAcceptance','resumeRequested','inputTokens','outputTokens','cachedInputTokens'])if(typeof d[key]==='number'||typeof d[key]==='boolean')safe[key]=d[key];
 for(const key of ['nativeSessionId','nativeMessageId','responseId','manifestId','renderDigest','nativeTurnId'])if(typeof d[key]==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(d[key]))safe[key]=d[key];
 if(d.continuity==='fresh')safe.continuity='fresh';
 if(d.source==='platform_prompt'||d.source==='platform')safe.source=d.source;
 if(d.evidence==='assistant message'||d.evidence==='system.init'||d.evidence==='successful result')safe.evidence=d.evidence;
 return {kind:event.kind,detail:safe};
}
export class WerewolfRules {
 constructor(private readonly store:CollaborationStore){}
 get(id:string,cid:string){
  const row=this.store.db.prepare('SELECT value FROM cc_werewolf WHERE id=? AND conversation_id=?').get(id,cid) as {value:string}|undefined;
  return row?JSON.parse(row.value) as Game:undefined;
 }
 collection(id:unknown,cid:string,member:string):RoomCollectionAuthorization|undefined {
  if(typeof id!=='string')return;
  const g=this.get(id,cid);
  if(g&&g.host===member&&g.phase!=='finished')return {turn:{kind:'player',gameId:g.id,epoch:g.epoch},members:needed(g).map(s=>s.memberId),maxCollections:32};
 }
 assertDelivery(id:string,cid:string,summary:unknown){
  const g=this.get(id,cid);
  if(!g)return;
  if(!g.winner||g.phase!=='finished')return bad('本局尚未结算到胜负，不能提前交付。');
  if(typeof summary!=='string'||!summary.includes(g.winner))bad('请在最终交付里写明本局结算的胜方：'+g.winner+'。');
 }
 private save(g:Game){this.store.db.prepare('INSERT INTO cc_werewolf VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(g.id,g.room,JSON.stringify(g));}
 result(invocationId:string,status:string){
  const i=this.store.invocation(invocationId),t=this.store.contract(invocationId).roomRuleTurn;
  if(t?.kind!=='player')return;
  const g=this.get(t.gameId,i.conversationId),entry=g?.actions.find(a=>a.invocation===i.id&&a.epoch===t.epoch);
  return status==='succeeded'&&entry?entry.publicText:'本席未提交有效行动。';
 }
 tool(id:string,name:string,args:Record<string,unknown>){
  return this.store.artifacts.port.tx(()=>{
   const i=this.store.invocation(id),c=this.store.contract(id),cid=i.conversationId,t=c.roomRuleTurn;
   if(!t||!c.roomMember||!this.store.roomMembers.isCurrent(c.roomMember)||!c.coordinationPolicy||c.visibility||i.acceptance!=='accepted'||i.status!=='running'||i.cancelRevision)return bad('当前执行不具备本局的有效身份。');
   this.store.visibility.validateInvocation(id);
   if(t.kind==='player'){
    const g=this.get(t.gameId,cid);if(!g||g.epoch!==t.epoch) return bad('本阶段已结束。');
    const o=this.store.obligations.list(cid).find(o=>o.id===g.id);
    const seat=g.players.find(s=>s.memberId===i.memberId&&s.instance===c.roomMember!.id);
    if(!seat||!seat.alive||o?.state!=='waiting'||o.activeGroupId!==this.store.visibility.primary(id).groupId||o.owner.instanceId!==g.hostInstance)return bad('本席不具备当前行动权。');
    if(name==='game_read')return privateState(g,seat);
    if(name!=='game_act')return bad('本席不可执行该操作。');
    const previous=current(g).find(a=>a.by===seat.memberId);
    if(previous&&previous.invocation!==id){
      const old=this.store.invocation(previous.invocation);
      if(old.status==='succeeded'||old.teardown!=='confirmed')return bad('先前行动已有执行，不能代签。');
      previous.invocation=id;
    }
    const result=registerAction(g,seat,id,args);this.save(g);return result;
   }
   const {o}=this.store.obligations.authorize(id,args.obligationId);
   if(o.parentId||!(o.state==='open'||(o.state==='blocked'&&name==='game_read')))bad('本局须由原主委托负责人管理。');
   let g=this.get(o.id,cid);
   if(name==='game_open'&&!g){
    const players=this.store.workbench.conversation(cid).memberIds.filter(m=>m!==i.memberId).map(memberId=>({memberId,instance:this.store.roomMembers.resolve(cid,memberId).id}));
    g=newGame(o.id,cid,i.memberId,c.roomMember!.id,players);this.save(g);
   }
   if(!g||g.hostInstance!==c.roomMember!.id)return bad('本局与当前负责人不匹配。');
   if(name==='game_settle'&&args.epoch===g.epoch){
    if(current(g).some(a=>{const run=this.store.invocation(a.invocation);return run.status!=='succeeded'||run.teardown!=='confirmed'||run.cancelRevision;}))bad('尚有行动未确认成功退出。');
    settlePhase(g);this.save(g);
   }else if(name==='game_settle'&&args.epoch!==g.epoch-1)bad('请检查当前阶段。');
   else if(!['game_settle','game_read','game_open'].includes(name))bad('本轮不能调用该规则工具。');
   return {...publicState(g),missing:needed(g).filter(s=>!current(g!).some(a=>a.by===s.memberId)).map(s=>s.memberId)};
  });
 }
}

