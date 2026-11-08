// Two separate server processes and one synthetic Mac project. --preflight starts no model turn or VM lease.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CollaborationAccount, CollaborationRuntime, Member, WorkspaceGrant } from '../shared/collaboration.js';
import { createApplication } from '../server/index.js';
import { acquireProjectVm } from '../server/collaboration/project-vm-mount.js';
import { readProjectVm } from '../server/collaboration/project-vm.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { projectSessionIdentity } from '../server/collaboration/runtime-session.js';

const exec = promisify(execFile);
const option = process.argv[2];
assert(['--preflight','--live','--worker'].includes(option), 'Usage: verify-official-project-continuity.ts --preflight | --live');
const vm = readProjectVm(resolve(process.env.P6_VM_CONFIG || '.local-data/validation/native-project-p6/vm/p03.json'));
assert(vm?.instance === 'p03' && vm.manageMount && vm.officialExecutors?.includes('codex-app-server') &&
  basename(vm.hostRoot).startsWith('multi-agent-vm-project-'), 'use the registered p03 test VM and synthetic project');
const account: CollaborationAccount = {id:'codex-project-cli', name:'Codex 项目专用登录', provider:'codex', auth:'cli' as const, codexHome:'project' as const};
const member: Member = {id:'codex', name:'Codex', carrier:'codex-app-server', enabled:true, instructions:'按用户逐轮执行项目任务。',
  accountId:account.id, accountBinding:'override', modelBinding:'override', model:process.env.P6_CODEX_MODEL};
const originalGrant: WorkspaceGrant = {path:vm.hostRoot, device:vm.device, inode:vm.inode, mode:'project-work',
  conversationId:'p6-dedicated-login-check', memberIds:[member.id], revision:1, authorizedAt:new Date().toISOString()};
const markerPattern = /P6_PRIVATE_[a-f0-9]{32}/;
const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const storeJson = (file:string, data:unknown) => writeFile(file, JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});

