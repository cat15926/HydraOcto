// One ordinary request per game. Only actual members may manage collections and sign decisions.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {isolatedClaude} from './hydra-test-native.mjs';

const mode=process.argv[2];
assert(['--check-config','--normal','--restart'].includes(mode));
const base=resolve(process.env.VALIDATION_OUTPUT_DIR||tmpdir());
await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,'werewolf-')),workspace=join(dir,'workspace'),profile=join(dir,'cli');
await Promise.all([mkdir(workspace),mkdir(profile)]);
const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
const maxCalls=200,maxMinutes=70,deadline=Date.now()+maxMinutes*60_000;
if(mode==='--check-config'){console.log({mode,model:selected.model,maxCalls});process.exit(0);}
const calls=[], projections=[], observations=[], seals=new Set(), checks={};
const sourceDir=fileURLToPath(new URL('../',import.meta.url));
const sourceHash=createHash('sha256');
const paths=execFileSync('git',['ls-files','-z','server','shared','scripts/verify-hydra-werewolf-live.mjs','scripts/hydra-test-native.mjs','package-lock.json'],{cwd:sourceDir}).toString().split('\0').filter(Boolean);
for(const path of paths)sourceHash.update(path).update('\0').update(readFileSync(join(sourceDir,path)));
const source={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:sourceDir}).toString().trim(),sha256:sourceHash.digest('hex')};
const proof={passed:false,mode,model:selected.model,source,maxCalls,maxMinutes,checks,calls,userSubmissions:0,userAdvances:0};
const hash=value=>createHash('sha256').update(value).digest('hex');
const players=Array.from({length:12},(_,i)=>'seat'+String(i+1).padStart(2,'0'));
const roster=['host',...players];
const roomRequest='@主持 请组织其余十二名成员打一局标准十二人预女猎白，由你负责到终局。大家自主决定夜间行动、白天公开观点和投票，我全程旁观，不查看身份、查验原件，也不参与推进。按本房既定规则结算后，向我报告真实胜方和关键公开经过。';
const native=createCollaborationRuntime({privateRoots:[join(dir,'db')],timeoutMs:180_000});
let app,url,cid,sideId,sideMember,sideStart,restarted=false,pause=false,budgetStopped=false;
const reservations=new Set();
async function post(path,body){
 const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
 assert(response.ok,'HTTP '+response.status+' '+path+': '+(response.ok?'':await response.text()));
 return response.json();
}
async function anotherRoom(id){
 const room=await post('/api/conversations',{requestId:randomUUID(),title:'隔离并行会话',memberIds:[id],defaultMemberId:id});sideId=room.conversation.id;
 await post('/api/conversations/'+sideId+'/messages',{requestId:randomUUID(),content:'本房的公开展览主题为海洋。请说明你在本房能看到的材料，另一房的私有游戏查验若不可读则如实说明。'});
}
const runtime={...native,async invoke(req){
 assert(Date.now()<deadline&&calls.length<maxCalls,'Native budget exhausted');
 assert.equal(req.account.id,account.id);assert(!req.projectWork&&!req.projectReview&&req.cwd===workspace);
 const entry={id:req.invocationId,room:req.conversationId,member:req.member.id,start:Date.now(),tools:[]};
 calls.push(entry);projections.push({id:entry.id,member:entry.member,input:req.prompt,room:entry.room});
 let result;
 try {
  result=await native.invoke({...req,onEvent(event){
   if(event.kind==='prepared'&&event.detail.pid){entry.pid=event.detail.pid;entry.spawn=Date.now();}
   if(event.kind==='process_exit')entry.exit=Date.now();
   req.onEvent(event);
  },async onToolCall(name,args,key){
   const tool={name};entry.tools.push(tool);
   try {
    const out=await req.onToolCall(name,args,key);
    observations.push({room:entry.room,member:entry.member,data:JSON.stringify(out)??''});
    if(name.startsWith('game_')){
     tool.epoch=out.epoch;tool.phase=out.phase;
     if(name==='game_read'||name==='game_act'){
      for(const r of out.investigations??[])seals.add(r.seal);
      if(mode==='--restart'&&!sideStart&&out.yourRole==='seer'){
       sideMember=entry.member;sideStart=anotherRoom(sideMember);
       sideStart.catch(()=>{});
      }
      if(mode==='--restart'&&!restarted&&out.investigations?.length)pause=true;
     }
    }
    if(name==='multi_mention'){tool.group=out.group?.id;tool.targets=args.targets;tool.obligation=args.obligationId;}
    tool.ok=true;return out;
   }catch(e){tool.error=String(e.message).slice(0,280);throw e;}
  }});
  entry.session=result.nativeSessionId;return result;
 }catch(e){entry.error=String(e.message).slice(0,300);throw e;}
 finally{entry.end=Date.now();console.log('Execution',calls.indexOf(entry)+1,entry.member,entry.tools.map(t=>t.name+(t.error?'!':'' )).join(','),entry.error??'');}
}};
async function boot(){
 app=await createApplication({dataDir:join(dir,'db'),workspace,port:0,collaborationRuntime:runtime});
 const store=app.collaborationStore,launch=store.cooperation.canLaunch.bind(store.cooperation);
 store.cooperation.canLaunch=i=>{
  if((pause&&i.conversationId===cid&&i.memberId==='host')||!launch(i))return false;
  if(!reservations.has(i.id)&&reservations.size>=maxCalls){budgetStopped=true;return false;}
  reservations.add(i.id);return true;
 };
 assert.equal(store.db.prepare('SELECT version FROM cc_schema').get().version,18);
 assert(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cc_werewolf'").get());
 ({url}=await app.start());assert.notEqual(new URL(url).port,'4310');
}
function check(name,verdict){checks[name]=Boolean(verdict);assert(verdict,name);}
try{
 console.log(dir,mode);
 await boot();const store=app.collaborationStore;
 store.saveAccount(account);
 for(const id of roster)store.saveMember({id,name:id==='host'?'主持':id,carrier:'claude-cli',accountId:account.id,model:selected.model,modelBinding:'override',accountBinding:'override',enabled:true,
  instructions:id==='host'?'本房约定：受托主持十二人局时以现有主委托为单位，用规则工具读取本场事实，向公开 eligible 名单的全体同时收取本阶段决策，征询应挂在同一 obligationId，留足 600000 毫秒。玩家收到邀请后需通过 game_read 和 game_act 独立登记。收到真实汇总再结算该 epoch；新阶段自行组织，至真实终局公开交付。':'依据本轮委托独立作出选择。收到本房的游戏邀请时，查看 game_read 并按当前阶段和合法字段使用 game_act；成功即结束本轮。'});
 const room=await post('/api/conversations',{requestId:randomUUID(),title:'标准十二人狼人杀',memberIds:roster,defaultMemberId:'host'});
 cid=room.conversation.id;
 await post('/api/conversations/'+cid+'/messages',{requestId:randomUUID(),content:roomRequest});
 proof.userSubmissions++;
 let idle=Date.now(),last;
 while(Date.now()<deadline){
  const current=app.collaborationStore,inv=current.invocations().filter(i=>i.conversationId===cid),ob=current.obligations.list(cid).find(o=>!o.parentId);
  const running=inv.some(i=>['prepared','running'].includes(i.status)),g=ob&&current.werewolf.get(ob.id,cid);
  if(budgetStopped&&!inv.some(i=>i.dispatchStarted&&['running','cancel_requested'].includes(i.status)))throw Error('Native budget reached. Remaining deliveries stay unstarted on the original obligation.');
  const stamp=[inv.length,ob?.revision,g?.actions.length,calls.reduce((n,c)=>n+c.tools.length,0)].join('/');
  if(stamp!==last){last=stamp;idle=Date.now();}
  if(inv.some(i=>['failed','interrupted','cancelled'].includes(i.status)))throw Error('A native game execution failed');
  if(ob&&['blocked','cancelled','awaiting_acceptance'].includes(ob.state))throw Error('Main obligation '+ob.state+' '+ob.reason);
  if(ob?.state==='delivered'&&!running)break;
  if(mode==='--restart'&&pause&&!restarted&&g?.actions.filter(a=>a.epoch===1).length===12&&inv.filter(i=>i.memberId!=='host').every(i=>i.status==='succeeded')&&sideStart){
   await sideStart;
   if(!current.invocations().some(i=>i.conversationId===sideId&&i.status==='succeeded')){await sleep(600);continue;}
   const before=hash(JSON.stringify(g));await app.close();app=undefined;pause=false;restarted=true;await boot();
   check('privateInspectionSurvivedRestart',before===hash(JSON.stringify(app.collaborationStore.werewolf.get(ob.id,cid))));
   idle=Date.now();
  }
  if(!running&&Date.now()-idle>18_000)throw Error('No next execution / durable wait after member exit');
  if(Date.now()-idle>4*60_000)throw Error('No progress for four minutes');
  await sleep(800);
 }
 const current=app.collaborationStore,details=await (await fetch(url+'/api/conversations/'+cid)).json();
 const root=details.obligations.find(o=>!o.parentId),game=current.werewolf.get(root.id,cid);
 check('acceptedTerminalWinner',root.state==='delivered'&&game.phase==='finished'&&game.winner&&details.messages.find(m=>m.id===root.delivery?.messageId)?.content.includes(game.winner));
 check('zeroUserAdvances',proof.userSubmissions===1&&details.messages.filter(m=>m.author==='user').length===1);
 const all=details.invocations;
 check('acceptedConfirmedExecutions',all.every(i=>i.status==='succeeded'&&i.nativeSessionId&&i.teardown==='confirmed'&&i.acceptance==='accepted'));
 check('actionsBoundToNativeAuthors',game.actions.every(a=>calls.find(c=>c.id===a.invocation&&c.member===a.by&&c.tools.some(t=>t.name==='game_act'&&t.ok))));
 check('actualHostInvitations',details.groups.every(g=>calls.find(c=>c.id===g.callerInvocationId&&c.tools.some(t=>t.name==='multi_mention'&&t.group===g.id&&t.obligation===root.id))));
 check('allWakesConsumedOnce',details.groups.every(g=>g.state==='done'&&g.contract?.wakeSourceId&&details.consumptions.filter(c=>c.sourceId===g.contract.wakeSourceId&&c.memberId==='host').length===1));
 const seer=game.players.find(s=>s.role==='seer').memberId;
 const readView=async(id,suffix)=>{const r=await fetch(url+'/api/conversations/'+id+suffix);assert(r.ok);return r.text();};
 const publicBundle=JSON.stringify(details)+await readView(cid,'/observer')+await readView(cid,'/factors');
 const visibleSeats=await Promise.all(players.map(id=>readView(cid,'/factors?viewer='+encodeURIComponent(id))));
 check('noRawRolesInSpectatorViews',[...seals].every(s=>!publicBundle.includes(s)&&visibleSeats.every(v=>!v.includes(s))));
 check('sealedObservations',seals.size>0&&[...seals].every(s=>!publicBundle.includes(s)&&projections.every(p=>!p.input.includes(s))&&observations.filter(o=>o.room!==cid||o.member!==seer).every(o=>!o.data.includes(s))));
 const acts=all.filter(i=>current.contract(i.id).roomRuleTurn?.kind==='player');
 check('limitedNativeToolset',acts.every(i=>details.evidence.some(e=>e.invocationId===i.id&&e.detail.observation==='game_player_tools')));
 check('stagesCovered',['night','discuss','vote','finished'].every(phase=>calls.some(c=>c.tools.some(t=>t.name.startsWith('game_')&&t.phase===phase))));
 if(mode==='--restart'){
  const other=calls.find(c=>c.room===sideId),counterpart=calls.find(c=>c.room===cid&&c.member===sideMember&&c.spawn<other?.exit&&other?.spawn<c.exit);
  check('distinctOverlappingProcesses',restarted&&other?.pid&&counterpart?.pid&&other.pid!==counterpart.pid&&other.session!==counterpart.session);
  const peer=await(await fetch(url+'/api/conversations/'+sideId)).json();
  check('independentInstanceAndInputs',!Array.from(seals).some(s=>JSON.stringify(peer).includes(s))&&current.roomMembers.resolve(cid,sideMember).id!==current.roomMembers.resolve(sideId,sideMember).id);
  proof.isolation={sideId,sideMember,sidePid:other.pid,primaryPid:counterpart.pid};
 }
 proof.root=root;proof.acceptedInstances=all.map(i=>({id:i.id,room:i.conversationId,member:i.roomMember?.id,session:i.nativeSessionId,receipt:i.responseId}));proof.initialSource=root.originSourceId;proof.rounds=details.groups.map(g=>({id:g.id,source:g.sourceId,wake:g.contract.wakeSourceId,participants:g.targets,actual:g.results.map(r=>r.invocationId)}));
 proof.publicTimeline=game.history;proof.epochs=game.epoch;proof.privateMarkDigests=[...seals].map(hash);proof.passed=true;
}catch(e){proof.error=e.message;process.exitCode=1;}
finally{
 if(app){if(cid){const r=app.collaborationStore.obligations.list(cid).find(o=>!o.parentId);proof.endState=r?.state;proof.remaining=r&&{obligation:r.id,owner:r.owner,phase:r.state,group:r.activeGroupId,pending:app.collaborationStore.invocations().filter(i=>i.conversationId===cid&&i.status==='prepared'&&!i.dispatchStarted).map(i=>i.id)};proof.gamePhase=r&&app.collaborationStore.werewolf.get(r.id,cid)?.phase;}await app.close();}
 await writeFile(join(dir,'result.json'),JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify({dir,mode,passed:proof.passed,checks,error:proof.error}));
}
