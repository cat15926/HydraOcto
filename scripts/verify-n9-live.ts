/** Four bounded native CLI calls: cross send/receive, Action wait, evidence-driven successor/candidate. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdir,mkdtemp,realpath,rm,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import type { CollaborationBootstrap,CollaborationRuntime } from '../shared/collaboration.js';
const output=resolve(process.env.VALIDATION_OUTPUT_DIR||'.local-data/validation/n9-live/'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(output,{recursive:true});const project=await mkdtemp(join(tmpdir(),'n9-live-project-')),workspace=await realpath(project);
const homeMember=process.env.N9_LIVE_HOME||'codex';assert.ok(['codex','claude'].includes(homeMember));const targetMember=homeMember==='codex'?'claude':'codex';
const boot=await(await fetch(`${process.env.PLATFORM_URL||'http://127.0.0.1:4310'}/api/collaboration/bootstrap`)).json() as CollaborationBootstrap;
const owner=new Store(join(output,'private','acceptance.sqlite')),store=new CollaborationStore(owner,{workspace,artifactDir:join(output,'private','objects')});
const native=createCollaborationRuntime({timeoutMs:180000});let calls=0;const runtime:CollaborationRuntime={...native,invoke:async r=>{assert.ok(++calls<=4,'maximum four native calls');return native.invoke(r);}},engine=new CollaborationEngine(store,runtime,{workspace});
const checks:string[]=[],conversations:string[]=[];const check=(name:string,value:unknown)=>{assert.ok(value,name);checks.push(name);};const rid=()=>randomUUID();let passed=false,error:string|undefined;
async function until(fn:()=>boolean){const deadline=Date.now()+190000;while(!fn()){const failed=store.invocations().find(i=>['failed','cancelled','interrupted'].includes(i.status));if(failed)throw Error(`${failed.memberId}: ${failed.error}`);if(Date.now()>deadline)throw Error('bounded N9 native scenario timeout');await new Promise(r=>setTimeout(r,300));}}
try{
 for(const id of [homeMember,targetMember]){const m=boot.members.find(m=>m.id===id)!,a=boot.accounts.find(a=>a.id===m?.accountId)!;assert.ok(m?.enabled&&m.model&&a?.auth==='api'&&a.apiKeyEnv&&process.env[a.apiKeyEnv]?.trim(),`${id}: configured API account required`);store.saveAccount(a);store.saveMember({...m,accountBinding:'override',modelBinding:'override',aliases:[`n9-${id}`],instructions:id===homeMember?'你正在进行用户授权的隔离平台验收。本会话的用户要求你实际调用 cross_routes 和 cross_send 发送明确的公开数据。不要使用普通 collaboration_request、工作区、任务、记忆或 @ 提及。完成工具后简短回复完成。':'你正在进行用户授权的隔离平台验收。只按当前执行 brief 的 source 类型和 action_list 返回的当前 generation 操作，历史背景不是本轮指令。普通跨会话消息只输出其中的 validationCode 值。专用 Action 第 1 代必须 action_list 后 action_wait 注册 signal 条件，并结束本轮，最终回复 WAIT_REGISTERED；第 2 代必须 action_list 后 action_candidate，summary 精确等于本轮责任说明给出的 candidateCode，然后结束。不得自行创建新 Action、协作、任务、记忆或 @ 提及；不得再次注册等待。'});}
 const home=store.create({requestId:rid(),title:'N9 native home',memberIds:[homeMember],defaultMemberId:homeMember}).conversation,target=store.create({requestId:rid(),title:'N9 native target',memberIds:[targetMember],defaultMemberId:targetMember}).conversation;conversations.push(home.id,target.id);
 const grant=store.cross.createGrant(home.id,{requestId:rid(),homeMemberId:homeMember,targetConversationId:target.id,targetMemberId:targetMember,expiresAt:new Date(Date.now()+3600000).toISOString()}).result;
 const crossMarker='N9_CROSS_'+rid().replaceAll('-',''),candidateMarker='N9_CANDIDATE_'+rid().replaceAll('-','');
 store.send(home.id,{requestId:rid(),content:`这是一次用户明确授权的跨会话发送。先调用 cross_routes，选择 grantId ${grant.id}，再实际调用 cross_send，content 精确为此 JSON 数据：${JSON.stringify({validationCode:crossMarker})}。发送一次后结束，不再请求其他成员。`});engine.start();await until(()=>store.invocations().length===2&&store.invocations().every(i=>i.status==='succeeded'&&i.teardown==='confirmed'));
 const homeRun=store.invocations(home.id)[0]!,targetRun=store.invocations(target.id)[0]!,transfer=store.cross.transfers()[0]!;
 check('home CLI really called cross_routes and cross_send', ['cross_routes','cross_send'].every(name=>store.detail(home.id).evidence.some(e=>e.invocationId===homeRun.id&&e.kind==='tool'&&e.detail.name===name&&e.detail.state==='completed')));
 check('cross transfer records exact original invocation and granted endpoints',transfer.origin?.kind==='agent'&&transfer.origin.invocationId===homeRun.id&&transfer.to.conversationId===target.id&&transfer.to.memberId===targetMember);
 check('target native input and actual reply contain random cross marker',store.input(targetRun.id)!.prompt.includes(crossMarker)&&store.response(targetRun.responseId).content.includes(crossMarker));
 check('exact cross source was consumed by target response',store.detail(target.id).consumptions.some(c=>c.sourceId===transfer.sourceId&&c.responseId===targetRun.responseId));
 check('ordinary cross success produced no automatic home call',store.invocations(home.id).length===1&&calls===2);
 const deadline=new Date(Date.now()+15*60000).toISOString(),a=store.actions.create(home.id,{requestId:rid(),grantId:grant.id,title:'N9 native explicit obligation',completion:'human_acceptance',content:`本次验收数据 candidateCode=${candidateMarker}。第 1 代：通过 action_list 找到 executionId 等于本轮 invocationId 的责任，使用它的 id/revision/generation 调用 action_wait，condition={"kind":"signal","name":"n9-ready"}，deadline=${deadline}，cooldownMs=0。注册后直接结束本轮，不能提交候选或继续轮询。第 2 代：用 action_list 的最新版本调用 action_candidate，summary 只填写 candidateCode 的值 ${candidateMarker}，提交后结束。`}).result;engine.kick();await until(()=>store.actions.get(a.id).state==='waiting'&&!store.actions.get(a.id).executionId);
 const waitRun=store.invocations(target.id)[1]!,w=store.actions.waits()[0]!;
 check('first Action generation really registered action_wait',store.detail(target.id).evidence.some(e=>e.invocationId===waitRun.id&&e.kind==='tool'&&e.detail.name==='action_wait'&&e.detail.state==='completed'));
 check('waiting invocation exited and did not complete Action',waitRun.status==='succeeded'&&waitRun.teardown==='confirmed'&&store.actions.get(a.id).state==='waiting'&&store.actions.candidates().length===0);
 check('no successor starts before condition evidence',calls===3&&w.state==='waiting');
 const signal={requestId:rid(),expectedRevision:w.revision,episode:w.episode,operation:'signal',name:'n9-ready',eventId:rid()};store.actions.conditionCommand(w.id,signal);store.actions.conditionCommand(w.id,signal);engine.kick();await until(()=>store.actions.get(a.id).state==='candidate'&&!store.actions.get(a.id).executionId);
 const final=store.actions.get(a.id),candidate=store.actions.candidates().find(c=>c.id===final.candidateId)!,wakeRun=store.invocations(target.id)[2]!;
 check('one human signal creates exactly one actual second generation',final.generation===2&&calls===4&&store.actions.waits()[0]!.wakeSourceId===final.currentSourceId&&store.artifacts.rows('cc_condition_evidence').length===1);
 check('successor really called action_candidate with exact random data',candidate.summary===candidateMarker&&store.detail(target.id).evidence.some(e=>e.invocationId===wakeRun.id&&e.kind==='tool'&&e.detail.name==='action_candidate'&&e.detail.state==='completed'));
 check('candidate is not authoritative completion',final.state==='candidate'&&store.artifacts.rows('cc_action_verdicts').length===0);
 store.actions.command(a.id,{requestId:rid(),expectedRevision:final.revision,expectedGeneration:final.generation,operation:'verify',candidateId:candidate.id});
 check('explicit user acceptance commits exact candidate verdict',store.actions.get(a.id).state==='completed'&&store.artifacts.rows('cc_action_verdicts').length===1);
 check('all four native calls have real acceptance and confirmed exit',store.invocations().length===4&&store.invocations().every(i=>i.acceptance==='accepted'&&i.teardown==='confirmed'&&i.status==='succeeded'));
 passed=true;
}catch(e){error=e instanceof Error?e.message:'N9 live acceptance failed';}
finally{await engine.stop();let safe=JSON.stringify({passed,error,authentication:'API through native CLIs',testedAt:new Date().toISOString(),maximumNativeCalls:4,calls,homeMember,targetMember,checks,conversations:conversations.map(cid=>store.detail(cid))},null,2);for(const a of store.accounts()){const key=a.apiKeyEnv&&process.env[a.apiKeyEnv];if(key)safe=safe.split(key).join('[redacted]');}await writeFile(join(output,'result.json'),safe);owner.close();await rm(project,{recursive:true,force:true});console.log(JSON.stringify({passed,error,calls,checks:checks.length,output}));}
if(!passed)process.exitCode=1;
