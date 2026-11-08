// One real project delegation. Both CLI invocations use the normal chat and scheduler paths.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { CollaborationAccount, CollaborationBootstrap, CollaborationRuntime, WorkspaceGrant } from '../shared/collaboration.js';
import { createApplication } from '../server/index.js';
import { acquireProjectVm } from '../server/collaboration/project-vm-mount.js';
import { readProjectVm } from '../server/collaboration/project-vm.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { createMonthlyFixture, rerunMonthlyTest } from './runtime/monthly-project-fixture.js';

const expanded = process.argv.includes('--project-review');
assert.deepEqual(process.argv.slice(2), expanded ? ['--live','--project-review'] : ['--live'],
  'Usage: node --import tsx scripts/verify-project-relay.ts --live [--project-review]');
const vm = readProjectVm(resolve(process.env.P5_VM_CONFIG ?? '.local-data/validation/native-project-p5/p03.json'));
assert(vm?.instance === 'p03' && vm.manageMount && vm.officialExecutors?.includes('codex-app-server') &&
  basename(vm.hostRoot).startsWith('multi-agent-vm-project-'), 'P5 requires the dedicated, registered p03 test instance');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR ?? (expanded ? '.local-data/validation/native-project-p6/executions' : '.local-data/validation/native-project-p5/executions'));
await mkdir(output, {recursive:true, mode:0o700});
const run = await mkdtemp(join(output, 'relay-'));
const work = await mkdtemp(join(await realpath(vm.hostRoot), 'p5-monthly-'));
console.log('P5 evidence:', run, 'Synthetic Mac project:', work);

const token = randomUUID().replaceAll('-', '');
const reviewId = 'REVIEW_' + randomUUID().replaceAll('-', '');
const originals = await createMonthlyFixture(work, token);
originals['export.py'] = '# Report format ID: ' + reviewId + '\n' + originals['export.py'];
await writeFile(join(work, 'export.py'), originals['export.py']);
const reviewNotes = 'review-' + randomUUID().slice(0,8) + '.txt';
const reviewToken = 'RULE_' + randomUUID().replaceAll('-', '');
if (expanded) await writeFile(join(work, reviewNotes),reviewToken+'\n');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const evidence: Record<string, unknown> = {project:work, invocationLimit:{codex:1, claude:1}, passed:false};
const calls = {codex:0, claude:0};
const expectedReport = {rows:{zero:0, charge:11, refund:-3}, total:8};
const native = createCollaborationRuntime({projectVm:vm, timeoutMs:240_000});
async function repairedProject() {
  const changes = await readFile(join(work, 'export.py'), 'utf8');
  assert.notEqual(changes, originals['export.py']);
  assert.ok(changes.includes(reviewId), 'report format ID was changed');
  for (const path of ['ledger.csv', 'check.py'] as const)
    assert.equal(await readFile(join(work, path), 'utf8'), originals[path], 'original '+path+' changed');
  const checks = (await readFile(join(work, 'checks.log'), 'utf8')).trim().split('\n');
  assert.ok(checks.includes('fail') && checks.at(-1) === 'pass', 'expected original test failure, then passing rerun');
  assert.deepEqual(JSON.parse(await readFile(join(work,'monthly.json'),'utf8')),expectedReport);
  return {originalSha256:hash(originals['export.py']), repairedSha256:hash(changes),
    testSha256:hash(originals['check.py']), ledgerSha256:hash(originals['ledger.csv']), checks};
}
let beforeReview: Awaited<ReturnType<typeof repairedProject>> | undefined;
const runtime: CollaborationRuntime = {...native, async invoke(request) {
  assert.equal(request.workspaceGrant?.path,work);
  assert(!request.prompt.includes(reviewId) && (!expanded || !request.prompt.includes(reviewToken)), 'file-only review marker appeared in the platform input');
  if (request.member.id === 'codex') {
    assert.equal(request.member.carrier, 'codex-app-server');
    assert.equal(request.account.auth, 'cli');
    assert(request.projectWork && !request.projectReview);
    assert.equal(calls.codex, 0, 'author execution limit');
    calls.codex++;
  } else {
    assert.equal(request.member.id, 'claude');
    assert.equal(request.member.carrier, 'claude-cli');
    assert.equal(request.account.auth, 'api');
    assert.equal(request.account.id, 'claude-glm-key');
    assert.equal(request.member.model, 'glm-5.3');
    assert(!request.projectWork);
    assert.deepEqual(request.projectReview?.paths, ['export.py']);
    assert.equal(request.projectReview?.mode, expanded ? 'project' : undefined);
    assert.equal(calls.claude, 0, 'reviewer execution limit');
    beforeReview = await repairedProject();
    calls.claude++;
  }
  return native.invoke(request);
}};

