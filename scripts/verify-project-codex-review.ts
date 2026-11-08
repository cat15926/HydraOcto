// Real host Codex acting only as the reader. Author admission is a fixture and the model is loopback.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { Store } from '../server/store.js';
import { nativeFixtureStream } from './runtime/project-model-fixture.js';

const id=randomUUID(), credential='fixture-'+id, token='file-'+randomUUID(), outside='private-'+randomUUID();
const target='report.txt', forbidden='other.txt', keyEnv='P2_SYNTHETIC_CODEX_REVIEW';
const root=await mkdtemp(join(await realpath(tmpdir()),'p2-review-codex-')), project=join(root,'project');
const report=resolve('.local-data/validation/native-project-p2','codex-review-'+id+'.json');
const expectedHash=createHash('sha256').update(token).digest('hex');
const rounds:{step:number;forbiddenMarkerAbsent:boolean;allowedResult:boolean;scopeRefusal:boolean;dangerousNativeTools:string[]}[]=[];
const endpoint=createServer(async (req,res)=>{
  try {
    assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,'Bearer '+credential);
    let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<4000000);}
    const input=JSON.parse(raw), tools=input.tools.flatMap((tool:any)=>[tool.name,...(tool.tools??[]).map((nested:any)=>nested.name)]).filter(Boolean);
    // A model must not receive the project AGENTS.md, or the content of an unlisted file.
    assert(!raw.includes(outside));assert(tools.includes('project_review_read'));
    const results=JSON.stringify(input.input.filter((item:any)=>item.type==='function_call_output'));
    const step=rounds.length;assert(step<3,'unexpected model round');
    const round={step,forbiddenMarkerAbsent:true,allowedResult:results.includes(token)&&results.includes(expectedHash),scopeRefusal:results.includes('Tool request was rejected'),
      dangerousNativeTools:tools.filter((name:string)=>['shell','shell_command','exec_command','view_image','apply_patch','spawn_agent','write_stdin'].includes(name))};
    rounds.push(round);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(nativeFixtureStream('codex',input.model,'review_'+step,'Review complete',step<2?{name:'project_review_read',args:{path:step===0?target:forbidden}}:undefined));
  } catch(error) { console.error(String(error));res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"fixture mismatch"}'); }
});
const owner=new Store(join(root,'private','platform.sqlite'));
const store=new CollaborationStore(owner,{workspace:project,projectWorkAvailability:()=>({available:true})});
const runtime=createCollaborationRuntime({timeoutMs:45000});
const engine=new CollaborationEngine(store,{...runtime,invoke(r){assert(r.projectReview && !r.projectWork && r.account.apiKeyEnv===keyEnv && r.member.id==='codex');return runtime.invoke(r);}},{workspace:project});
try {
  await mkdir(project);await writeFile(join(project,target),token);await writeFile(join(project,forbidden),outside);await writeFile(join(project,'AGENTS.md'),outside);
  await new Promise<void>((ready,fail)=>{endpoint.once('error',fail);endpoint.listen(0,'127.0.0.1',ready);});
  process.env[keyEnv]=credential;
  store.saveAccount({id:'review-fixture',provider:'codex',auth:'api',name:'Local only',baseUrl:'http://127.0.0.1:'+(endpoint.address() as AddressInfo).port+'/v1',apiKeyEnv:keyEnv});
  const reviewer=store.members().find(m=>m.id==='codex')!;
  store.saveMember({...reviewer,model:'gpt-5',modelBinding:'override',accountId:'review-fixture',accountBinding:'override'});
  const cid=store.create({title:'Review fixture',memberIds:['claude','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
  const preview=store.workbench.previewWorkspace(cid,{path:project,mode:'project-work'});store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  const submitted=store.projects.submit(cid,{content:'@Claude Code 修改项目报告，然后请 Codex 审阅。',requestId:randomUUID()});assert.ok('source' in submitted && submitted.source.projectWork);
  const author=store.admitNext()!.invocations[0]!;assert.equal(author.memberId,'claude');store.startInvocation(author.id);
  store.recordEvidence(author.id,{kind:'accepted',detail:{source:'fixture-author'}});
  const {sourceId}=store.requestCollaboration(author.id,'review-source',{targets:['codex'],content:'独立核对 report.txt 的内容。',projectReview:{paths:[target]}});
  store.recordEvidence(author.id,{kind:'process_exit',detail:{confirmed:true}});store.finish(author.id,'succeeded','已申请评审。');
  engine.start();const deadline=Date.now()+55000;
  while(Date.now()<deadline && !store.invocations(cid).some(i=>i.memberId==='codex'&&['succeeded','failed','interrupted'].includes(i.status))) await new Promise(r=>setTimeout(r,100));
  const d=store.detail(cid),reader=d.invocations.find(i=>i.memberId==='codex')!;
  assert.equal(reader?.status,'succeeded',JSON.stringify(d.responses.map(r=>r.content)));assert.equal(reader.acceptance,'accepted');assert.equal(reader.teardown,'confirmed');
  const evidence=d.evidence.filter(e=>e.invocationId===reader.id), reads=evidence.filter(e=>e.detail.origin==='project_review'&&e.detail.state==='read');
  assert.equal(reads.length,1);assert.equal(reads[0]!.detail.path,target);assert.equal(reads[0]!.detail.sha256,expectedHash);
  assert.equal(rounds.length,3);assert.equal(rounds[1]!.allowedResult,true);assert.equal(rounds[2]!.scopeRefusal,true);
  assert(rounds.every(r=>r.dangerousNativeTools.length===0),'unexpected built-in tools '+JSON.stringify(rounds));
  const result={case:'真实宿主 Codex 限定文件评审，作者与模型答复均为合成夹具',id,sourceId,nativeSessionId:reader.nativeSessionId,nativeTurnId:reader.nativeTurnId,
    acceptance:reader.acceptance,teardown:reader.teardown,read:{path:target,sha256:expectedHash},rounds,paidCalls:0};
  await mkdir(resolve(report,'..'),{recursive:true});await writeFile(report,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(report);
} finally {await engine.stop();endpoint.closeAllConnections();await new Promise<void>(done=>endpoint.close(()=>done()));owner.close();delete process.env[keyEnv];await rm(root,{recursive:true,force:true});}
