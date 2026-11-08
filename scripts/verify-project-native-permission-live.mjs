// One real member execution in an isolated project on the p03 acceptance VM.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';
import { readProjectVm } from '../server/collaboration/project-vm.ts';
import { acquireProjectVm } from '../server/collaboration/project-vm-mount.ts';

const [flag, carrier, decision, operation = 'file', command = 'git --version'] = process.argv.slice(2);
assert(flag === '--live' && ['claude','codex-api','codex-official'].includes(carrier) &&
  ['allow_once','decline','cancel'].includes(decision) && ['file','command','managed'].includes(operation) && ['git --version','node --version','pwd'].includes(command), 'Usage: --live claude|codex-api|codex-official allow_once|decline|cancel [file|command|managed] [command-to-review]');
const managed = operation==='managed';
const executionDirectory = managed ? '/work' : '/mnt/project';
const vm = readProjectVm(resolve(process.env.PERMISSION_VM_CONFIG || '.local-data/validation/native-project-p7/p03.json'));
assert(vm?.instance === 'p03' && vm.manageMount && basename(vm.hostRoot).startsWith('multi-agent-vm-project-'));
const mount = async () => JSON.parse(await readFile(join(vm.limaHome,vm.instance,'lima.yaml'),'utf8')).mounts[0].location;
assert.equal(await mount(),vm.hostRoot,'p03 has an existing active project');
const claude = carrier === 'claude';
const official = carrier === 'codex-official';
const memberId = claude ? 'claude' : 'codex';
const name = claude ? 'Claude Code' : 'Codex';
const key = claude ? 'COLLAB_GLM_API_KEY' : 'COLLAB_DEEPSEEK_API_KEY';
if (!official) assert(process.env[key],'configured API account is unavailable');
const baseUrl = claude ? 'https://open.bigmodel.cn/api/anthropic' : 'https://api.deepseek.com';
const model = claude ? 'glm-5.3' : 'deepseek-flash';
const account = {id:'permission-member',name:official ? 'Codex 官方登录' : name+' API', provider:memberId,
  auth:official ? 'cli' : 'api',...(!official && {apiKeyEnv:key,baseUrl})};
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p8/permissions-live');
await mkdir(output,{recursive:true,mode:0o700});
const run = await mkdtemp(join(output,carrier+'-'+operation+'-'+decision+'-'));
const project = await mkdtemp(join(await realpath(vm.hostRoot),'permission-'));
const file = 'review-note.txt';
const marker = 'CONFIRM-'+randomUUID();
const fileContents = () => readFile(join(project,file),'utf8').catch(e => { if(e.code==='ENOENT') return null; throw e; });
const original = { path:vm.hostRoot,device:vm.device,inode:vm.inode,mode:'project-work',
  memberIds:[memberId],conversationId:'permission-acceptance-restore',revision:1 };
const proof = {carrier,auth:account.auth,operation,...(operation!=='file' && {command}),decision,project,realMemberExecutions:0,nativeToolEvents:[]};
let app,restore = false;

