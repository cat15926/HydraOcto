// HYDRA_CONFIG_ROOT=/path/to/HydraOcto node --import tsx scripts/verify-hydra-debate-live.mjs --check-config|--live
// One fresh room, one ordinary user message. The observer cannot advance the debate.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const args = process.argv.slice(2);
assert(['--check-config','--live'].includes(args[0]) && (args.length===1 || (args.length===2 && args[1]==='--restart')));
const interrupt=args[1]==='--restart';
const installed = resolve(process.env.HYDRA_CONFIG_ROOT || '.');
const config = new DatabaseSync(join(installed, '.local-data/platform.sqlite'), {readOnly:true});
let model, account;
try {
  const member = JSON.parse(config.prepare('SELECT value FROM cc_members WHERE id=?').get('claude').value);
  assert(member.enabled && member.carrier === 'claude-cli' && member.model);
  model = member.model;
  account = JSON.parse(config.prepare('SELECT value FROM cc_accounts WHERE id=?').get(member.accountId).value);
  assert(account.auth === 'api' && account.provider === 'claude' && !account.deletedAt &&
    account.apiKeyEnv === 'COLLAB_GLM_API_KEY' && account.baseUrl === 'https://open.bigmodel.cn/api/anthropic');
} finally { config.close(); }
const settings = parseEnv(await readFile(join(installed, '.env'), 'utf8'));
for (const key of [account.apiKeyEnv, 'COLLAB_CLAUDE_PATH']) {
  if (!process.env[key] && settings[key]) process.env[key] = settings[key];
}
assert(process.env[account.apiKeyEnv]);
const maxInvocations = 22, maxDurationMs = 20 * 60_000;
if (args[0] === '--check-config') {
  console.log(JSON.stringify({model, carrier:'claude-cli', maxInvocations, maxDurationMs}));
  process.exit(0);
}

const base = resolve(process.env.VALIDATION_OUTPUT_DIR || tmpdir());
await mkdir(base, {recursive:true, mode:0o700});
const dir = await mkdtemp(join(base, 'hydra-debate-live-'));
const workspace = join(dir, 'workspace');
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
await mkdir(workspace, {mode:0o700});
await mkdir(process.env.CLAUDE_CONFIG_DIR, {mode:0o700});
const members = {host:'林', forward:'远山', counter:'南星', judge:'白露'};
const deadline = Date.now() + maxDurationMs;
const calls = [];
const native = createCollaborationRuntime({timeoutMs:150_000});
const runtime = {...native, async invoke(req) {
  assert(Date.now() < deadline && calls.length < maxInvocations, 'Exceeded the authorized run budget');
  assert(members[req.member.id] && req.member.carrier === 'claude-cli' &&
    req.account.id === account.id && req.cwd === workspace && !req.projectWork && !req.projectReview);
  calls.push({id:req.invocationId, member:req.member.id});
  console.log('Invocation', calls.length, req.member.id);
  return native.invoke(req);
}};