async function serveTurn(run:string, work:string, turn:1|2, cid:string|undefined) {
  const native = createCollaborationRuntime({ projectVm:vm, timeoutMs:200_000 });
  const runtime: CollaborationRuntime = {...native, async invoke(request) {
    assert.deepEqual([request.account.id,request.account.auth,request.account.codexHome,request.member.model],
      [account.id,'cli','project',member.model]);
    assert(request.projectWork && request.projectContinuity && request.sessionPlan?.identity?.projectAccountFingerprint);
    assert.equal(request.workspaceGrant?.path, work);
    assert(!markerPattern.test(request.prompt),'the file-only marker leaked into the platform prompt');
    // Durable hard limit across retries and process restarts.
    await storeJson(join(run,'turn-'+turn+'-dispatch.json'),{invocation:request.invocationId, account:request.account.id,
      platformPromptSha256:digest(request.prompt), platformPromptContainsMarker:false});
    let accepted = false;
    return native.invoke({...request,onEvent:event=>{
      if (event.kind==='accepted' && !accepted) {
        accepted=true;
        writeFileSync(join(run,'turn-'+turn+'-accepted.json'),JSON.stringify({invocation:request.invocationId}),{flag:'wx',mode:0o600});
      }
      request.onEvent(event);
    }});
  }};
  const app = await createApplication({port:0, dataDir:join(run,'db'), workspace:join(run,'default'), collaborationRuntime:runtime});
  const store = app.collaborationStore;
  try {
    const {url} = await app.start();
    const post = async (path:string, data:unknown) => {
      const response = await fetch(url+path, {method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(data)});
      assert(response.ok,'HTTP '+response.status+' at '+path);
      return response.json();
    };
    if (turn === 1) {
      assert(store.accounts().some(a=>a.id===account.id && a.codexHome==='project' && a.auth==='cli'), 'dedicated Codex account missing from isolated database');
      store.saveMember(member);
      const chat = await post('/api/conversations',{title:'项目记忆接续验证',memberIds:[member.id],defaultMemberId:member.id,requestId:randomUUID()});
      cid = chat.conversation.id;
    }
    assert(cid);
    const endpoint = '/api/conversations/'+cid;
    let sourceId: string;
    if (turn === 1) {
      const first = await post(endpoint+'/messages',{content:'@Codex 在项目目录实际运行 cat marker.txt 读取完整标记，然后删除 marker.txt，只新建 ready.txt 写入 ready 并结束本轮。不要在回复或其他文件里留下标记。等我下一条说“继续”，再根据你上轮读到的标记新建 recovered.txt，文件只写那个标记。',requestId:randomUUID()});
      assert(first.intent?.id && !first.source);
      const selected = await post(endpoint+'/workspace-preview',{path:work});
      const grant = await post(endpoint+'/workspace-preview',{fromPreviewId:selected.id,mode:'project-work',intentId:first.intent.id});
      await post(endpoint+'/workspace-apply',{previewId:grant.id,requestId:randomUUID()});
      const sources=store.detail(cid).sources;
      assert.equal(sources.length,1);
      sourceId=sources[0].id;
    } else {
      const next = await post(endpoint+'/messages',{content:'继续', requestId:randomUUID()});
      assert(next.source?.projectWork, 'continuation was not routed to the existing project assignment');
      sourceId=next.source.id;
    }
    const deadline = Date.now()+260_000;
    while (Date.now() < deadline) {
      const detail = store.detail(cid);
      const inv = detail.invocations.find(r=>store.contract(r.id).primarySourceId===sourceId &&
        !['prepared','running','cancel_requested'].includes(r.status));
      if (!inv) { await delay(300); continue; }
      assert.deepEqual([inv.status,inv.acceptance,inv.teardown],['succeeded','accepted','confirmed'],'turn '+turn+' did not succeed with confirmed teardown');
      assert.equal(detail.invocations.length,turn);
      assert.equal(detail.sources.length,turn);
      assert(!detail.messages.some(m=>markerPattern.test(m.content)), 'the marker was disclosed in public chat');
      const events = detail.evidence.filter(e=>e.invocationId===inv.id);
      const guest = events.find(e=>e.kind==='process_exit' && e.detail.transport==='linux-project-executor' && e.detail.confirmed===true);
      const domain = events.find(e=>e.kind==='diagnostic' && e.detail.observation==='project_pid_namespace_v1');
      const auth = events.find(e=>e.kind==='diagnostic' && e.detail.authentication==='cli' && e.detail.modelProvider==='openai' && e.detail.environmentId);
      const session = events.find(e=>e.kind==='session' && e.detail.historyVerified===true && e.detail.anchor===inv.nativeTurnId);
      assert(guest && domain && auth && session && inv.nativeSessionId && inv.nativeTurnId, 'missing official identity, checkpoint, project execution or exit evidence');
      assert(events.some(e=>e.detail.origin==='native' && e.detail.state==='completed'), 'missing native tool receipt');
      assert.equal(inv.continuity, turn===1?'fresh':'resumed');
      assert.equal(inv.sessionPlan?.mode, turn===1?'fresh':'resume');
      await storeJson(join(run,'turn-'+turn+'.json'), {serverPid:process.pid, conversation:cid, invocation:inv.id, continuity:inv.continuity,
        session:inv.nativeSessionId, turn:inv.nativeTurnId, previousInvocation:inv.sessionPlan?.previousInvocationId, previousAnchor:inv.sessionPlan?.previousAnchor,
        verifiedAnchor:session.detail.anchor, guestExit:guest.id, domain:{boot:domain.detail.bootId,pid:domain.detail.pid,ticks:domain.detail.ticks,namespace:domain.detail.namespace},
        officialIdentityReceipt:auth.id, model:member.model, publicMessagesContainMarker:false});
      return;
    }
    throw Error('timed out waiting for turn '+turn);
  } finally { await app.close(); }
}

