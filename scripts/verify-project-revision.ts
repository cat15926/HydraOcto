// Run a bounded, real four-execution relay against the dedicated synthetic p03 VM.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { createApplication } from '../server/index.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { readProjectVm } from '../server/collaboration/project-vm.js';
import { acquireProjectVm } from '../server/collaboration/project-vm-mount.js';
import type { CollaborationBootstrap, CollaborationRuntime, WorkspaceGrant } from '../shared/collaboration.js';

const holdAuthor = process.argv.includes('--hold-author');
const projectChecks = process.argv.includes('--project-checks');
const args = process.argv.slice(2);
assert(args.includes('--live') && args.length === new Set(args).size &&
  args.every(flag=>['--live','--hold-author','--project-checks'].includes(flag)), 'Run explicitly with --live [--hold-author] [--project-checks].');
const validation = resolve('.local-data/validation');
const phase = projectChecks ? 'p8' : 'p7';
const stage = join(validation,'native-project-'+phase);
const vm = readProjectVm(resolve((projectChecks ? process.env.P8_VM_CONFIG : process.env.P7_VM_CONFIG) ??
  join(validation,'native-project-p7','p03.json')));
assert(vm?.instance === 'p03' && vm.manageMount && vm.officialExecutors?.includes('codex-app-server') &&
  basename(vm.hostRoot).startsWith('multi-agent-vm-project-p03-'), 'Live revision checks require the registered synthetic p03 VM');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR ?? join(stage,'executions'));
await mkdir(output,{recursive:true,mode:0o700});
const run = await mkdtemp(join(output,'revision-'));
const work = await mkdtemp(join(await realpath(vm.hostRoot),phase+'-durations-'));
const dependency = {version:'2.1.3',resolved:'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
  integrity:'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='};
const sha = (text:string) => createHash('sha256').update(text).digest('hex');
const original = projectChecks
  ? "exports.duration = value => Number(value) || undefined;\n"
  : "const ms = require('ms');\nexports.duration = value => value === '0s' ? undefined : Math.abs(ms(value));\n";
const check = "const assert = require('node:assert/strict');\nconst {duration} = require('./duration.cjs');\n"+
  (projectChecks ? "assert.equal(duration('0'),0); assert.equal(duration('2'),2);\n" :
    "assert.equal(duration('0s'),0);\nassert.equal(duration('2s'),2000);\n"+
    "if (process.argv.includes('--edge')) assert.equal(duration('-1s'),-1000,'negative durations must retain their sign');\n");
const packageName = projectChecks ? 'typescript' : 'ms';
const lockedDependency = projectChecks ? {
  version:'5.9.3',resolved:'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',
  integrity:'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==',
  bin:{tsc:'bin/tsc',tsserver:'bin/tsserver'},
} : dependency;
const scripts = {test:'node check.cjs',...(projectChecks ? {
  typecheck:'tsc --noEmit quota.ts',build:'tsc --noCheck --outDir dist quota.ts && node dist/quota.js',
} : {})};
const manifest = {name:'duration-report',version:'1.0.0',scripts,dependencies:{[packageName]:lockedDependency.version}};
const lock = {name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,
  packages:{'':{name:manifest.name,version:manifest.version,dependencies:manifest.dependencies},['node_modules/'+packageName]:lockedDependency}};
const files:Record<string,string> = {'duration.cjs':original,'check.cjs':check,'package.json':JSON.stringify(manifest,null,2)+'\n',
  'package-lock.json':JSON.stringify(lock,null,2)+'\n'};
if (projectChecks) files['quota.ts'] = "export const reportLimit: number = '2';\n";
for (const [name,body] of Object.entries(files)) await writeFile(join(work,name),body,{flag:'wx'});

