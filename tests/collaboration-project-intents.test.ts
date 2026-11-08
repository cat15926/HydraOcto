import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CollaborationStore } from '../server/collaboration/store.js';
import { requestsProjectWork } from '../server/collaboration/project-intents.js';
import { Store } from '../server/store.js';

function fixture(available = false) {
  const root = mkdtempSync(join(tmpdir(), 'project-grant-'));
  const project = join(root, 'selected'), db = join(root, 'private', 'platform.sqlite');
  mkdirSync(project);
  const owner = new Store(db), store = new CollaborationStore(owner, { workspace: project,
    projectWorkAvailability: () => ({ available, reason: available ? undefined : '合成承载未通过隔离探测' }) });
  const conversation = store.create({ title: '合成测试', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
  return { root, project, db, owner, store, cid: conversation.id, close() { owner.close(); rmSync(root, { force: true, recursive: true }); } };
}

test('explicit project command checks route to the project while questions and negation stay in chat', () => {
  for (const text of ['在这个项目里运行 node --version','在仓库执行一下 pwd','Run git --version in this repo']) assert.equal(requestsProjectWork(text),true);
  for (const text of ['如何在项目里运行 node --version','请不要运行 pwd，只看看项目','什么是 git --version']) assert.equal(requestsProjectWork(text),false);
});

test('P5: explaining a fix in a later peer review preserves the original writer assignment and its authorization', () => {
  const h = fixture(true);
  try {
    const author = '@Codex 请修复项目中 export.py 漏掉零金额流水的问题。请先运行 python3 check.py 复现，保留原测试、账本和文件里的格式标识，修改 export.py 后跑通同一测试';
    const review = '完成后请 Claude Code 独立评审 export.py：解释修改是否保留零金额，在评审意见里附上该文件实际的 Report format ID。请你本人在交接及回复中省略标识值，由评审者从文件核对。';
    const members = h.store.members();
    for (const separator of ['。', '，', '；', '\n', ', ']) {
      assert.equal(requestsProjectWork(author + separator + review, members), true);
    }
    for (const content of [
      '请解释如何修复项目。' + review,
      '只读分析 export.py；' + review,
      '先不要修改 export.py，' + review,
      '请汇总讨论。完成后请 Claude Code 独立评审并修改 export.py',
      '修改 export.py。完成后请 Claude Code 解释如何评审这项修改。',
      '修改 export.py。' + review + '先不要改动项目。',
      '修改 export.py。' + review + '请先解释方案。',
    ]) assert.equal(requestsProjectWork(content,members), false, content);
    const input = {content: author + '。' + review, requestId: randomUUID()};
    const submitted = h.store.projects.submit(h.cid,input);
    assert.ok('intent' in submitted);
    assert.deepEqual(submitted.intent.memberIds, ['codex']);
    const grant = h.store.workbench.previewWorkspace(h.cid, {path:h.project, mode:'project-work', intentId:submitted.intent.id});
    h.store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},h.cid);
    const detail = h.store.detail(h.cid);
    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0]!.content, input.content);
    assert.deepEqual(detail.sources[0]!.requestedTargets, ['codex']);
    assert.ok(detail.sources[0]!.projectWork);

    const solo = h.store.create({title:'单成员',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation;
    const outsideRoster = h.store.projects.submit(solo.id,{...input,requestId:randomUUID()});
    assert.ok('source' in outsideRoster && !outsideRoster.source.projectWork);
    const claude = members.find(m => m.id === 'claude')!;
    h.store.saveMember({...claude,enabled:false});
    const disabled = h.store.projects.submit(h.cid,{...input,requestId:randomUUID()});
    assert.ok('source' in disabled && !disabled.source.projectWork);
  } finally { h.close(); }
});