const app = await createApplication({port:0, dataDir:join(run,'db'), workspace:join(run,'default'), collaborationRuntime:runtime});
const store = app.collaborationStore;
let cid: string | undefined;
let url = '';
let failure: unknown;
let authorized = false;
async function post(path: string, body: unknown) {
  const response = await fetch(url + path, {method:'POST', headers:{'content-type':'application/json','x-csrf-token':app.csrfToken}, body:JSON.stringify(body)});
  assert.ok(response.ok, 'HTTP '+response.status+' '+path.split('/').at(-1));
  return response.json();
}
async function terminal(id:string, member:string) {
  const limit = Date.now() + 340_000;
  while (Date.now() < limit) {
    const detail = store.detail(id);
    const invocation = detail.invocations.find(r=>r.memberId===member);
    if (invocation && !['prepared','running','cancel_requested'].includes(invocation.status)) {
      assert.equal(invocation.status, 'succeeded', member+' ended with '+invocation.status);
      assert.equal(invocation.teardown, 'confirmed');
      assert.equal(invocation.acceptance, 'accepted');
      return invocation;
    }
    if (member==='claude' && !detail.sources.some(s=>s.kind==='a2a')) throw Error('Author finished without requesting a file review');
    if (member==='claude' && !invocation && detail.deliveries.some(d=>d.memberId==='claude' && ['failed','held','cancelled'].includes(d.status)))
      throw Error('Reviewer delivery '+detail.deliveries.find(d=>d.memberId==='claude')?.status);
    await delay(250);
  }
  throw Error('Timed out waiting for '+member);
}
try {
  // Copy only the selected public account fields and resolve just its credential reference.
  const response = await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap');
  assert.ok(response.ok, 'existing account configuration unavailable');
  const configured = await response.json() as CollaborationBootstrap;
  const glm = configured.accounts.find(a=>a.id==='claude-glm-key');
  const reviewer = configured.members.find(m=>m.carrier==='claude-cli' && m.id==='claude' && m.enabled);
  assert(glm?.auth==='api' && glm.apiKeyEnv==='COLLAB_GLM_API_KEY' && glm.baseUrl==='https://open.bigmodel.cn/api/anthropic');
  assert(reviewer?.accountId===glm.id && reviewer.model==='glm-5.3');
  if (!process.env[glm.apiKeyEnv]) {
    const value = parseEnv(await readFile('.env','utf8'))[glm.apiKeyEnv];
    assert(value, 'GLM account credential is unavailable');
    process.env[glm.apiKeyEnv] = value;
  }
  const claudeHome = join(run, 'claude-home');
  await mkdir(claudeHome,{mode:0o700});
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const official: CollaborationAccount = {id:'p5-official-codex', name:'Codex 官方登录', provider:'codex', auth:'cli'};
  store.saveAccount(official);
  store.saveAccount({id:glm.id, name:glm.name, provider:glm.provider, auth:'api', baseUrl:glm.baseUrl, apiKeyEnv:glm.apiKeyEnv});
  for (const [id, name, carrier, accountId, model] of [
    ['codex','Codex','codex-app-server',official.id, undefined],
    ['claude','Claude Code','claude-cli',glm.id,reviewer.model]
  ] as const) {
    store.saveMember({id, name, carrier, enabled:true, accountId, model, accountBinding:'override', modelBinding:'override',instructions:'按用户委托处理项目问题。'});
  }
  ({url}=await app.start());
  const conversation = await post('/api/conversations',{title:'月报修复与评审', memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()});
  cid = String(conversation.conversation.id);
  const endpoint = '/api/conversations/'+cid;
  const msg = {content:'@Codex 请修复项目中 export.py 漏掉零金额流水的问题。请先运行 python3 check.py 复现，保留原测试、账本和文件里的格式标识，修改 export.py 后跑通同一测试。完成后请 Claude Code 独立评审 export.py：解释修改是否保留零金额，在评审意见里附上该文件实际的 Report format ID。请你本人在交接及回复中省略标识值，由评审者从文件核对。'+ (expanded ? '交接时文件清单只写 export.py，请 Claude 自己浏览项目找到 review- 开头的说明并在结论引用其中的编号，独立运行 python3 check.py 并报告真实退出结果。你无需替评审者读取该说明。' : ''),requestId:randomUUID()};
  const {intent} = await post(endpoint+'/messages',msg);
  assert(intent?.id, 'Expected a project authorization request for the writer');
  assert.deepEqual(intent.memberIds,['codex']);
  assert.equal(store.detail(cid).sources.length,0);
  const picked = await post(endpoint+'/workspace-preview',{path:work});
  const preview = await post(endpoint+'/workspace-preview',{fromPreviewId:picked.id, mode:'project-work',intentId:intent.id,...(expanded ? {reviewMode:'project'} : {})});
  authorized = true;
  await post(endpoint+'/workspace-apply',{previewId:preview.id,requestId:randomUUID()});
  const author = await terminal(cid,'codex'), reader = await terminal(cid,'claude');
  const detail = store.detail(cid);
  assert.equal(detail.invocations.length,2);
  assert.equal(detail.sources.length,2);
  const original = detail.sources.find(s=>s.kind==='user'), review = detail.sources.find(s=>s.kind==='a2a');
  assert(original?.projectWork && review?.projectReview);
  assert.deepEqual(original.requestedTargets,['codex']);
  assert.equal(review.parentInvocationId,author.id);
  assert.equal(review.authorMemberId,author.memberId);
  assert.deepEqual(review.requestedTargets,[reader.memberId]);
  assert.equal(review.projectReview.originalSourceId,original.id);
  assert.equal(store.contract(reader.id).primarySourceId,review.id);
  assert.equal(store.contract(author.id).primarySourceId,original.id);
  const writerEvents = detail.evidence.filter(e=>e.invocationId===author.id);
  const readerEvents = detail.evidence.filter(e=>e.invocationId===reader.id);
  const writerAuth = writerEvents.find(e=>e.kind==='diagnostic' && e.detail.authentication==='cli' && e.detail.modelProvider==='openai' && e.detail.environmentId && e.detail.projectDirectory);
  const guestExit = writerEvents.find(e=>e.kind==='process_exit' && e.detail.transport==='linux-project-executor' && e.detail.confirmed===true);
  const reviewerAuth = readerEvents.find(e=>e.kind==='diagnostic' && e.detail.authentication==='api' && e.detail.endpointOrigin==='https://open.bigmodel.cn' && e.detail.model==='glm-5.3' && e.detail.oauthFallback===false);
  assert(writerAuth && guestExit && reviewerAuth, 'missing runtime identity or guest exit evidence');
  const reviewTools = readerEvents.find(e=>e.kind==='diagnostic' && e.detail.observation==='project_review_tools' &&
    e.detail.evidence==='system.init' && e.detail.nativeSessionId===reader.nativeSessionId);
  assert(reviewTools, 'Claude did not confirm its active tools for this review session');
  assert.deepEqual(reviewTools.detail.tools, expanded ?
    ['mcp__platform__project_review_list','mcp__platform__project_review_read','mcp__platform__project_review_test'] :
    ['mcp__platform__project_review_read']);
  assert(writerEvents.some(e=>e.detail.origin==='native' && e.detail.state==='completed'));
  assert(writerEvents.some(e=>e.detail.name==='collaboration_request' && e.detail.state==='completed'));
  for (const events of [writerEvents,readerEvents]) assert(events.some(e=>e.detail.observation==='native_terminal' && e.detail.status==='succeeded'));
  const reviewMessage = detail.messages.find(m=>m.responseId===reader.responseId && m.memberId==='claude' && m.content.includes(reviewId));
  assert(reviewMessage && /零|zero|\b0\b/i.test(reviewMessage.content), 'review lacked an independently read format ID or an assessment of zero amounts');
  assert(detail.messages.some(m=>m.responseId===author.responseId && m.memberId==='codex' && m.content.trim()));
  if (expanded) {
    assert(reviewMessage.content.includes(reviewToken), 'reviewer did not cite the independently discovered file');
    const toolEvents = readerEvents.filter(e=>e.kind==='tool' && e.detail.origin==='project_review');
    const browse = toolEvents.find(e=>e.detail.state==='listed');
    const found = toolEvents.find(e=>e.detail.state==='read' && e.detail.path===reviewNotes && e.detail.sha256===hash(reviewToken+'\n'));
    const verified = toolEvents.find(e=>e.detail.state==='tested' && e.detail.exitCode===0 && e.detail.treeExited===true &&
      Array.isArray(e.detail.argv) && e.detail.argv.some((part:unknown)=>part==='check.py' || part==='./check.py'));
    assert(browse && found && verified, 'missing browsing, independently read file or isolated test exit');
    evidence.independentReview = {browse:browse.id, discoveredFile:found.id, testExit:verified.detail};
  }
  assert(beforeReview);
  const disk = await repairedProject();
  assert.deepEqual(disk,beforeReview, 'reviewer saw a different version from the final repair');
  const receipt = readerEvents.find(e=>e.kind==='tool' && e.detail.origin==='project_review' && e.detail.state==='read' && e.detail.path==='export.py' && e.detail.sha256===disk.repairedSha256);
  assert(receipt && reviewMessage.createdAt >= receipt.createdAt);
  const checkUrl = endpoint+'/project-reviews/'+reader.id+'/check';
  const checks = await post(checkUrl,{});
  assert.equal(checks.files[0].status,'unchanged');
  const grant = store.detail(cid).conversation.workspaceGrant;
  assert(grant?.path === work);
  const rerun = await acquireProjectVm(vm, grant, AbortSignal.timeout(120000));
  try { await rerunMonthlyTest(rerun.vm,null,'PASS_'+token); } finally { await rerun.release(true); }
  // A fresh GET and an idempotent retry of the original message must show the same two executions.
  await post(endpoint+'/messages',msg);
  const refreshed = await fetch(url+endpoint);
  assert.ok(refreshed.ok);
  const view = await refreshed.json();
  assert.deepEqual(view.invocations.map((r:{id:string})=>r.id).sort(),[author.id, reader.id].sort());
  assert.equal(view.sources.length,2);
  const stalePath = join(work,'export.py');
  const repaired = await readFile(stalePath,'utf8');
  try {
    await writeFile(stalePath,repaired+'\n# Independent post-review edit\n');
    const afterEdit = await post(checkUrl,{});
    assert.equal(afterEdit.files[0].status,'changed');
  } finally { await writeFile(stalePath,repaired); }
  Object.assign(evidence,{disk, independentlyReranOriginalTest:true, source:original.id, handoff:review.id, author:author.id, reviewer:reader.id,
    writerAuth:writerAuth.id, guestExit:guestExit.id, reviewerAuth:reviewerAuth.id,
    reviewerTools:{evidenceId:reviewTools.id, nativeSessionId:reader.nativeSessionId, tools:reviewTools.detail.tools},
    read:{id:receipt.id, path:receipt.detail.path, sha256:receipt.detail.sha256}, reviewMessage:{id:reviewMessage.id, content:reviewMessage.content},
    refreshAndRetryPreservedChain:true, externalChangeDetected:true});
} catch (error) {
  failure = error;
} finally {
  if (cid) {
    const detail = store.detail(cid);
    evidence.invocations = detail.invocations.map(i=>({id:i.id, member:i.memberId, status:i.status, acceptance:i.acceptance, teardown:i.teardown, nativeSessionId:i.nativeSessionId, nativeTurnId:i.nativeTurnId, error:i.error?.slice(0,200)}));
    evidence.sources = detail.sources.map(s=>({id:s.id, kind:s.kind, parent:s.parentInvocationId, targets:s.requestedTargets, reviewPaths:s.projectReview?.paths}));
    evidence.conversation = cid;
  }
  await app.close();
  // Use the normal lease and mount identity checks even when verification failed.
  if (authorized) {
    try {
      const original: WorkspaceGrant = {mode:'project-work',path:vm.hostRoot,device:vm.device,inode:vm.inode,
        conversationId:'restore-p5-fixture',memberIds:['operator'],revision:1,authorizedAt:new Date().toISOString()};
      const lease = await acquireProjectVm(vm,original,AbortSignal.timeout(240_000));
      await lease.release(true);
      evidence.originalMountRestored = true;
    } catch (error) { evidence.originalMountRestored=false; failure ??= error; }
  }
  evidence.calls = calls;
  evidence.passed = !failure;
  if (failure) evidence.error = failure instanceof Error ? failure.message : String(failure);
  let json = JSON.stringify(evidence,null,2);
  for (const [key,value] of Object.entries(process.env))
    if (/API_KEY|AUTH_TOKEN|CREDENTIAL/.test(key) && value && value.length>5) json=json.replaceAll(value,'[redacted]');
  await writeFile(join(run,'result.json'), json+'\n',{mode:0o600,flag:'wx'});
  console.log(evidence.passed?'passed':'failed', join(run,'result.json'));
  if (failure) process.exitCode=1;
}