const cfg = await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap').then(async r => {assert(r.ok); return r.json() as Promise<CollaborationBootstrap>;});
const glm = cfg.accounts.find(a=>a.id==='claude-glm-key');
assert(glm?.auth==='api' && glm.apiKeyEnv==='COLLAB_GLM_API_KEY' && glm.baseUrl==='https://open.bigmodel.cn/api/anthropic');
if (!process.env[glm.apiKeyEnv]) {
  const value = parseEnv(await readFile('.env','utf8'))[glm.apiKeyEnv];
  assert(value,'Missing configured Claude API credential');
  process.env[glm.apiKeyEnv] = value;
}
process.env.CLAUDE_CONFIG_DIR = join(run,'claude-home');
await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});
const base = createCollaborationRuntime({projectVm:vm,timeoutMs:420000});
const calls = {codex:0,claude:0};
const compilerFailures = new Set<string>();
const runtime: CollaborationRuntime = {...base, async runProjectReviewTest(request) {
  const result = await base.runProjectReviewTest!(request);
  if (projectChecks && result.exitCode !== 0 && result.argv.join(' ') === 'npm run typecheck' && result.output.includes('TS2322')) {
    compilerFailures.add(sha(result.output));
  }
  return result;
}, async invoke(req) {
  const who = req.member.id;
  assert(who==='codex' || who==='claude');
  assert.equal(req.workspaceGrant?.path,work);
  assert(++calls[who]<=2,'model execution limit for '+who);
  if (who==='codex') assert(req.projectWork && req.account.auth==='cli');
  else assert(req.projectReview?.mode==='project' && req.account.id===glm.id && req.member.model==='glm-5.3');
  console.log('Started',who,calls[who]);
  if (holdAuthor && who==='codex' && calls.codex===1) {
    return base.invoke({...req,async onToolCall(name,args,id) {
      const result=await req.onToolCall(name,args,id);
      if (name==='collaboration_request' && args.projectReview) {
        const limit=Date.now()+120000;
        while (Date.now()<limit && !store.detail(req.conversationId).evidence.some(e=>e.detail.state==='waiting_for_project')) {
          await delay(200,undefined,{signal:req.signal});
        }
        assert(store.detail(req.conversationId).evidence.some(e=>e.detail.state==='waiting_for_project'),'expected a reviewer waiting for the actual author');
        await delay(32_000,undefined,{signal:req.signal});
      }
      return result;
    }});
  }
  return base.invoke(req);
}};
const app = await createApplication({port:0,dataDir:join(run,'db'),workspace:join(run,'default'),collaborationRuntime:runtime});
const store = app.collaborationStore;
const report:Record<string,unknown> = {work,calls};
let folderTouched=false, cid='', url='';
async function post(path:string,body:unknown) {
  const r = await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
  assert(r.ok,path+' returned '+r.status); return r.json();
}
try {
  const official = {id:phase+'-official',name:'Codex 官方登录',provider:'codex',auth:'cli'} as const;
  store.saveAccount(official);
  store.saveAccount({id:glm.id,name:glm.name,provider:glm.provider,auth:'api',baseUrl:glm.baseUrl,apiKeyEnv:glm.apiKeyEnv});
  for (const [id,name,carrier,accountId,model] of [['codex','Codex','codex-app-server',official.id,undefined],['claude','Claude Code','claude-cli',glm.id,'glm-5.3']] as const) {
    store.saveMember({id,name,carrier,enabled:true,accountId,model,accountBinding:'override',modelBinding:'override',instructions:'根据当前阶段的项目委托工作，以真实测试回执为准。'});
  }
  ({url} = await app.start());
  if (projectChecks) {
    const boot = await fetch(url+'/api/collaboration/bootstrap').then(r=>r.json() as Promise<CollaborationBootstrap>);
    assert.equal(boot.version,'0.23.0-p8-permissions');
    report.version = boot.version;
  }
  cid=String((await post('/api/conversations',{title:'工时报表修复与复验',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()})).conversation.id);
  const endpoint='/api/conversations/'+cid;
  const input={content:projectChecks ? '@Codex 先只修复 duration.cjs 漏掉零时长的问题，保持 quota.ts、check.cjs、清单和锁文件原样，用项目测试工具运行 npm test，取得退出码 0。完成后请 Claude Code 评审，有问题就继续改。发起结构化项目评审时请列出 duration.cjs、quota.ts，在委托里明确请 Claude 先读取它们，再独立用 project_review_test 依次执行 npm test、npm run build、npm run typecheck，三项都需真实回执。初评完成后结束该轮，报告具体失败交回原作者。退修时保留 reportLimit 的 number 类型和数值 2，修完在同一新版本用项目工具逐项自测，原评审人独立复验三项。' : '@Codex 修复 duration.cjs 中零时长被漏掉的问题，先只改零时长。用项目测试工具跑 npm test 验证，保留原测试及锁文件。完成后请 Claude Code 评审，有问题就继续改。请在评审委托里要求 Claude 读取 duration.cjs，并用 project_review_test 独立执行 npm test -- --edge 检查冲销时长的符号。如果失败，报告原失败并结束初评，由原作者根据意见修订。',requestId:randomUUID()};
  const initial=await post(endpoint+'/messages',input);
  assert(initial.intent?.id);
  const pick=await post(endpoint+'/workspace-preview',{path:work});
  const grant=await post(endpoint+'/workspace-preview',{fromPreviewId:pick.id,mode:'project-work',reviewMode:'project',intentId:initial.intent.id});
  folderTouched=true;
  await post(endpoint+'/workspace-apply',{previewId:grant.id,requestId:randomUUID()});
  const deadline=Date.now()+21*60*1000;
  const answered=new Set<string>();
  let previous='', lastChange=Date.now();
  while (true) {
    const d=store.detail(cid);
    for(const item of d.interactions ?? []) {
      if (item.state!=='pending' || answered.has(item.id)) continue;
      assert(item.transport==='project-npm' && item.operation==='npm_download' && item.payload.lockSha256===sha(files['package-lock.json']) &&
        item.payload.registry==='https://registry.npmjs.org' && Array.isArray(item.payload.packages) && item.payload.packages.length===1 &&
        String(item.payload.packages[0])===packageName+'@'+lockedDependency.version,'unexpected download scope');
      await post('/api/runtime-interactions/'+item.id+'/answer',{expectedRevision:item.revision,payloadDigest:item.payloadDigest,requestId:randomUUID(),answers:{download:'允许此次下载'}});
      answered.add(item.id);
    }
    const state=d.invocations.map(i=>i.memberId+' '+i.status).join(', ');
    if(state!==previous){console.log(state);previous=state;lastChange=Date.now();}
    const bad=d.invocations.find(i=>['failed','interrupted','cancelled'].includes(i.status));
    if (bad) throw Error('Incomplete '+bad.memberId+' invocation: '+(bad.error ?? bad.status));
    if (d.invocations.length===4 && d.invocations.every(i=>i.status==='succeeded' && i.teardown==='confirmed')) break;
    if (d.invocations.length && d.invocations.every(i=>i.status==='succeeded') && Date.now()-lastChange>8000) throw Error('Relay stopped after '+state);
    assert(Date.now()<deadline,phase+' relay timed out'); await delay(350);
  }
  const detail=store.detail(cid);
  const [writer,first,repair,second]=detail.invocations;
  assert(writer && first && repair && second);
  assert.deepEqual(detail.invocations.map(i=>i.memberId),['codex','claude','codex','claude']);
  assert(detail.invocations.every(i=>i.acceptance==='accepted'));
  const tool=(id:string,origin:string)=>detail.evidence.filter(e=>e.invocationId===id && e.detail.origin===origin && e.detail.state==='tested' && e.detail.treeExited===true);
  const commands=projectChecks ? [['npm','run','typecheck'],['npm','test'],['npm','run','build']] : [['npm','test','--','--edge']];
  const commandResult=(id:string,origin:string,argv:string[])=>tool(id,origin)
    .filter(e=>JSON.stringify(e.detail.argv)===JSON.stringify(argv)).at(-1)?.detail;
  const [target] = commands;
  const before=commandResult(first.id,'project_review',target), after=commandResult(second.id,'project_review',target);
  assert(before && typeof before.exitCode==='number' && before.exitCode!==0 && after && after.exitCode===0);
  assert.notEqual(before.snapshotSha256,after.snapshotSha256);
  if (projectChecks) assert(compilerFailures.has(String(before.outputSha256)),'initial typecheck must fail on the fixture type error');
  assert(commandResult(writer.id,'project_author_test',['npm','test'])?.exitCode===0);
  const verdict=detail.evidence.find(e=>e.invocationId===second.id && e.detail.state==='revision_verdict')?.detail;
  assert(verdict?.outcome==='passed');
  if (projectChecks) assert(Array.isArray(verdict.checks) && verdict.checks.length===commands.length && verdict.checks.every(c=>c.outcome==='passed'));
  const changed=await readFile(join(work,'duration.cjs'),'utf8');assert.notEqual(changed,original);
  const current=detail.conversation.workspaceGrant!;
  const independentResults=[];
  for (const argv of commands) {
    const initialCheck=commandResult(first.id,'project_review',argv);
    const authorCheck=commandResult(repair.id,'project_author_test',argv);
    const finalCheck=commandResult(second.id,'project_review',argv);
    assert(initialCheck && initialCheck.snapshotSha256===before.snapshotSha256 && (argv===target || initialCheck.exitCode===0));
    assert(authorCheck && authorCheck.exitCode===0 && authorCheck.snapshotSha256===after.snapshotSha256);
    assert(finalCheck && finalCheck.exitCode===0 && finalCheck.snapshotSha256===after.snapshotSha256);
    const proof=await base.runProjectReviewTest!({grant:current,argv,...(projectChecks ? {projectNpmChecks:true as const} : {}),signal:AbortSignal.timeout(180000),
      verifyAuthorization(){assert(current.path===work);},npm:{onPhase(){},authorizeDownload:async()=>{throw Error('expected verified cache');}}});
    assert(proof.exitCode===0 && proof.treeExited && proof.snapshotSha256===after.snapshotSha256);
    independentResults.push(proof);
  }
  const independent=independentResults[0];
  if (projectChecks) {
    const quota = await readFile(join(work,'quota.ts'),'utf8');
    assert.notEqual(quota,files['quota.ts']);
    Object.assign(report,{projectChecks:true,quotaShaBefore:sha(files['quota.ts']),quotaShaAfter:sha(quota),verdict,independentResults});
  }
  for(const name of ['check.cjs','package.json','package-lock.json'] as const) assert.equal(await readFile(join(work,name),'utf8'),files[name]);
  await post(endpoint+'/messages',input);
  assert.equal(store.detail(cid).sources.length,4);
  if(holdAuthor) {
    const started=detail.evidence.find(e=>e.invocationId===first.id && e.detail.state==='waiting_for_project');
    const began=detail.evidence.find(e=>e.invocationId===first.id && e.detail.state==='preparing');
    assert(started && began && Date.parse(began.createdAt)-Date.parse(started.createdAt)>=30000,'missing thirty-second writer handoff');
    report.waitedForWriterMs=Date.parse(began.createdAt)-Date.parse(started.createdAt);
  }
  Object.assign(report,{before,after,originalSha256:sha(original),repairedSha256:sha(changed),independent,calls,confirmedDownloads:answered.size,passed:true});
} catch(error) {
  report.passed=false;report.error=error instanceof Error ? error.message : 'Verification failed';process.exitCode=1;
} finally {
  if(cid){const d=store.detail(cid);report.invocations=d.invocations.map(i=>({id:i.id,member:i.memberId,status:i.status,teardown:i.teardown,acceptance:i.acceptance}));report.sources=d.sources.map(s=>({id:s.id,kind:s.kind,parent:s.parentInvocationId,targets:s.requestedTargets}));
    report.testReceipts=d.evidence.filter(e=>['project_review','project_author_test'].includes(String(e.detail.origin)) && e.detail.state==='tested')
      .map(e=>({invocationId:e.invocationId, ...e.detail}));}
  await app.close();
  if(folderTouched) try {
    const originalGrant:WorkspaceGrant={mode:'project-work',path:vm.hostRoot,device:vm.device,inode:vm.inode,memberIds:['operator'],conversationId:'restore-'+phase,revision:1,authorizedAt:new Date().toISOString()};
    const lease=await acquireProjectVm(vm,originalGrant,AbortSignal.timeout(240000));await lease.release(true);report.mountRestored=true;
  } catch {report.mountRestored=false;report.passed=false;process.exitCode=1;}
  await writeFile(join(run,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(report.passed?'PASS':'FAIL',join(run,'result.json'),report.error ?? '');
}