test('P0: approval converts the original public intent once and only once; directory selection and later configuration never reroute the source', () => {
  const h = fixture(true);
  try {
    const input = { content: '@Codex 修复月报并运行测试', requestId: randomUUID() };
    const submitted = h.store.projects.submit(h.cid, input); assert.ok('intent' in submitted);
    assert.deepEqual(h.store.projects.submit(h.cid, input), submitted);
    assert.equal(h.store.detail(h.cid).sources.length, 0);
    assert.throws(() => h.store.projects.submit(h.cid, { ...input, content: '咨询' }), /请求标识/);
    const pick = h.store.workbench.previewWorkspace(h.cid, { path: h.project });
    const grant = h.store.workbench.previewWorkspace(h.cid, { mode: 'project-work', fromPreviewId: pick.id, intentId: submitted.intent.id });
    assert.equal(h.store.detail(h.cid).conversation.workspaceGrant, undefined);
    assert.deepEqual(grant.projectCapabilities?.map(c => c.available), [true, true]);
    const command = { previewId: grant.id, requestId: randomUUID() };
    const applied = h.store.workbench.applyPreview(command, h.cid);
    assert.equal(h.store.workbench.applyPreview(command, h.cid).replayed, true);
    assert.equal(applied.replayed, false);
    const result = h.store.detail(h.cid);
    assert.equal(result.conversation.workspaceGrant?.path, realpathSync(h.project));
    assert.equal(result.projectIntents?.length, 0);
    assert.equal(result.sources.length, 1); assert.equal(result.sources[0]!.projectWork, true);
    assert.equal(result.sources[0]!.projectGrantRevision, result.conversation.workspaceGrant?.revision);
    assert.deepEqual(result.sources[0]!.requestedTargets, ['codex']);
    assert.equal(result.messages[0]!.content, input.content);
    const replay = h.store.projects.submit(h.cid, input);
    assert.ok('source' in replay); assert.equal(replay.source.id, result.sources[0]!.id);
    const next = h.store.projects.submit(h.cid, { ...input, requestId: randomUUID() });
    assert.ok('source' in next && next.source.projectWork);
  } finally { h.close(); }
});

test('P0: missing capability rolls back both grant and source; an independent grant can be saved and the user can consult or discard', () => {
  const h = fixture();
  try {
    const input = { content: '请修复原文件', requestId: randomUUID() };
    const first = h.store.projects.submit(h.cid, input); assert.ok('intent' in first);
    const candidate = h.store.workbench.previewWorkspace(h.cid, { path: h.project, mode: 'project-work', intentId: first.intent.id });
    assert.equal(candidate.projectCapabilities![0]!.available, false);
    assert.throws(() => h.store.workbench.applyPreview({ previewId: candidate.id, requestId: randomUUID() }, h.cid), /隔离探测/);
    assert.equal(h.store.detail(h.cid).conversation.workspaceGrant, undefined);
    assert.equal(h.store.detail(h.cid).sources.length, 0);
    const separate = h.store.workbench.previewWorkspace(h.cid, { path: h.project, mode: 'project-work' });
    h.store.workbench.applyPreview({ previewId: separate.id, requestId: randomUUID() }, h.cid);
    const otherInput = { ...input, requestId: randomUUID() };
    const other = h.store.projects.submit(h.cid, otherInput); assert.ok('intent' in other);
    const cancelId = randomUUID();
    h.store.projects.resolve(h.cid, other.intent.id, 'cancel', 1, cancelId);
    assert.equal(h.store.projects.resolve(h.cid, other.intent.id, 'cancel', 1, cancelId).replayed, true);
    const replay = h.store.projects.submit(h.cid, otherInput);
    assert.ok('intent' in replay); assert.equal(replay.intent.state, 'cancelled'); assert.equal(replay.intent.id, other.intent.id);
    assert.throws(() => h.store.projects.resolve(h.cid, other.intent.id, 'consult', 1, randomUUID()), /已/);
    const consultation = h.store.projects.resolve(h.cid, first.intent.id, 'consult', 1, randomUUID());
    assert.ok('source' in consultation.result); assert.equal(consultation.result.source.projectWork, undefined);
    assert.equal(h.store.detail(h.cid).sources.length, 1);
  } finally { h.close(); }
});