const content = (interrupt ? '@林 请你暂任主持，组织远山和南星就「公共图书馆应优先延长开放时间还是扩大纸质藏书」进行五轮简短辩论。远山支持延长开放时间，南星支持扩大藏书。' : '@林 请你暂任主持，组织远山和南星就「小型博物馆的有限经费，优先数字展览还是实体展览」进行五轮简短辩论。远山支持数字展览，南星支持实体展览。') + '每轮请两位同时独立发言，听完双方意见后你再组织下一轮。第五轮结束，请白露作为裁判根据实际发言给出胜方和理由，最后由你向我汇报。每次发言一两句即可。';
const proof = {model, carrier:'claude-cli', passed:false, prompt:content, calls, userSubmissions:0};
const open = () => createApplication({dataDir:join(dir,'db'), workspace, port:0, collaborationRuntime:runtime,startWorker:false});
let app = await open(), restartWake, replayed;
let cid, failure;
try {
  const store = app.collaborationStore;
  store.saveAccount(account);
  for (const [id, name] of Object.entries(members)) {
    store.saveMember({id, name, accountId:account.id, carrier:'claude-cli', model, modelBinding:'override', accountBinding:'override',
      instructions:'根据房间里的委托参与协作，简洁表达。', enabled:true});
  }
  let {url} = await app.start();
  assert.notEqual(new URL(url).port, '4310');
  async function post(path, body) {
    const resp = await fetch(url + path, {method:'POST', headers:{'content-type':'application/json','x-csrf-token':app.csrfToken}, body:JSON.stringify(body)});
    assert(resp.ok, 'HTTP ' + resp.status + ' ' + path);
    return resp.json();
  }
  const room = await post('/api/conversations', {requestId:randomUUID(), title:interrupt?'图书馆资源辩论':'展览经费辩论', memberIds:Object.keys(members), defaultMemberId:'host'});
  cid = room.conversation.id;
  const path = '/api/conversations/' + cid;
  if (interrupt) {
    // Stop at the durable boundary after both first-round replies have been saved.
    const admit = store.admitNext.bind(store);
    store.admitNext = () => store.cooperation.groups(cid).some(g=>g.state==='done') ? undefined : admit();
  }
  app.collaborationEngine.start();
  await post(path + '/messages', {requestId:randomUUID(), content});
  proof.userSubmissions++;
  let details, idleSince = Date.now(), previousProgress = '';
  while (Date.now() < deadline) {
    const resp = await fetch(url + path);
    assert(resp.ok);
    details = await resp.json();
    const root = details.obligations?.find(o => !o.parentId);
    const terminal = details.invocations.length && details.invocations.every(i => ['failed','succeeded','cancelled','interrupted'].includes(i.status));
    const failed = details.invocations.find(i => ['failed','cancelled','interrupted'].includes(i.status));
    if (interrupt && !restartWake && terminal && details.groups?.[0]?.state==='done') {
      restartWake=details.groups[0].contract.wakeSourceId;
      assert(restartWake && !details.consumptions.some(c=>c.sourceId===restartWake));
      await app.close();
      app=await open();
      url=(await app.start()).url;
      app.collaborationEngine.start();
      continue;
    }
    if (restartWake && !replayed && details.groups.length===2 && details.groups[1].state==='collecting') {
      const liveStore=app.collaborationStore;
      const [first,second]=liveStore.cooperation.groups(cid),old=first.results[0];
      if(second.state!=='collecting') continue;
      // Replay the first turn's genuine terminal callback during a different open round.
      liveStore.finish(old.invocationId,'succeeded',liveStore.response(old.responseId).content);
      liveStore.cooperation.groupTick();
      const checked=liveStore.cooperation.groups(cid).find(g=>g.id===second.id);
      assert.deepEqual(checked.results,second.results);
      assert.equal(checked.contract.wakeSourceId,second.contract.wakeSourceId);
      replayed={roundId:first.id,oldInvocationId:old.invocationId,openRoundId:second.id};
    }
    if (failed) throw Error('Unsuccessful execution: ' + failed.memberId + ' ' + failed.status);
    if (terminal && root?.state === 'delivered') break;
    if (root && ['cancelled','blocked','awaiting_acceptance'].includes(root.state)) throw Error('Root ' + root.state);
    const progress = [details.messages.length, details.sources.length, details.invocations.length, root?.revision].join('/');
    if (progress !== previousProgress || !terminal) idleSince = Date.now();
    previousProgress = progress;
    if (Date.now() - idleSince > 12_000 && !details.deliveries.some(d => d.status === 'pending')) throw Error('Stopped before final delivery');
    await sleep(600);
  }
  const root = details?.obligations?.find(o => !o.parentId);
  assert(root?.state === 'delivered' && root.owner.memberId === 'host');
  if (interrupt) {
    assert(restartWake && replayed,'The restart and late replay must actually take place');
    assert.equal(details.groups[0].contract.wakeSourceId,restartWake);
    proof.restartWake=restartWake; proof.lateReplay=replayed;
  }
  assert.equal(details.messages.filter(m=>m.author==='user').length,1);
  const groups = details.groups;
  assert.equal(groups.length, 5);
  const wakes = new Set(), answers = new Set();
  for (const g of groups) {
    assert.equal(g.contract?.obligationId, root.id);
    assert.equal(g.state, 'done');
    assert.deepEqual(g.targets.toSorted(), ['counter','forward']);
    assert.deepEqual(g.results.map(r=>r.memberId).toSorted(), ['counter','forward']);
    for (const result of g.results) {
      const inv = details.invocations.find(i => i.id === result.invocationId);
      assert(inv?.memberId === result.memberId && inv.responseId === result.responseId && result.status === 'succeeded' && result.content.trim());
      assert(details.consumptions.some(c => c.sourceId === g.sourceId && c.responseId === inv.responseId));
      answers.add(inv.id);
    }
    const wake = g.contract.wakeSourceId;
    assert(wake && !wakes.has(wake));
    assert.equal(details.consumptions.filter(c=>c.sourceId === wake && c.memberId === 'host').length,1);
    wakes.add(wake);
  }
  assert.equal(answers.size, 10);
  const judgement = details.messages.filter(m => m.memberId === 'judge' && m.responseId);
  assert(judgement.length && judgement.every(m => m.content.trim()));
  const final = details.messages.find(m => m.id === root.delivery?.messageId);
  assert(final?.memberId === 'host' && final.content.trim());
  for (const i of details.invocations) assert(i.nativeSessionId && i.acceptance === 'accepted' && i.teardown === 'confirmed' && i.status === 'succeeded');
  const lastGroup = groups.toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1);
  assert(judgement.some(m => m.createdAt >= lastGroup.finishedAt && m.createdAt <= final.createdAt));
  proof.rounds = groups.map(g => ({id:g.id, question:g.question, sourceId:g.sourceId, wake:g.contract.wakeSourceId, results:g.results}));
  proof.verdicts = judgement.map(m => ({id:m.id, content:m.content}));
  proof.delivery = {id:final.id, content:final.content};
  proof.passed = true;
} catch (e) { failure = e; }
finally {
  if (cid) {
    const d = app.collaborationStore.detail(cid);
    proof.states = d.obligations?.map(o=>({id:o.id,state:o.state,owner:o.owner.memberId}));
    proof.executions = d.invocations.map(i => ({id:i.id, member:i.memberId, status:i.status, accepted:i.acceptance,teardown:i.teardown}));
  }
  await app.close();
  if (failure) {proof.error = String(failure.message).replaceAll(process.env[account.apiKeyEnv], '[redacted]').slice(0,500);process.exitCode = 1;}
  const report = JSON.stringify(proof,null,2).replaceAll(process.env[account.apiKeyEnv], '[redacted]');
  await writeFile(join(dir,'result.json'),report+'\n',{mode:0o600,flag:'wx'});
  console.log(proof.passed?'passed':'failed',join(dir,'result.json'));
}
