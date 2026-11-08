import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';
import { invokeClaude } from '../server/collaboration/runtime-claude.js';
import { invokeCodex } from '../server/collaboration/runtime-codex.js';
import { describeProjectSession, projectTranscript } from '../server/collaboration/runtime-session.js';
import type { ProjectCli, ProjectVm } from '../server/collaboration/project-vm.js';
import type { ProjectHistory } from '../server/collaboration/project-vm-history.js';
import type { CliTransport, Json } from '../server/collaboration/runtime-common.js';

const envName = 'SYNTHETIC_P2_CONTINUITY_KEY';
function input(carrier: 'codex-app-server' | 'claude-cli', events: RuntimeEvent[]): RuntimeRequest {
  return { invocationId:randomUUID(), conversationId:randomUUID(), member:{id:'member',name:'Member',enabled:true,model:'test-model',instructions:'',carrier,accountId:'a'},
    account:{id:'a',name:'Synthetic',provider:carrier==='codex-app-server'?'codex':'claude',auth:'api',apiKeyEnv:envName},
    cwd:'/synthetic',projectWork:true,projectContinuity:true,prompt:'Exact scoped request',signal:AbortSignal.timeout(3000),onEvent:event=>events.push(event),onToolCall:async()=>{throw new Error('unexpected tool');} };
}
// Script only the guest protocol boundary; no model, project commands or account lookups.
function guest(history:ProjectHistory|undefined, run:(args:string[], send:(value:Json)=>void, exit:()=>void)=>Pick<CliTransport,'write'|'end'>):ProjectCli {
  let treeExited=false, launched=false;
  return {origin:'http://127.0.0.1:12345', get treeExited(){return treeExited;},get launched(){return launched;},history,ready:Promise.resolve(),close:async()=>{},
    launch(args){launched=true; let receive!:(chunk:string)=>void, close!:()=>void;
      const protocol=run(args,msg=>receive(JSON.stringify(msg)+'\n'),()=>close());
      return {...protocol,connect(data,closed){ receive=data; close=()=>{if(!treeExited){treeExited=true;closed(0,null,true);}}; },kill(){close();}};
    }};
}

test('P2 a resumed plan references the exact previous successful invocation and rotates after reauthorization', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()),'p2-project-binding-'));
  const project = join(dir,'project');
  await mkdir(project);
  const owner = new Store(join(dir,'private','db'));
  t.after(async () => { owner.close(); await rm(dir,{recursive:true,force:true}); });
  const store = new CollaborationStore(owner,{workspace:project,projectWorkAvailability:()=>({available:true})});
  const member = store.members().find(m=>m.id==='codex')!;
  store.saveMember({...member,model:'fixture',modelBinding:'override'});
  const cid = store.create({title:'binding',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const grant = () => {
    const preview = store.workbench.previewWorkspace(cid,{path:project,mode:'project-work'});
    store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  };
  const submit = () => {
    const source = store.projects.submit(cid,{content:'@Codex 修改项目文件',requestId:randomUUID()});
    assert('source' in source && source.source.projectWork);
    const i = store.admitNext()!.invocations[0]!;
    assert.equal(store.contract(i.id).projectContinuity,true);
    const plan = store.prepareSession(i.id,{supported:true,reason:'test',fingerprint:'test-guest'});
    return {i,plan};
  };
  const sessionId=randomUUID();
  const done = (id:string,anchor:string) => {
    store.startInvocation(id);
    store.recordEvidence(id,{kind:'session',detail:{nativeSessionId:sessionId,anchor,continuity:'fresh',historyVerified:true}});
    store.recordEvidence(id,{kind:'accepted',detail:{}});
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});
    store.finish(id,'succeeded','OK');
  };
  grant();
  const first=submit(),anchor=randomUUID();
  assert.equal(first.plan.mode,'fresh');assert.match(first.plan.fingerprint!,/^[a-f0-9]{64}$/);
  done(first.i.id,anchor);
  const second=submit();
  assert.equal(second.plan.mode,'resume');assert.equal(second.plan.previousInvocationId,first.i.id);
  assert.equal(second.plan.previousAnchor,anchor);assert.equal(second.plan.fingerprint,first.plan.fingerprint);
  done(second.i.id,randomUUID());
  grant();
  const next=submit();
  assert.equal(next.plan.mode,'replace');assert.notEqual(next.plan.fingerprint,first.plan.fingerprint);
  assert.equal(next.plan.previousInvocationId,undefined);assert.equal(next.plan.nativeSessionId,undefined);
});