test('P0: stale physical directory, expired preview, expired intent, or another conversation cannot elevate a read-only grant', () => {
  const h = fixture(true);
  try {
    const w = h.store.workbench;
    const read = w.previewWorkspace(h.cid, { path: h.project });
    w.applyPreview({ previewId: read.id, requestId: randomUUID() }, h.cid);
    const first = h.store.projects.submit(h.cid, { content: '生成项目月报', requestId: randomUUID() }); assert.ok('intent' in first);
    const other = h.store.create({ title: '其他', memberIds: ['codex'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
    assert.throws(() => w.previewWorkspace(other.id, { path: h.project, mode: 'project-work', intentId: first.intent.id }), /此会话/);
    const upgrade = () => w.previewWorkspace(h.cid, { useCurrent: true, mode: 'project-work', intentId: first.intent.id });
    const apply = (id: string) => w.applyPreview({ previewId: id, requestId: randomUUID() }, h.cid);
    const expired = upgrade();
    h.owner.db.prepare('UPDATE cc_configuration_previews SET value=? WHERE id=?').run(JSON.stringify({ ...expired, expiresAt: '2020-01-01T00:00:00Z' }), expired.id);
    assert.throws(() => apply(expired.id), /失效/);
    const stale = upgrade(); renameSync(h.project, h.project + '-original'); mkdirSync(h.project);
    writeFileSync(join(h.project, 'other'), 'same-name-different-directory');
    assert.throws(() => apply(stale.id), /身份/); assert.throws(upgrade, /身份/);
    h.store.projects.resolve(h.cid, first.intent.id, 'cancel', 1, randomUUID());
    assert.equal(h.store.detail(h.cid).sources.length, 0);
    assert.equal(h.store.detail(h.cid).conversation.workspaceGrant?.mode, 'read-only');
    for (const path of [h.root, join(h.root,'private'), homedir(), '/']) {
      assert.throws(() => w.previewWorkspace(h.cid, { path, mode: 'project-work' }), /私有/);
    }
  } finally { h.close(); }
});

test('P0: original authorizations survive schema 11 migration and restart; private requests receive no project source', () => {
  const h = fixture(true);
  try {
    const read = h.store.workbench.previewWorkspace(h.cid, { path: h.project });
    h.store.workbench.applyPreview({ previewId: read.id, requestId: randomUUID() }, h.cid);
    const original = h.owner.db.prepare('SELECT value FROM cc_conversations WHERE id=?').get(h.cid);
    h.owner.db.exec('DROP TABLE cc_project_intents; UPDATE cc_schema SET version=11');
    const upgraded = new CollaborationStore(h.owner);
    assert.equal(h.owner.db.prepare('SELECT version FROM cc_schema').get()?.version, 13);
    assert.deepEqual(h.owner.db.prepare('SELECT value FROM cc_conversations WHERE id=?').get(h.cid), original);
    const input = { content: '修改项目文件', requestId: randomUUID() }, waiting = upgraded.projects.submit(h.cid, input);
    assert.ok('intent' in waiting);
    const reopened = new CollaborationStore(h.owner);
    assert.deepEqual(reopened.projects.submit(h.cid, input), waiting);
    const answer = reopened.projects.submit(h.cid, { ...input, requestId: randomUUID(), privateTo: ['claude'] });
    assert.ok('source' in answer); assert.equal(answer.source.projectWork, undefined);
    assert.equal(answer.source.visibility?.kind, 'private');
  } finally { h.close(); }
});

test('P0: ordinary creative or explanatory requests do not require a project; clear project work stays out of the dispatch queue', () => {
  const h = fixture();
  try {
    for (const content of ['生成一个笑话', '创建大纲并新增两个观点', '解释一下如何修复这个程序', '只读分析项目代码', '创建一个任务', '生成一封邮件', '整理刚才的讨论', '实现思路是什么', 'create a task']) {
      const submission = h.store.projects.submit(h.cid, { content, requestId: randomUUID() });
      assert.ok('source' in submission); assert.equal(submission.source.projectWork, undefined);
    }
    for (const content of ['请整理四月流水', '把这份月报保存到桌面', 'Export monthly.csv to my Documents folder', '@Codex 把 private.txt 原样复制为 review.txt。完成后请 Claude Code 评审。', 'Please fix report.ts', '把月报导出到项目文件夹']) {
      assert.ok('intent' in h.store.projects.submit(h.cid, { content, requestId: randomUUID() }));
    }
    assert.equal(h.store.detail(h.cid).sources.length, 9);
  } finally { h.close(); }
});

test('P0: revocation works after directory replacement and fences the authorized invocation', () => {
  const h = fixture(true);
  try {
    const preview = h.store.workbench.previewWorkspace(h.cid, { path: h.project, mode: 'project-work' });
    h.store.workbench.applyPreview({ previewId: preview.id, requestId: randomUUID() }, h.cid);
    const send = h.store.projects.submit(h.cid, { content: '修复原文件', requestId: randomUUID() });
    assert.ok('source' in send && send.source.projectWork);
    const admission = h.store.admitNext();
    const i = admission!.invocations[0]!;
    renameSync(h.project,h.project + '-original'); mkdirSync(h.project);
    const rev = h.store.workbench.conversation(h.cid).revision!;
    const ticket = randomUUID();
    const revoked = h.store.workbench.revokeWorkspace(h.cid, rev, ticket);
    assert.deepEqual(revoked.result.stopped, [i.id]); assert.equal(revoked.result.grant.mode, 'read-only');
    assert.equal(h.store.invocation(i.id).status, 'cancelled');
    assert.equal(h.store.workbench.revokeWorkspace(h.cid, rev, ticket).replayed, true);
    assert.ok('intent' in h.store.projects.submit(h.cid, { content: '再次修改原文件', requestId: randomUUID() }));
  } finally { h.close(); }
});

test('P0: accepted public consultant proposes only the remaining step; real exit and human authorization precede one separately attributed source', () => {
  const h = fixture(true);
  try {
    const initial = h.store.send(h.cid, { content: '查一下四月月报缺行的原因', requestId: randomUUID() });
    const i = h.store.admitNext()!.invocations[0]!, step = { nextStep: '修复零金额过滤条件，再执行月报测试。' };
    const frozen = h.store.contract(i.id);
    assert.equal(frozen.mayProposeProject, true);
    h.store.startInvocation(i.id);
    assert.throws(() => h.store.projects.propose(i.id, step, 'c1'), /接受/);
    h.store.recordEvidence(i.id, { kind: 'accepted', detail: { source: 'fixture' } });
    assert.throws(() => h.store.projects.propose(i.id, {nextStep: initial.source.content}, 'echo'), /下一步/);
    const receipt = h.store.projects.propose(i.id, step, 'c1');
    assert.deepEqual(h.store.projects.propose(i.id, step, 'c1'), receipt);
    assert.throws(() => h.store.projects.propose(i.id, {nextStep:'改成另一步'}, 'c2'), /different content/);
    assert.equal(h.store.detail(h.cid).sources.length, 1);
    assert.throws(() => h.store.projects.resolve(h.cid, receipt.intentId, 'consult', 1, randomUUID()), /确认退出/);
    h.store.recordEvidence(i.id, { kind: 'process_exit', detail: {confirmed:true} });
    h.store.finish(i.id, 'succeeded', '已定位零金额被误过滤。');
    const preview = h.store.workbench.previewWorkspace(h.cid, { path: h.project, mode: 'project-work', intentId: receipt.intentId });
    const apply = { previewId: preview.id, requestId: randomUUID() };
    h.store.workbench.applyPreview(apply, h.cid); h.store.workbench.applyPreview(apply, h.cid);
    const detail = h.store.detail(h.cid);
    assert.equal(detail.sources.length, 2);
    const next = detail.sources[1]!;
    assert.equal(next.content, step.nextStep); assert.deepEqual(next.requestedTargets,[i.memberId]);
    assert.equal(next.projectWork,true); assert.deepEqual(next.projectFollowupOf, receipt.origin);
    assert.equal(receipt.origin.sourceId, initial.source.id);
    assert.equal(receipt.origin.invocationId, i.id);
    assert.ok(detail.messages.some(m=>m.content.includes('已定位')));
  } finally { h.close(); }
});

test('P0: private callers, cancellation and post-proposal revocation cannot activate project followups', () => {
  for (const mode of ['private','cancel','revoke'] as const) {
    const h = fixture(true);
    try {
      if(mode==='revoke'){
        const p=h.store.workbench.previewWorkspace(h.cid,{path:h.project, mode:'project-work'});
        h.store.workbench.applyPreview({previewId:p.id, requestId:randomUUID()},h.cid);
      }
      h.store.send(h.cid, { content:'了解月报计算方法', requestId:randomUUID(), ...(mode==='private'?{privateTo:['codex']}:{}) });
      const i=h.store.admitNext()!.invocations[0]!;
      h.store.startInvocation(i.id);
      h.store.recordEvidence(i.id,{kind:'accepted',detail:{source:'fixture'}});
      if(mode==='private'){
        assert.throws(()=>h.store.projects.propose(i.id,{nextStep:'下一步编辑'},'p'),/公开/);
        continue;
      }
      const r=h.store.projects.propose(i.id,{nextStep:'修改原文件'},'p');
      if(mode==='cancel') h.store.cancel(i.id);
      h.store.recordEvidence(i.id,{kind:'process_exit',detail:{confirmed:true}});
      h.store.finish(i.id,mode==='cancel'?'cancelled':'succeeded','结束');
      if(mode==='revoke') h.store.workbench.revokeWorkspace(h.cid,h.store.workbench.conversation(h.cid).revision!,randomUUID());
      assert.throws(()=>h.store.projects.resolve(h.cid,r.intentId,'consult',1,randomUUID()),/原执行/);
      assert.equal(h.store.detail(h.cid).sources.length,1);
    } finally { h.close(); }
  }
});

test('P0: explicit continue-current follows N6 only within the same work grant', () => {
  for (const activeWork of [true,false]) {
    const h=fixture(true);
    try {
      const p=h.store.workbench.previewWorkspace(h.cid,{path:h.project, mode:'project-work'});
      h.store.workbench.applyPreview({previewId:p.id,requestId:randomUUID()},h.cid);
      h.store.projects.submit(h.cid,{content:activeWork?'修复月报文件':'解释月报',requestId:randomUUID()});
      const i=h.store.admitNext()!.invocations[0]!;
      const next=h.store.projects.submit(h.cid,{content:'请补充文件测试',deliveryMode:'continue_current',requestId:randomUUID()});
      assert.ok('source' in next && next.source.projectWork);
      const d=h.store.detail(h.cid).deliveries.find(d=>d.sourceId===next.source.id)!;
      assert.equal(d.continuation?.invocationId,activeWork?i.id:undefined);
    } finally { h.close(); }
  }
});

test('P2: a short continuation inherits only the latest completed public assignment for the same member and grant', () => {
  for (const scenario of ['same', 'new-member', 'new-grant', 'intervening-chat', 'failed', 'private'] as const) {
    const h = fixture(true);
    try {
      const bind = () => {
        const pick = h.store.workbench.previewWorkspace(h.cid,{path:h.project,mode:'project-work'});
        h.store.workbench.applyPreview({previewId:pick.id,requestId:randomUUID()},h.cid);
      };
      bind();
      const first = h.store.projects.submit(h.cid,{content:'@Codex 请修复月报文件',requestId:randomUUID()});
      assert.ok('source' in first && first.source.projectWork);
      const run = h.store.admitNext()!.invocations[0]!;
      h.store.startInvocation(run.id);
      h.store.recordEvidence(run.id,{kind:'accepted',detail:{source:'fixture'}});
      h.store.recordEvidence(run.id,{kind:'process_exit',detail:{confirmed:true}});
      h.store.finish(run.id,scenario==='failed'?'failed':'succeeded','本轮结束');
      if (scenario==='new-grant') {
        h.store.workbench.revokeWorkspace(h.cid,h.store.workbench.conversation(h.cid).revision!,randomUUID());
        bind();
      }
      if (scenario==='intervening-chat') h.store.send(h.cid,{content:'解释一下这个算法',requestId:randomUUID()});
      const next = h.store.projects.submit(h.cid,{content:scenario==='new-member'?'@Claude Code 继续':'继续',
        requestId:randomUUID(),...(scenario==='private'?{privateTo:['codex']}:{})});
      assert.ok('source' in next);
      assert.equal(!!next.source.projectWork,scenario==='same',scenario);
    } finally { h.close(); }
  }
});
