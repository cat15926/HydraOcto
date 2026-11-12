// Usage: node --import tsx scripts/verify-hydra-obligation-live.mjs --live --author=claude [--drift]
// HYDRA_CONFIG_ROOT points at the existing installation. Its account database is opened read-only.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {parseEnv} from 'node:util';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {readProjectVm} from '../server/collaboration/project-vm.ts';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.ts';

const [mode, role, variant, ...extra] = process.argv.slice(2);
assert(['--check-config', '--live'].includes(mode) && ['--author=codex', '--author=claude'].includes(role) &&
  (!variant || variant === '--drift') && !extra.length, 'Choose --check-config or --live, --author=codex or --author=claude, optionally --drift');
const author = role.slice('--author='.length);
const reviewer = author === 'codex' ? 'claude' : 'codex';
const names = {codex:'Codex', claude:'Claude Code'};
const installed = resolve(process.env.HYDRA_CONFIG_ROOT || '.');
const vm = readProjectVm(resolve(process.env.ACCEPTANCE_VM_CONFIG || join(installed, '.local-data/validation/native-project-p7/p03.json')));
assert(vm?.instance === 'p03' && vm.manageMount && basename(vm.hostRoot).startsWith('multi-agent-vm-project-') &&
  vm.officialExecutors?.includes('codex-app-server'), 'Dedicated test VM p03 with official Codex project execution required');
const mount = async () => JSON.parse(await readFile(join(vm.limaHome, 'p03/lima.yaml'), 'utf8')).mounts[0].location;
assert.equal(await mount(), vm.hostRoot, 'Test VM is already assigned to a different project');
function accounts() {
  const config = new DatabaseSync(join(installed, '.local-data/platform.sqlite'), {readOnly:true});
  try {
    const account = id => JSON.parse(config.prepare('SELECT value FROM cc_accounts WHERE id = ?').get(id)?.value ?? 'null');
    const member = JSON.parse(config.prepare('SELECT value FROM cc_members WHERE id = ?').get('claude')?.value ?? 'null');
    assert(member?.enabled && member.carrier === 'claude-cli' && member.model, 'Configured Claude Code model required');
    const claude = account(member.accountId), codex = account('codex-cli');
    assert(claude?.provider === 'claude' && claude.auth === 'api' && /^[A-Z][A-Z0-9_]{0,99}$/.test(claude.apiKeyEnv) &&
      new URL(claude.baseUrl).origin === 'https://open.bigmodel.cn' && !claude.deletedAt, 'Configured Zhipu CLI API account required');
    assert(codex?.provider === 'codex' && codex.auth === 'cli' && !codex.codexHome && !codex.deletedAt, 'Configured general-purpose official Codex account required');
    return {claude, codex, model:member.model};
  } finally { config.close(); }
}
const selected = accounts();
async function loadRuntimeConfig() {
  const settings = parseEnv(await readFile(join(installed, '.env'), 'utf8').catch(e => {
    if (e.code === 'ENOENT') return '';
    throw e;
  }));
  for (const key of [selected.claude.apiKeyEnv, 'COLLAB_CODEX_PATH', 'COLLAB_CLAUDE_PATH']) {
    if (!process.env[key] && settings[key]) process.env[key] = settings[key];
  }
  assert(process.env[selected.claude.apiKeyEnv], 'Selected Zhipu account credential unavailable');
}
await loadRuntimeConfig();
if (mode === '--check-config') {
  console.log('Configuration present. No models or project processes started.');
  process.exit(0);
}
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/hydra-obligations');
await mkdir(output, {mode:0o700, recursive:true});
const run = await mkdtemp(join(output, author + (variant ? '-drift-' : '-normal-')));
const project = await mkdtemp(join(await realpath(vm.hostRoot), 'obligations-'));
const original = "export function sortOrders(ids) { return [...ids].sort(); }\n";
const test = "import assert from 'node:assert/strict';\nimport {sortOrders} from './orders.js';\n" +
  "assert.deepEqual(sortOrders(['ORD-12','ORD-3','ORD-101','ORD-2']), ['ORD-2','ORD-3','ORD-12','ORD-101']);\n";