try {
  process.env.CLAUDE_CONFIG_DIR = join(run,'claude-home');
  await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});
  const base = createCollaborationRuntime({projectVm:vm,timeoutMs:220000});
  const runtime = {...base, async invoke(req) {
    assert(req.projectWork && req.workspaceGrant?.nativeFileApprovals && req.cwd === project);
    assert.equal(req.account.auth,account.auth);
    assert.equal(req.member.id,memberId);
    assert.equal(proof.realMemberExecutions,0,'only one real execution per case');
    proof.realMemberExecutions++;
    return base.invoke({...req,onEvent(event) {
      if (event.kind === 'tool' && event.detail?.origin === 'native') {
        const {name,callId,state,path,paths,exitCode} = event.detail;
        proof.nativeToolEvents.push({name,callId,state,path,paths,exitCode});
      }
      req.onEvent(event);
    }});
  }};
  app = await createApplication({port:0,workspace:join(run,'default'), dataDir:join(run,'db'),collaborationRuntime:runtime});
  const {url} = await app.start();
  const store = app.collaborationStore;
  async function send(path,body) {
    return fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
  }
  async function post(path,body) {
    const res = await send(path,body), result = await res.json();
    assert(res.ok,path+' HTTP '+res.status+' '+(result.error || ''));
    return result;
  }
  store.saveAccount(account);
  store.saveMember({id:memberId,name,enabled:true,accountId:account.id,accountBinding:'override',modelBinding:'override',
    carrier:claude ? 'claude-cli' : 'codex-app-server',...(!official && {model}),
    instructions:'使用用户指定的原生文件编辑工具。收到拒绝就结束本轮，不尝试其他方式。'});
  const {conversation} = await post('/api/conversations',{title:'确认写入文件',memberIds:[memberId],defaultMemberId:memberId,requestId:randomUUID()});
  const endpoint = '/api/conversations/'+conversation.id;
  const selected = await post(endpoint+'/workspace-preview',{path:project,mode:'project-work',nativeFileApprovals:true});
  restore = true;
  await post(endpoint+'/workspace-apply',{previewId:selected.id,requestId:randomUUID()});
  const native = claude ? 'Write' : 'apply_patch';
  const task = operation === 'file'
    ? '用原生 '+native+' 工具用绝对路径新建 /mnt/project/'+file+'，仅写一行 '+marker+'。'
    : managed ? '在项目中运行命令。请调用平台的 project_environment_check，查询 '+command+' 的实际输出；使用项目隔离副本完成本次查询。'
    : '在项目中运行命令。用原生终端在 /mnt/project 运行 '+command+'，向我报告命令的实际输出。请使用单独命令，不加其他参数。';
  await post(endpoint+'/messages',{requestId:randomUUID(),content:
    '@'+name+' 请在此项目中工作，'+task+'仅请求一次该操作。如被拒绝，请直接回复未执行并结束。'});
  let record, invocation;
  const deadline = Date.now()+250000;
  while (Date.now()<deadline) {
    const view = store.detail(conversation.id);
    invocation = view.invocations[0];
    const pending = view.interactions?.find(r=>r.state==='pending' && (managed ? r.transport==='project-check' :
      operation==='file' ? r.fileChange : r.nativeCommand));
    if (pending && !record) {
      assert.equal(pending.memberId,memberId); assert.equal(pending.invocationId,invocation.id);
      if (operation==='file') {
        assert.equal(pending.fileChange.path,file); assert(pending.fileChange.preview.includes(marker));
      } else {
        assert.equal(pending.nativeCommand.cwd,executionDirectory); assert(pending.nativeCommand.command.includes(command));
        assert(!proof.nativeToolEvents.some(e=>e.callId===pending.nativeItemId && e.state==='completed'));
        if (managed) {
          assert.equal(pending.operation,'project_environment_check');
          assert(!view.evidence.some(e=>e.invocationId===invocation.id && e.detail?.origin==='project_environment' &&
            e.detail.callId===pending.nativeItemId && ['started','completed'].includes(e.detail.state)));
        }
      }
      assert.equal(await fileContents(),null,'file already written before approval');
      record = pending;
      proof.beforeAbsent = true;
      proof.request = {id:record.id,operation:record.operation,transport:record.transport,nativeItemId:record.nativeItemId,
        nativeSessionId:record.nativeSessionId,nativeTurnId:record.nativeTurnId,target:pending.nativeCommand ?? file,payloadDigest:record.payloadDigest};
      const answer = {decision,expectedRevision:record.revision,payloadDigest:record.payloadDigest,requestId:randomUUID()};
      const route = '/api/runtime-interactions/'+record.id+'/answer';
      await post(route,answer);
      const late = await send(route,{...answer,decision:'allow_once',requestId:randomUUID()});
      proof.lateDecisionStatus = late.status;
      assert.equal(late.status,409);
    }
    if(invocation && !['running','prepared','cancel_requested'].includes(invocation.status)) break;
    await delay(200);
  }
  const detail = store.detail(conversation.id);
  proof.invocationId = invocation?.id;
  proof.status = invocation?.status;
  proof.acceptance = invocation?.acceptance;
  proof.teardown = invocation?.teardown;
  proof.error = invocation?.error;
  proof.interactions = detail.interactions?.map(i=>({state:i.state,operation:i.operation,delivery:i.delivery,reason:i.reason}));
  const actual = await fileContents();
  proof.afterAbsent = actual===null;
  proof.fileMatches = actual?.trim()===marker;
  assert(record,'no matching approval request reached the conversation');
  assert.equal(proof.acceptance,'accepted');
  assert.equal(proof.teardown,'confirmed');
  if (decision==='allow_once') {
    assert.equal(proof.status,'succeeded');
    if (operation==='file') assert(proof.fileMatches);
    else {
      const expected=command==='pwd' ? executionDirectory : /\b[0-9]+\.[0-9]+\.[0-9]+\b/;
      assert(detail.messages.some(m=>m.memberId===memberId && (typeof expected==='string' ? m.content.includes(expected) : expected.test(m.content))),'missing command output');
    }
    if (managed) {
      const observed=detail.evidence.filter(e=>e.invocationId===invocation.id && e.kind==='tool' &&
        e.detail.origin==='project_environment' && e.detail.name==='project_environment_check' &&
        e.detail.callId===record.nativeItemId && e.detail.nativeSessionId===record.nativeSessionId && e.detail.nativeTurnId===record.nativeTurnId);
      proof.managedEvidence=observed.map(({id,detail})=>{
        const {origin,name,callId,state,exitCode,snapshotSha256,treeExited}=detail;
        return {id,origin,name,callId,state,exitCode,snapshotSha256,treeExited};
      });
      assert(observed.some(e=>e.detail.state==='started'),'missing managed executor start');
      assert(observed.some(e=>e.detail.exitCode===0 && e.detail.state==='completed' && e.detail.treeExited===true &&
        /^[a-f\d]{64}$/.test(e.detail.snapshotSha256)),'missing managed executor completion');
    } else assert(proof.nativeToolEvents.some(e=>e.callId===record.nativeItemId && e.state==='completed'),'missing matching native completion');
  } else {
    assert(proof.afterAbsent);
    assert.equal(proof.status,decision==='cancel' ? 'cancelled' : 'succeeded');
    assert(detail.interactions.some(i=>i.id===record.id && i.delivery==='returned_to_adapter' &&
      i.state===(decision==='cancel'?'cancelled':'declined')));
    assert(!proof.nativeToolEvents.some(e=>e.callId===record.nativeItemId && e.state==='completed'));
  }
  proof.passed=true;
} catch(error) {
  proof.passed=false;proof.reason=String(error.message).slice(0,420);process.exitCode=1;
} finally {
  try { await app?.close(); }
  finally {
    if (restore) {
      try {
        const lease = await acquireProjectVm(vm,original,AbortSignal.timeout(180000));
        await lease.release(true);
        proof.mountRestored = await mount() === vm.hostRoot;
      } catch { proof.mountRestored=false; }
      if (!proof.mountRestored) {proof.passed=false;process.exitCode=1;}
    }
    await writeFile(join(run,'result.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
    console.log(proof.passed ? 'PASS' : 'FAIL',join(run,'result.json'));
  }
}