async function coordinator() {
  const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p6/official-sessions');
  await mkdir(output,{recursive:true,mode:0o700});
  const run = await mkdtemp(join(output,option==='--live'?'live-':'preflight-'));
  const result: Record<string,unknown> = {account:account.id, status:'unverified', dispatches:0, acceptedTurns:0};
  let authorized = false;
  try {
    const identity = await projectSessionIdentity({member,account,cwd:originalGrant.path,workspaceGrant:originalGrant,
      projectWork:true,projectContinuity:true},vm,process.env.COLLAB_CODEX_PATH || 'codex');
    if (!identity.supported || !identity.projectAccountFingerprint || option==='--preflight') {
      result.eligible = !!(identity.supported && identity.projectAccountFingerprint);
      result.reason = result.eligible ? '本次仅核验专用登录，尚未发送项目委托。' : identity.reason;
      if (option==='--live') process.exitCode=2;
      return;
    }
    assert(member.model && /^[\w.-]{1,120}$/.test(member.model),'set P6_CODEX_MODEL to an enabled fixed model for this dedicated account');
    const work = await mkdtemp(join(await realpath(vm!.hostRoot),'p6-thread-'));
    const marker = 'P6_PRIVATE_'+randomUUID().replaceAll('-','');
    await writeFile(join(work,'marker.txt'),marker+'\n',{mode:0o600,flag:'wx'});
    const childScript = fileURLToPath(import.meta.url);
    async function phase(n:1|2,cid?:string) {
      await exec(process.execPath,['--import','tsx',childScript,'--worker',run,work,String(n),...(cid?[cid]:[])],
        {maxBuffer:65536,timeout:360_000}).catch(error=>{
          // Do not emit process environments, platform prompts, model output or account data.
          const excerpt = String(error.stderr || '').split('\n').find(l=>l.startsWith('Error:') || l.startsWith('AssertionError'));
          throw Error('turn '+n+' process failed'+(excerpt?': '+excerpt.slice(0,200):''));
        });
      return JSON.parse(await readFile(join(run,'turn-'+n+'.json'),'utf8'));
    }
    authorized = true;
    const first = await phase(1);
    assert.deepEqual(await readdir(work),['ready.txt'], 'marker or an alternate copy remained in the project');
    assert.equal((await readFile(join(work,'ready.txt'),'utf8')).trim(),'ready');
    const second = await phase(2,first.conversation);
    const recovered = await readFile(join(work,'recovered.txt'),'utf8');
    assert.equal(recovered.trim(),marker);
    assert.deepEqual((await readdir(work)).sort(),['ready.txt','recovered.txt']);
    assert.equal(second.session,first.session); assert.equal(second.previousAnchor,first.turn);
    assert.equal(second.previousInvocation,first.invocation);
    assert.notEqual(second.turn,first.turn); assert.notEqual(second.invocation,first.invocation);
    assert.notEqual(second.serverPid,first.serverPid); assert.notDeepEqual(second.domain,first.domain);
    Object.assign(result,{status:'passed',serverRestarted:true,sameOfficialThread:true,originalDeleted:true,
      recoveredFileSha256:digest(recovered), testedMarkerSha256:digest(marker), turns:[first,second]});
  } catch (error) {
    result.status='failed'; result.error=error instanceof Error?error.message.slice(0,250):'validation failed';
    process.exitCode=1;
  } finally {
    if (authorized) {
      try { const lease = await acquireProjectVm(vm!,originalGrant,AbortSignal.timeout(180_000)); await lease.release(true); result.originalMountRestored=true; }
      catch { result.originalMountRestored=false; result.status='failed'; process.exitCode=1; }
    }
    result.dispatches=[1,2].filter(n=>existsSync(join(run,'turn-'+n+'-dispatch.json'))).length;
    result.acceptedTurns=[1,2].filter(n=>existsSync(join(run,'turn-'+n+'-accepted.json'))).length;
    result.verifiedTurns=[1,2].filter(n=>existsSync(join(run,'turn-'+n+'.json'))).length;
    await storeJson(join(run,'result.json'),result);
    console.log(result.status,join(run,'result.json'));
  }
}
if (option === '--worker') {
  const [run,work,stage,cid] = process.argv.slice(3);
  assert(['1','2'].includes(stage) && basename(work).startsWith('p6-thread-') && resolve(work,'..')===vm.hostRoot);
  await serveTurn(run,work,stage==='1'?1:2,cid);
} else await coordinator();
