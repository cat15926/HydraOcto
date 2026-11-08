// Isolated black-box exercise through chat, real native CLIs, SQLite and the authorized project filesystem.
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,readFile,realpath,unlink,writeFile } from 'node:fs/promises';
import { basename,join,resolve } from 'node:path';
import type { CollaborationBootstrap, CollaborationInvocation, CollaborationRuntime,Member } from '../shared/collaboration.js';
import { createApplication } from '../server/index.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { readProjectVm } from '../server/collaboration/project-vm.js';
import { sessionFixture,type Carrier } from './runtime/project-session-fixture.js';

const flag=process.argv[2];
assert(['codex','claude','review','--live-review'].includes(flag),'usage: verify-project-sessions.ts codex|claude|review|--live-review');
const review=flag.includes('review'), live=flag==='--live-review';
const vm=readProjectVm(resolve(process.env.P2_VM_CONFIG || '.local-data/validation/native-project-p2/p02.json'));
assert(vm?.historyProtocol && basename(vm.hostRoot).startsWith('multi-agent-vm-project-'),'require a registered synthetic VM project');
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p2/executions');
await mkdir(out,{recursive:true});
const folder=await mkdtemp(join(out,(live?'live-review':flag)+'-'));
const work=await mkdtemp(join(await realpath(vm.hostRoot),'p2-')), sub=basename(work);
const relative=sub+'/review.txt', keyEnv='P2_SYNTHETIC_MODEL_CREDENTIAL', key=randomUUID();
const marker='P2_'+randomUUID().replaceAll('-',''), second='P2_'+randomUUID().replaceAll('-','');
await writeFile(join(work,'private.txt'),marker+'\n',{flag:'wx'});
await mkdir(join(folder,'claude-home'),{mode:0o700});
process.env.CLAUDE_CONFIG_DIR=join(folder,'claude-home');
if (live) process.loadEnvFile('.env'); else process.env[keyEnv]=key;
const config:CollaborationBootstrap|undefined= live ? await (await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap')).json() : undefined;
const ids:Carrier[]=review?['codex','claude']:[flag as Carrier];
const fixtures=new Map<Carrier,Awaited<ReturnType<typeof sessionFixture>>>();
const limits:Partial<Record<Carrier,number>>={}, counts:Record<string,number>={};
for(const id of ids) { if (!live) fixtures.set(id,await sessionFixture(id,sub,key)); limits[id]=live?1:2; }
if(review) { fixtures.get('codex')?.phase('write'); fixtures.get('claude')?.phase('review'); }
const native=createCollaborationRuntime({projectVm:vm,timeoutMs:150000});
const runtime:CollaborationRuntime={...native,async invoke(request){
  const id=request.member.id as Carrier;
  assert(limits[id] && (counts[id] ?? 0)<limits[id]!,'member invocation limit');
  assert.equal(request.account.auth,'api');
  assert.equal(!!request.projectWork,!review || id==='codex');
  if(review && id==='claude') assert.deepEqual(request.projectReview?.paths,[relative]);
  assert(!request.prompt.includes(marker) || review && counts[id], 'private marker leaked into platform input');
  counts[id]=(counts[id] ?? 0)+1;
  return native.invoke(request);
}};
const options={port:0,dataDir:join(folder,'db'),workspace:join(folder,'default'),collaborationRuntime:runtime,
  ...(process.env.VALIDATION_STATIC_DIR?{staticDir:resolve(process.env.VALIDATION_STATIC_DIR)}:{})};
let app=await createApplication(options), url='',cid='';
const evidence:Record<string,unknown>={case:flag,realCli:true,modelMode:live?'real':'scripted',caseFolder:sub};
async function post(path:string,body:unknown){
  const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
  assert(response.ok,path+' HTTP '+response.status+' '+(response.ok?'':(await response.text()).slice(0,240)));
  return response.json();
}
async function terminal(id:Carrier, number:number){
  for(let i=0;i<680;i++){
    const runs=app.collaborationStore.detail(cid).invocations, run=runs.filter(r=>r.memberId===id)[number-1];
    if(run && !['prepared','running','cancel_requested'].includes(run.status)){
      assert.equal(run.status,'succeeded',id+' '+run.status+' '+(run.error??''));
      assert.equal(run.acceptance,'accepted'); assert.equal(run.teardown,'confirmed'); return run;
    }
    if(!run && runs.some(r=>r.status==='failed'||r.status==='interrupted')) throw Error('Prior member failed');
    if(!run && review && id==='claude' && runs.some(r=>r.memberId==='codex' && r.status==='succeeded') &&
       !app.collaborationStore.detail(cid).sources.some(s=>s.kind==='a2a')) throw Error('Writer finished without requesting review');
    await new Promise(done=>setTimeout(done,250));
  }
  throw Error(id+' timed out');
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
try {
  for(const id of ids){
    const member=config?.members.find(m=>m.id===id && m.enabled);
    const configured=config?.accounts.find(a=>a.id===member?.accountId && a.auth==='api');
    if(live) assert(member?.model && configured?.apiKeyEnv && process.env[configured.apiKeyEnv],'Missing active API configuration');
    const account=configured??{id:'p2-'+id,name:'本地脚本模型',auth:'api' as const,provider:id,apiKeyEnv:keyEnv,baseUrl:fixtures.get(id)!.baseUrl};
    const m:Member={id,name:id==='claude'?'Claude Code':'Codex',carrier:id==='claude'?'claude-cli':'codex-app-server',enabled:true,
      model:member?.model??(id==='claude'?'claude-sonnet-4-6':'gpt-5'),instructions:'按本轮委托使用所给工具。',accountId:account.id,accountBinding:'override',modelBinding:'override'};
    app.collaborationStore.saveAccount(account);app.collaborationStore.saveMember(m);
  }
  ({url}=await app.start());
  const writer=ids[0]!, writerName=writer==='claude'?'Claude Code':'Codex';
  ({conversation:{id:cid}}=await post('/api/conversations',{title:'原生项目验证',memberIds:ids,defaultMemberId:writer,requestId:randomUUID()}));
  const endpoint='/api/conversations/'+cid;
  const content= review ? '@Codex 请在项目目录 '+sub+' 中用原生工具把 private.txt 原样复制为 review.txt。完成后请 Claude Code 评审：通过 collaboration_request 指定相对路径 '+relative+'，请对方实际读取文件并回报文件里的验收标记。你自己的回复不要包含文件内容。'
    :'@'+writerName+' 请在项目子目录 '+sub+' 读取 private.txt，并新建 first.txt 记录 ready。请在本轮记住原文件内容，回复中省略标记。';
  const {intent}=await post(endpoint+'/messages',{content,requestId:randomUUID()});
  assert(intent?.id && intent.memberIds.join()===writer);
  const preview=await post(endpoint+'/workspace-preview',{path:vm.hostRoot,mode:'project-work',intentId:intent.id});
  await post(endpoint+'/workspace-apply',{previewId:preview.id,requestId:randomUUID()});
  const first=await terminal(writer,1);
  if(!review){
    assert.equal((await readFile(join(work,'first.txt'),'utf8')).trim(),'ready');
    await unlink(join(work,'private.txt'));
    await app.close(); app=await createApplication(options); ({url}=await app.start());
    fixtures.get(writer)!.phase('second');
    const next=await post(endpoint+'/messages',{content:'继续',requestId:randomUUID()});
    assert(next.source?.projectWork,'Short continuation should keep the completed project assignment');
    const after=await terminal(writer,2);
    assert.equal((await readFile(join(work,'second.txt'),'utf8')).trim(),marker);
    assert.equal(after.continuity,'resumed');assert.equal(after.nativeSessionId,first.nativeSessionId);
    assert.equal(after.sessionPlan?.previousInvocationId,first.id);assert(after.sessionPlan?.previousAnchor);
    assert(fixtures.get(writer)!.rounds.some(r=>r.phase==='second' && r.step===0 && r.receivedMarker));
    Object.assign(evidence,{resumed:true,hostRestarted:true,markerRestoredFromToolHistory:true});
  }else{
    const r=await terminal('claude',1), data=marker+'\n';
    assert.equal(await readFile(join(work,'review.txt'),'utf8'),data);
    const detail=app.collaborationStore.detail(cid);
    const source=detail.sources.find(s=>s.kind==='a2a' && s.projectReview?.paths.includes(relative));
    assert(source && source.parentInvocationId===first.id);
    assert(detail.messages.some(m=>m.memberId==='claude' && m.content.includes(marker)),'reviewer failed to report the actual marker');
    const receipt=detail.evidence.find(e=>e.invocationId===r.id && e.detail.origin==='project_review' && e.detail.state==='read');
    assert.equal(receipt?.detail.sha256,sha(data));
    const checkPath=endpoint+'/project-reviews/'+r.id;
    assert.equal((await post(checkPath+'/check',{})).files[0].status,'unchanged');
    await writeFile(join(work,'review.txt'),second+'\n');
    const changed=await post(checkPath+'/check',{});
    assert.equal(changed.files[0].status,'changed'); assert.equal(changed.files[0].currentSha256,sha(second+'\n'));
    Object.assign(evidence,{author:first.id,reviewer:r.id,request:source.id,realFileRead:true,afterExternalEdit:changed.files[0].status});
    if(!live){
      fixtures.get('claude')!.phase('review');
      const ticket={requestId:randomUUID()}, accepted=await post(checkPath+'/reread',ticket);
      assert.equal((await post(checkPath+'/reread',ticket)).sourceId,accepted.sourceId);
      const rerun=await terminal('claude',2);
      assert.equal((await post(endpoint+'/project-reviews/'+rerun.id+'/check',{})).files[0].sha256,sha(second+'\n'));
      assert(app.collaborationStore.detail(cid).messages.some(m=>m.memberId==='claude' && m.content.includes(second)));
      evidence.rereadVerified=true;
    }
  }
  evidence.passed=true;
}catch(e){process.exitCode=1; console.error((e as Error).message);}
finally{
  if(cid) {
    const detail=app.collaborationStore.detail(cid);
    evidence.invocations=detail.invocations.map(({id,memberId,status,error,nativeSessionId,continuity,sessionPlan}:CollaborationInvocation)=>
      ({id,memberId,status,error,nativeSessionId,continuity,mode:sessionPlan?.mode,reason:sessionPlan?.reason,previous:sessionPlan?.previousInvocationId}));
    evidence.proofs=detail.evidence.filter(e=>e.kind==='session' || e.detail.origin==='project_review' || e.kind==='diagnostic' && e.detail.observation==='native_terminal').map(e=>({kind:e.kind,continuity:e.detail.continuity,anchor:e.detail.anchor,verified:e.detail.historyVerified,state:e.detail.state,source:e.detail.evidence}));
  }
  evidence.calls=counts;
  evidence.fixtures=Object.fromEntries([...fixtures].map(([id,f])=>[id,{rounds:f.rounds,diagnostics:f.diagnostics}]));
  await app.close();for(const f of fixtures.values()) await f.close();
  await writeFile(join(folder,'result.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
  console.log(folder,evidence.passed?'passed':'failed');
}