test('P2 guest identity pins the selected credential, VM binary and physical project; P01 and missing grants remain fresh',async t=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'p2-project-identity-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const project=join(dir,'project');await mkdir(project);const meta=await stat(project);
  const r=input('codex-app-server',[]);r.cwd=project;r.workspaceGrant={path:project,device:meta.dev,inode:meta.ino,mode:'project-work',memberIds:[r.member.id],revision:1,authorizedAt:new Date().toISOString()};
  const vm:ProjectVm={lima:'/test/limactl',limaHome:'/test/lima',instance:'p02',hostRoot:project,device:meta.dev,inode:meta.ino,guestDevice:'1',guestInode:'3',historyProtocol:'project-session-history-v1',runnerSha256:'a'.repeat(64),bootId:randomUUID(),carriers:{'codex-app-server':'b'.repeat(64)}};
  process.env[envName]='synthetic-identity-one';t.after(()=>{delete process.env[envName];});
  const first=describeProjectSession(r,vm);assert.ok(first.supported&&first.fingerprint);assert.equal(JSON.stringify(first).includes(process.env[envName]),false);
  assert.equal(describeProjectSession(r,{...vm,bootId:randomUUID()}).fingerprint,first.fingerprint);
  assert.equal(describeProjectSession(r,{...vm,historyProtocol:undefined}).supported,false);
  assert.equal(describeProjectSession({...r,projectContinuity:undefined},vm).supported,false);
  assert.equal(describeProjectSession({...r,workspaceGrant:{...r.workspaceGrant,memberIds:[]}},vm).supported,false);
  assert.notEqual(describeProjectSession(r,{...vm,runnerSha256:'c'.repeat(64)}).fingerprint,first.fingerprint);
  process.env[envName]='synthetic-identity-two';assert.notEqual(describeProjectSession(r,vm).fingerprint,first.fingerprint);
  await rename(project,project+'-old');await mkdir(project);assert.equal(describeProjectSession(r,vm).supported,false);
});

