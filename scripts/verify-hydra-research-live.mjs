// Run with Node 24 --import tsx. The configured installation is used only to select the real carrier.
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isolatedClaude } from './hydra-test-native.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const cap = 6;
const configRoot = resolve(process.env.HYDRA_CONFIG_ROOT || '.');
const evidenceRoot = resolve(process.env.VALIDATION_OUTPUT_DIR || tmpdir());
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(evidenceRoot, 'hydra-research-'));
const workspace = join(dir, 'workspace');
const dataDir = join(dir, 'service');
const profile = join(dir, 'claude');
for (const path of [workspace, profile]) await mkdir(path, { mode: 0o700 });
const digest = data => createHash('sha256').update(data).digest('hex');
const first = randomInt(1930, 1960), second = first + randomInt(2, 10);
const evidence = { case: '22.8 / 10 and light control', carrier: 'claude-cli', cap, calls: [], cases: [] };
const scenarios = [
  { name: 'consistent', year: first },
  { name: 'conflicting', year: second },
  { name: 'light-control' },
];
let app, url, current, store;
async function post(path, body) {
  const response = await fetch(url + path, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-csrf-token': app.csrfToken,
  }, body: JSON.stringify({ requestId: randomUUID(), ...body }) });
  assert(response.ok, 'HTTP ' + response.status + ' ' + path);
  return response.json();
}
const terminal = run => ['succeeded','failed','interrupted','cancelled'].includes(run.status);
async function send(cid, content, attachmentIds = []) {
  const prefix = '/api/conversations/' + cid;
  const previous = store.invocations(cid).length;
  const admitted = await post(prefix + '/messages', { content, attachmentIds });
  current.userSources.push(admitted.source.id);
  const deadline = Date.now() + 210000;
  while (Date.now() < deadline) {
    const detail = store.detail(cid);
    for (const run of detail.invocations.slice(previous)) {
      if (terminal(run)) assert.equal(run.status, 'succeeded', 'Carrier ' + run.status + ' ' + (run.error || ''));
    }
    if (detail.invocations.length > previous && detail.invocations.every(terminal) &&
        detail.deliveries.every(d => ['withdrawn','consumed'].includes(d.status))) return;
    await delay(150);
  }
  throw Error('No autonomous terminal outcome within the allotted time');
}
async function upload(cid, name, text) {
  const { result } = await post('/api/conversations/' + cid + '/attachments', {
    name: name + '.txt', mediaType: 'text/plain', base64: Buffer.from(text).toString('base64'),
  });
  return { id: result.id, name, digest: result.digest, text };
}
function verifyTurns(cid) {
  const d = store.detail(cid);
  const runs = d.invocations.map(i => ({
    id: i.id, instance: i.roomMember?.id, member: i.memberId, acceptance: i.acceptance,
    teardown: i.teardown, status: i.status, nativeSessionId: i.nativeSessionId, responseId: i.responseId,
  }));
  const obligations = store.obligations.list(cid);
  Object.assign(current, {
    runs, deliveries: d.deliveries.map(({ id, sourceId, memberId, status }) => ({ id, sourceId, memberId, status })),
    consumptions: d.consumptions, commitments: obligations.map(({id,parentId,state,owner}) => ({id,parentId,state,owner})),
    receipts: d.evidence.map(({id,invocationId,kind}) => ({id,invocationId,kind})),
    answers: d.messages.filter(m => m.author === 'member').map(m => ({ id: m.id, text: m.content, source: m.sourceId, author: m.memberId })),
  });
  assert(runs.length && runs.every(i => i.instance && i.status === 'succeeded' &&
    i.acceptance === 'accepted' && i.teardown === 'confirmed' && i.nativeSessionId),
    'Incomplete native acceptance or process exit');
  assert.equal(d.messages.filter(m => m.author === 'user').length, current.userSources.length);
  for (const sid of current.userSources) assert(d.consumptions.some(c => c.sourceId === sid), 'Missing consumption');
  assert.equal(d.crossTransfers?.length, 0, 'Unexpected cross-room write');
  assert.equal(d.jobs?.length, 0, 'Unexpected managed job');
  if (current.name === 'light-control') {
    assert.equal(obligations.length, 0, 'Direct answer/FYI created a commitment');
    assert.equal(d.sources.length, 2, 'Unexpected extra wake-up');
    assert(runs.length <= 2, 'Unexpected secondary invocation');
    assert(current.answers[0]?.text.includes('package.json'), 'Missing answer to the CI question');
    return;
  }
  const relevant = evidence.calls.filter(c => c.cid === cid);
  assert(relevant.some(c => c.primaryMaterialsReceived), 'Both original documents must have reached the native carrier');
  const last = current.answers.at(-1)?.text;
  assert(last && ['馆藏登记','口述记录',String(first),String(current.year)].every(t => last.includes(t)),
    'No final answer with both original source titles and dates');
  if (current.year !== first) {
    assert(/不一致|冲突|矛盾|尚[待未无]|无法|不能|待核|存疑|待考|有分歧/.test(last), 'Conflicting records require a qualified conclusion');
    const assertion = /(?:可以确定|已确认|确定无疑)(?:.{0,8})(?:创办于|成立于|首展于)/;
    assert(!assertion.test(last), 'Unqualified definitive conclusion despite conflicting records');
  }
  if (relevant.some(c => c.tools.some(t => ['collaboration_request','obligation_delegate','multi_mention'].includes(t)))) {
    assert(obligations.some(o => o.parentId && ['delivered','reported'].includes(o.state)), 'Delegation requires a recorded child and report');
  }
  assert(obligations.every(o => ['delivered','reported'].includes(o.state)), 'Outstanding or abandoned commitment');
}
try {
  const {selected,account}=await isolatedClaude(configRoot,profile);
  evidence.model = selected.model;
  const native = createCollaborationRuntime({ timeoutMs: 90000, privateRoots: [dataDir] });
  app = await createApplication({ dataDir, workspace, port: 0, collaborationRuntime: {
    ...native, async invoke(req) {
      assert(evidence.calls.length < cap, 'Carrier invocation budget exhausted');
      assert.equal(req.cwd, workspace);
      assert(!req.projectWork && !req.projectReview && !req.webResearch && !req.projectBrowser && !req.gitDelivery);
      const entry = { cid: req.conversationId, instance: req.member.id, invocation: req.invocationId, promptDigest: digest(req.prompt),
        primaryMaterialsReceived: current.materials?.every(m => req.prompt.includes(m.text)) ?? false, tools: [] };
      evidence.calls.push(entry);
      return native.invoke({ ...req, async onToolCall(name, args, id) {
        entry.tools.push(name);
        return req.onToolCall(name, args, id);
      } });
    },
  } });
  store = app.collaborationStore;
  store.saveAccount(account);
  for (const [id, name] of [['reader','阿岚'],['archivist','向宁']]) {
    store.saveMember({ id, name, carrier: selected.carrier, model: selected.model, accountId: account.id,
      modelBinding: 'override', accountBinding: 'override', enabled: true,
      instructions: '与同伴一起根据房间中有权使用的资料工作，向提问者交付有依据的结果。' });
  }
  ({ url } = await app.start());
  assert.notEqual(new URL(url).port, '4310');
  for (const scenario of scenarios) {
    current = { ...scenario, passed: false, userSources: [] };
    evidence.cases.push(current);
    try {
      const { conversation } = await post('/api/conversations', {
        title: scenario.year ? '展览资料室' : '资料交流', memberIds: ['reader','archivist'], defaultMemberId: 'reader',
      });
      current.room = conversation.id;
      if (scenario.year) {
        current.materials = [
          await upload(current.room,'馆藏登记','《馆藏登记》：青湾摄影社于' + first + '年举办首次公开展览。'),
          await upload(current.room,'口述记录','《口述记录》：受访者回忆，青湾摄影社于' + scenario.year + '年举办首次公开展览。'),
        ];
        const request = '请核实展签中青湾摄影社首次公开展览的年份，并给出可刊用的一句话和依据。只准查现有资料，不许对外联络。';
        current.requestDigest = digest(request);
        await send(current.room, request, current.materials.map(m => m.id));
      } else {
        await send(current.room, 'CI 提示 ENOENT: no such file or directory, open package.json，这条报错是什么意思？');
        await send(current.room, '仅供参考：同类项目通常会在根目录保存 package.json。');
      }
      verifyTurns(current.room);
      current.passed = true;
    } catch (error) {
      current.error = String(error.message).slice(0, 380);
      if (current.room) current.failedRuns = store.invocations(current.room).map(({id,status,acceptance,teardown}) => ({id,status,acceptance,teardown}));
    }
  }
} catch (error) {
  evidence.error = String(error.message).slice(0, 380);
} finally {
  if (app) await app.close();
  evidence.passed = evidence.cases.length === scenarios.length && evidence.cases.every(c => c.passed);
  const report = join(dir,'result.json');
  await writeFile(report, JSON.stringify(evidence,null,2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: evidence.passed, report, checks: evidence.cases.map(c => ({name: c.name, passed: c.passed, error: c.error})), error: evidence.error }));
}
if (!evidence.passed) process.exitCode = 1;