const fixture = {
  'orders.js':original, 'orders.test.js':test,
  'package.json':JSON.stringify({name:'order-check',version:'1.0.0',type:'module',scripts:{test:'node --test orders.test.js'}}),
  'package-lock.json':JSON.stringify({name:'order-check',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'order-check',version:'1.0.0'}}}),
  'release.txt':'order-sort-v1\n',
};
for (const [file, contents] of Object.entries(fixture)) await writeFile(join(project, file), contents, {flag:'wx', mode:0o600});
const calls = [];
const proof = {author, reviewer, scenario:variant ? 'version-drift' : 'delivery', project, passed:false, invocations:calls};
let app, cid, failure, driftInjected = false, mountUsed = false;
const sha = s => createHash('sha256').update(s).digest('hex');
const done = i => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(i.status);
async function verify(final) {
  const {d, root, obligations} = final;
  assert.equal(obligations.length, 2);
  const child = obligations.find(o => o.parentId === root.id);
  assert(child && child.state === 'delivered' && child.report?.outcome === 'passed' && child.report.authority === 'project_test');
  assert.equal(root.owner.memberId, author);
  assert.equal(child.owner.memberId, reviewer);
  assert.deepEqual(child.returnTo, root.owner);
  const [writer, reader, reporter] = calls.map(x => d.invocations.find(i => i.id === x.id));
  for (const invocation of [writer, reader, reporter]) {
    assert(invocation.nativeSessionId && invocation.roomMember && invocation.acceptance === 'accepted' && invocation.teardown === 'confirmed');
    assert.equal(invocation.status, variant && invocation.id === reporter.id ? 'failed' : 'succeeded');
    assert(d.evidence.some(e => e.invocationId === invocation.id && e.kind === 'diagnostic' && e.detail.observation === 'native_terminal' && e.detail.status === 'succeeded'));
  }
  assert.equal(root.originInvocationId, writer.id);
  assert.equal(child.report.invocationId, reader.id);
  assert(d.sources.some(s => s.kind === 'a2a' && s.parentInvocationId === writer.id && s.id === child.originSourceId));
  const reads = child.report.evidenceIds.map(id => d.evidence.find(e => e.id === id && e.invocationId === reader.id));
  const adjusted = await readFile(join(project,'orders.js'),'utf8');
  assert.notEqual(adjusted, original);
  assert(reads.some(e => e?.detail.state === 'read' && e.detail.path === 'orders.js' && e.detail.sha256 === sha(adjusted)));
  for (const [file, contents] of Object.entries(fixture)) {
    if (file !== 'orders.js' && !(variant && file === 'release.txt')) assert.equal(await readFile(join(project, file), 'utf8'), contents, 'Unexpected edit: '+file);
  }
  const tests = d.evidence.filter(e => e.kind === 'tool' && e.detail.state === 'tested' && e.detail.treeExited === true && e.detail.argv?.join(' ') === 'npm test');
  const authorTests = tests.filter(e => e.invocationId === writer.id && e.detail.name === 'project_npm_test');
  const tested = tests.find(e => e.invocationId === reader.id && e.detail.name === 'project_review_test' && e.detail.exitCode === 0);
  assert(authorTests.some(e => e.detail.exitCode !== 0) && authorTests.some(e => e.detail.exitCode === 0 && e.detail.snapshotSha256 === child.version));
  assert(tested && reads.some(e => e?.id === tested.id));
  assert.equal(tested.detail.snapshotSha256, child.version);
  assert(d.evidence.some(e => e.invocationId === writer.id && e.kind === 'process_exit' && e.detail.transport === (author === 'codex' ? 'linux-project-executor' : 'stdio') && e.detail.confirmed === true));
  if (variant) {
    assert(driftInjected && root.state === 'blocked' && !root.delivery?.messageId && root.reason, 'Stale version was delivered');
    proof.blockedReason = root.reason;
  } else {
    assert(root.state === 'delivered' && root.delivery?.invocationId === reporter.id);
    const messages = d.messages.filter(m => m.responseId === reporter.responseId && m.memberId === author && !m.visibility && m.content.includes(root.delivery.summary));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, root.delivery.messageId);
    proof.finalMessageId = messages[0].id;
  }
  const views=app.collaborationStore.factors.list(cid);
  const factorForSource=id=>views.find(f=>f.sourceRef.id===id);
  const report=views.findLast(f=>f.obligationRef?.id===child.id);
  const request=factorForSource(child.originSourceId),receipt=factorForSource(tested.id);
  const finalFactor=views.findLast(f=>f.obligationRef?.id===root.id);
  assert(report && request && receipt && finalFactor);
  assert(report.parentIds.includes(request.id) && report.parentIds.includes(receipt.id));
  assert(receipt.parentIds.includes(request.id));
  const byId=new Map(views.map(f=>[f.id,f])),visited=new Set(),pending=[finalFactor.id];
  while(pending.length) {
    const id=pending.pop();
    if(visited.has(id))continue;
    visited.add(id);pending.push(...(byId.get(id)?.parentIds??[]));
  }
  assert(visited.has(report.id)&&visited.has(request.id)&&visited.has(receipt.id));
  proof.factorGraph={final:finalFactor.id,report:report.id,request:request.id,receipt:receipt.id,
    edges:views.filter(f=>visited.has(f.id)).map(f=>({id:f.id,parentIds:f.parentIds,sourceRef:f.sourceRef,obligationRef:f.obligationRef}))};
  proof.responsibilityChain={owner:root.owner,reviewer:child.owner,returnTo:child.returnTo,reportInvocation:child.report.invocationId,
    reviewVersion:child.report.version,rootState:root.state,rootRevision:root.revision,finalDelivery:root.delivery?.messageId};
  Object.assign(proof, {rootId:root.id, childId:child.id, version:child.version, writerTests:authorTests.map(e => e.id), reviewerTest:tested.id,
    reviewReceipts:child.report.evidenceIds, returnSourceId:root.currentSourceId, rootState:root.state, driftInjected});
}
try {
  process.env.CLAUDE_CONFIG_DIR = join(run, 'claude-home');
  await mkdir(process.env.CLAUDE_CONFIG_DIR, {mode:0o700});
  const native = createCollaborationRuntime({projectVm:vm, timeoutMs:300_000});
  const runtime = {...native, async invoke(req) {
    const index = calls.length;
    const position=index % 3;
    assert(index < (variant ? 6 : 3), 'Native project run budget exceeded');
    assert.equal(req.member.id, [author, reviewer, author][position]);
    assert.equal(req.obligationPolicy, true);
    assert.equal(req.account.id, selected[req.member.id].id);
    assert.equal(req.account.auth, req.member.id === 'codex' ? 'cli' : 'api');
    if (position < 2) assert.equal(req.workspaceGrant?.path, project);
    if (position === 0) assert(req.projectWork && !req.projectReview);
    if (position === 1) assert(req.projectReview?.mode === 'project' && !req.projectWork, 'Reviewer requires a separate read-only invocation');
    calls.push({id:req.invocationId, member:req.member.id, role:['author','reviewer','reporter'][position], carrier:req.member.carrier, auth:req.account.auth});
    const result = await native.invoke(req);
    if (index === 2 && variant) {
      // Inject a real disk change after the native owner's delivery proposal but before publication.
      const root = app.collaborationStore.obligations.list(cid).find(o => !o.parentId);
      assert(root?.state === 'delivery_pending' && root.delivery?.invocationId === req.invocationId, 'Missing final proposal before drift');
      await writeFile(join(project, 'release.txt'), 'order-sort-v2\n');
      driftInjected = true;
    }
    return result;
  }};
  app = await createApplication({port:0, dataDir:join(run,'db'), workspace:join(run,'default'), collaborationRuntime:runtime});
  const store = app.collaborationStore;
  const a = selected.claude;
  store.saveAccount({id:a.id, name:a.name, provider:a.provider, auth:a.auth, baseUrl:a.baseUrl, apiKeyEnv:a.apiKeyEnv});
  for (const id of [author, reviewer]) {
    store.saveMember({id, name:names[id], enabled:true, accountBinding:'override', modelBinding:'override', accountId:selected[id].id,
      carrier:id === 'codex' ? 'codex-app-server' : 'claude-cli', ...(id === 'claude' ? {model:selected.model} : {}),
      instructions:'按用户委托处理项目问题，并对自己接手的工作负责。'});
  }
  const {url} = await app.start();
  async function post(path, body) {
    const response = await fetch(url+path, {method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
    assert(response.ok, 'HTTP '+response.status+' '+path.split('/').at(-1));
    return response.json();
  }
  const room = await post('/api/conversations', {title:'修复订单编号排序', memberIds:[author,reviewer], defaultMemberId:author, requestId:randomUUID()});
  cid = room.conversation.id;
  proof.conversationId = cid;
  const path = '/api/conversations/'+cid;
  const preview = await post(path+'/workspace-preview', {path:project, mode:'project-work', reviewMode:'project'});
  await post(path+'/workspace-apply', {previewId:preview.id, requestId:randomUUID()});
  mountUsed = true;
  const msg = {requestId:randomUUID(), content:'@'+names[author]+' 请修复项目中订单编号按字符串排序的问题，编号后的数字应从小到大。修改 orders.js，保留原有测试和其他文件。先跑原有 npm test 复现，修改后再用相同命令确认。请'+names[reviewer]+' 独立读取 orders.js 并用 npm test 验证修复，回报给你。等收到通过的结果后，请你本人向我汇报一次最终结果。'};
  const admitted = await post(path+'/messages', msg);
  assert(admitted.source?.projectWork, 'Message was not admitted as authorized project work');
  const limit = Date.now() + 950_000;
  let final;
  do {
    const d = store.detail(cid), obligations = store.obligations.list(cid);
    const root = obligations.find(o => !o.parentId);
    const failed = d.invocations.find(i => done(i) && i.status !== 'succeeded');
    if (failed && !(variant && driftInjected && failed.id === calls[2]?.id && failed.status === 'failed')) throw Error('Runtime '+failed.memberId+' '+failed.status+' '+(failed.error ?? ''));
    if (root && (variant ? ['blocked','delivered'].includes(root.state) : root.state === 'delivered') &&
        d.invocations.length === 3 && d.invocations.every(done)) { final = {d, root, obligations}; break; }
    if (root?.state === 'blocked' && !variant) throw Error('Root blocked: '+root.reason);
    if (d.invocations.length && d.invocations.every(done) && !d.deliveries.some(x => x.status === 'pending') && d.invocations.length < 3) {
      throw Error('Expected a follow-up, but the queue is empty; root='+root?.state);
    }
    await delay(400);
  } while (Date.now() < limit);
  assert(final, 'Timed out waiting for final delivery');
  await verify(final);
  const replay = await post(path+'/messages', msg);
  assert.equal(replay.source.id, admitted.source.id);
  assert.equal(store.detail(cid).invocations.length, 3);
  if (variant) {
    // The operator explicitly reauthorizes the project in a reply to the original request.
    // The actors decide how to perform the recheck; an ordinary wake never gains project tools.
    const originalMessage=final.d.messages.find(m=>m.author==='user' && m.sourceId===final.root.originSourceId);
    assert(originalMessage);
    const previousChild=final.obligations.find(o=>o.parentId===final.root.id);
    const ask={requestId:randomUUID(),replyTo:originalMessage.id,content:'@'+names[author]+' 项目版本已变，请在原委托上继续。请在项目中重新跑测试 npm test，把当前版本交给'+names[reviewer]+' 独立读取 orders.js 并用同一命令验证，再由你向我简短汇报。保留现有文件。'};
    const accepted=await post(path+'/messages',ask);
    assert(accepted.source?.projectWork && accepted.source.replyTo===originalMessage.id,'Version recheck needs explicit project authorization');
    let recovered;
    const until=Date.now()+950_000;
    while(Date.now()<until) {
      const details=store.detail(cid),items=store.obligations.list(cid);
      const root=items.find(o=>o.id===final.root.id);
      const error=details.invocations.find(i=>i.id!==calls[2].id && done(i) && i.status!=='succeeded');
      if(error)throw Error('Version recheck '+error.memberId+' '+error.status+' '+(error.error??''));
      if(root?.state==='delivered' && details.invocations.length===6 && details.invocations.every(done)) {
        recovered={details,root,items}; break;
      }
      if(details.invocations.length>3 && details.invocations.every(done) && !details.deliveries.some(x=>x.status==='pending'))
        throw Error('Version recheck stopped with root '+root?.state+' '+(root?.reason??''));
      await delay(400);
    }
    assert(recovered,'Timed out waiting for the explicitly authorized project recheck');
    const {details,root,items}=recovered;
    const renewed=items.find(o=>o.parentId===root.id && o.id!==previousChild.id);
    assert.equal(items.length,3);
    assert(renewed?.state==='delivered' && renewed.report.authority==='project_test' && renewed.report.outcome==='passed');
    assert(renewed.version!==previousChild.version && renewed.originInvocationId===calls[3].id && renewed.report.invocationId===calls[4].id);
    assert.deepEqual(root.owner,final.root.owner);assert.deepEqual(renewed.returnTo,root.owner);
    assert.deepEqual(items.find(o=>o.id===previousChild.id).report,previousChild.report);
    assert.equal(root.delivery.invocationId,calls[5].id);
    const result=details.messages.find(m=>m.id===root.delivery.messageId);
    assert(result?.memberId===author && result.content.includes(root.delivery.summary));
    const reviewEvidence=details.evidence.filter(e=>renewed.report.evidenceIds.includes(e.id));
    const newTest=reviewEvidence.find(e=>e.invocationId===calls[4].id && e.detail.name==='project_review_test' &&
      e.detail.state==='tested' && e.detail.exitCode===0 && e.detail.treeExited===true && e.detail.argv?.join(' ')==='npm test' &&
      e.detail.snapshotSha256===renewed.version);
    assert(newTest && !previousChild.report.evidenceIds.includes(newTest.id));
    assert(reviewEvidence.some(e=>e.invocationId===calls[4].id && e.detail.state==='read' && e.detail.path==='orders.js'));
    assert(details.evidence.some(e=>e.invocationId===calls[3].id && e.detail.name==='project_npm_test' && e.detail.state==='tested' &&
      e.detail.exitCode===0 && e.detail.snapshotSha256===renewed.version));
    assert(calls.slice(3).every(c=>{const i=store.invocation(c.id);return i.nativeSessionId && i.acceptance==='accepted' && i.teardown==='confirmed' && i.status==='succeeded';}));
    assert.equal((await post(path+'/messages',ask)).source.id,accepted.source.id);
    assert.equal(store.detail(cid).invocations.length,6);
    proof.recheck={rootId:root.id,oldChild:previousChild.id,oldVersion:previousChild.version,blockedAtRevision:final.root.revision,
      source:accepted.source.id,child:renewed.id,recheckedVersion:renewed.version,independentTest:newTest.id,finalMessage:result.id,finalState:root.state};
  }

} catch (error) { failure = error; }
finally {
  if (cid && app) {
    const d = app.collaborationStore.detail(cid);
    proof.executions = d.invocations.map(i => ({id:i.id, member:i.memberId, status:i.status, acceptance:i.acceptance, teardown:i.teardown, session:i.nativeSessionId}));
    proof.commitments = app.collaborationStore.obligations.list(cid).map(o => ({id:o.id,parentId:o.parentId, state:o.state,reason:o.reason}));
  }
  await app?.close().catch(e => { failure ??= e; });
  try {
    const current = await mount();
    if (mountUsed && current !== vm.hostRoot) {
      assert.equal(current, project, 'Another project owns the test mount');
      const lease = await acquireProjectVm(vm, {path:vm.hostRoot, device:vm.device, inode:vm.inode, mode:'project-work', memberIds:[author],
        conversationId:'restore-fixture', revision:1, authorizedAt:new Date().toISOString()}, AbortSignal.timeout(180_000));
      await lease.release(true);
    }
    proof.mountRestored = await mount() === vm.hostRoot;
    assert(proof.mountRestored, 'Test mount was not restored');
  } catch (e) { failure ??= e; }
  proof.passed = !failure;
  if (failure) proof.error = String(failure.message || failure).slice(0,350);
  if (failure?.code === 'ERR_ASSERTION') proof.failedAssertion = String(failure.stack).split('\n').find(line => line.includes('verify-hydra-obligation-live'))?.trim();
  let json = JSON.stringify(proof, null, 2);
  for (const [key, value] of Object.entries(process.env)) {
    if ((key === selected.claude.apiKeyEnv || /API_KEY|AUTH_TOKEN|CREDENTIAL/.test(key)) && value?.length > 5) json = json.replaceAll(value,'[redacted]');
  }
  await writeFile(join(run,'result.json'), json+'\n', {flag:'wx', mode:0o600});
  console.log(proof.passed ? 'passed' : 'failed', join(run,'result.json'));
  if (!proof.passed) process.exitCode = 1;
}