for(const state of ['resumed','missing','stale','unsaved','unknown'] as const) test(`P2 guest Codex ${state} binds exactly one input to its verified turn`,async t=>{
  process.env[envName]='synthetic';t.after(()=>{delete process.env[envName];});
  const events:RuntimeEvent[]=[], r=input('codex-app-server',events), previousSession=randomUUID(), previousTurn=randomUUID(), currentTurn=randomUUID();
  r.nativeSessionId=previousSession;r.sessionPlan={mode:'resume',previousAnchor:previousTurn,reason:'test',previousInvocationId:randomUUID()};
  const restoredRolloutPath='/tmp/home/.codex/sessions/fixture.jsonl';
  let didFinish=false, modelInputs=0,sessionId=previousSession;
  const history:ProjectHistory={restored:state!=='missing',restoredRolloutPath,async finish(session,anchor){assert.equal(session,sessionId);assert.equal(anchor,currentTurn);assert.equal(p.treeExited,true);didFinish=true;return state==='unsaved'?undefined:[];}};
  const p=guest(history,(_args,send,exit)=>({end(){exit();},write(data){
    const m=JSON.parse(data);const reply=(result:Json)=>send({id:m.id,result});
    switch(m.method){
      case 'initialized':break;
      case 'initialize':reply({});break;
      case 'config/read':reply({config:{model_provider:'platform_api',model_providers:{platform_api:{base_url:'http://127.0.0.1:12345/model/v1',env_key:'COLLAB_SELECTED_RUNTIME_API_KEY',wire_api:'responses',requires_openai_auth:false,supports_websockets:false}}}});break;
      case 'thread/resume':assert.notEqual(state,'missing');assert.equal(m.params.path,restoredRolloutPath);reply({thread:{id:sessionId},modelProvider:'platform_api',model:'test-model'});break;
      case 'thread/turns/list':reply({data:[{id:state==='stale'?randomUUID():previousTurn,status:'completed'}]});break;
      case 'thread/start':assert.equal(m.params.ephemeral,false);assert.ok(['missing','stale'].includes(state));sessionId=randomUUID();reply({thread:{id:sessionId},modelProvider:'platform_api',model:'test-model'});break;
      case 'turn/start':modelInputs++;reply({turn:{id:currentTurn}});if(state==='unknown'){exit();break;}
        send({method:'turn/completed',params:{threadId:sessionId,turn:{id:currentTurn,status:'completed',items:[{type:'agentMessage',text:'OK'}]}}});break;
      default:throw new Error('Unexpected method '+m.method);
    }
  }}));
  if(state==='unknown'){await assert.rejects(invokeCodex(r,'unused',p));assert.equal(didFinish,false);}
  else {const result=await invokeCodex(r,'unused',p);assert.equal(result.continuity,['missing','stale'].includes(state)?'fresh':'resumed');assert.equal(didFinish,true);
    assert.equal(events.some(e=>e.kind==='session'&&e.detail.historyVerified),state!=='unsaved');}
  assert.equal(modelInputs,1);assert.equal(events.filter(e=>e.kind==='session_replaced').length,['missing','stale'].includes(state)?1:0);
});

for (const state of ['resumed','missing','changed_parent'] as const) test(`P2 guest Claude ${state} checks the captured parent chain and exact input`,async t=>{
  process.env[envName]='synthetic';t.after(()=>{delete process.env[envName];});
  const events:RuntimeEvent[]=[], r=input('claude-cli',events), oldSession=randomUUID(), oldAnchor=randomUUID();
  r.nativeSessionId=oldSession;r.sessionPlan={mode:'resume',reason:'test',previousAnchor:oldAnchor};
  const before=[{type:'assistant',uuid:oldAnchor,sessionId:oldSession,cwd:'/mnt/project'}];
  const assistant=randomUUID(),user=randomUUID();let inputs=0;
  const history:ProjectHistory={restored:state!=='missing',beforeClaudeRows:before,async finish(sid,anchor){assert.equal(anchor,assistant);assert.equal(p.treeExited,true);return [...(state==='missing'?[]:before),{type:'user',uuid:user,parentUuid:state==='resumed'?oldAnchor:undefined,sessionId:sid,message:{content:r.prompt}},{type:'assistant',uuid:assistant,parentUuid:user,sessionId:sid}];}};
  const p=guest(history,(args,send,exit)=>{const resumed=args.includes('--resume'),sid=args[args.indexOf(resumed?'--resume':'--session-id')+1]!;
    assert.equal(resumed,state!=='missing');return {write(){throw new Error('unexpected');},end(prompt){inputs++;assert.equal(prompt,r.prompt);
      send({type:'system',subtype:'init',model:r.member.model,session_id:sid});send({type:'assistant',session_id:sid,uuid:assistant,message:{id:'answer',content:[]}});
      send({type:'result',subtype:'success',is_error:false,session_id:sid,result:'OK'});exit();}};});
  const result=await invokeClaude(r,'unused',p);assert.equal(inputs,1);assert.equal(result.continuity,state==='missing'?'fresh':state==='resumed'?'resumed':'unknown');
  assert.equal(events.some(e=>e.kind==='session'&&e.detail.historyVerified),state!=='changed_parent');
  assert.equal(projectTranscript([...before,...before],oldSession),undefined);assert.equal(projectTranscript(before,randomUUID()),undefined);
});
