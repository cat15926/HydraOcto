/** Two bounded real CLI/API invocations in an isolated DB and synthetic workspace. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import type { CollaborationBootstrap, CollaborationRuntime } from '../shared/collaboration.js';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || `.local-data/validation/n5-live/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(join(output, 'workspace'), { recursive: true }); const workspace = await realpath(join(output, 'workspace'));
const boot = await (await fetch(`${process.env.PLATFORM_URL || 'http://127.0.0.1:4310'}/api/collaboration/bootstrap`)).json() as CollaborationBootstrap;
const owner = new Store(join(output, 'acceptance.sqlite')), store = new CollaborationStore(owner, { workspace, artifactDir: join(output, 'objects') });
for (const id of ['codex', 'claude']) {
  const member = boot.members.find(m => m.id === id)!, account = boot.accounts.find(a => a.id === member?.accountId)!;
  assert.ok(member?.enabled && member.model && account?.auth === 'api' && account.configured && account.apiKeyEnv && process.env[account.apiKeyEnv]?.trim(), `${id} needs existing configured API credential`);
  store.saveAccount(account); store.saveMember(member);
}
const native = createCollaborationRuntime({ timeoutMs: 240_000 }); let calls = 0;
const tools: { invocationId: string; memberId: string; tool: string; callId: string }[] = [];
const runtime: CollaborationRuntime = { ...native, invoke: async request => { assert.ok(++calls <= 2, 'Two native calls maximum'); return native.invoke({ ...request, onToolCall: async (name, args, callId) => {
  const result = await request.onToolCall(name, args, callId); tools.push({ invocationId: request.invocationId, memberId: request.member.id, tool: name, callId }); console.log(JSON.stringify({ member: request.member.id, tool: name })); return result;
} }); } };
const engine = new CollaborationEngine(store, runtime, { workspace });
const c = store.create({ title: 'N5 bounded native artifact acceptance', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
const checks: string[] = [], check = (label: string, ok: unknown) => { assert.ok(ok, label); checks.push(label); };
const until = async (predicate: () => boolean) => { const deadline = Date.now() + 250000; while (!predicate()) { const failed = store.invocations(c.id).find(i => ['failed', 'interrupted', 'cancelled'].includes(i.status)); assert.ok(!failed, `Native failure: ${failed?.error}`); if (Date.now() >= deadline) throw new Error('Native acceptance timeout'); await new Promise(r => setTimeout(r, 500)); } };
let passed = false, error: string | undefined;
try {
  store.send(c.id, { requestId: randomUUID(), content: '@codex 这是有界真实工具验收。只调用一次 artifact_propose，name="n5-live.md"，content 精确为 "# N5 acceptance\nManaged immutable artifact.\n"。不创建普通任务、不调用 collaboration_request、不请求评审、不写工作区、不提问、不在最终文字 @成员。工具返回 pending 审批后立即结束，仅回复 N5_PROPOSAL_PENDING。用户稍后批准是独立作业，当前无需等待。' }); engine.start();
  await until(() => store.invocations(c.id)[0]?.status === 'succeeded');
  const p = store.artifacts.detail(c.id); check('Codex real tool proposed exactly one immutable version', p.artifactVersions.length === 1 && tools.some(t => t.memberId === 'codex' && t.tool === 'artifact_propose'));
  check('native completion did not imply a file write', p.jobs.length === 0 && p.artifactVersions[0]!.state === 'proposed');
  const a = p.artifactApprovals[0]!, v = p.artifactVersions[0]!;
  store.artifacts.decide(a.id, { requestId: randomUUID(), expectedRevision: a.revision, operationDigest: a.operationDigest, decision: 'approve' }); engine.kick();
  check('exact approval after original exit wrote one managed file', store.artifacts.detail(c.id).jobs[0]?.state === 'succeeded');
  check('disk-backed exact content available', store.artifacts.content(v.id).content === '# N5 acceptance\nManaged immutable artifact.\n');
  store.artifacts.requestReview(c.id, { requestId: randomUUID(), versionId: v.id, digest: v.digest, reviewerMemberId: 'claude' }); engine.kick();
  await until(() => store.invocations(c.id).length === 2 && store.invocations(c.id).every(i => i.status === 'succeeded'));
  const d = store.detail(c.id);
  check('Claude real tool read exact material', tools.some(t => t.memberId === 'claude' && t.tool === 'artifact_read'));
  check('Claude real tool submitted exact review', tools.some(t => t.memberId === 'claude' && t.tool === 'review_submit') && d.reviews?.[0]?.state === 'submitted' && d.reviews[0].current);
  check('both native invocations accepted and exited', d.invocations.length === 2 && d.invocations.every(i => i.acceptance === 'accepted' && i.teardown === 'confirmed' && i.nativeSessionId));
  check('no implicit task completion or automatic success wake', d.tasks?.length === 0 && d.sources.filter(s => ['a2a', 'mention', 'job_result'].includes(s.kind)).length === 0);
  passed = true;
} catch (e) { error = e instanceof Error ? e.message : 'Acceptance failed'; }
finally {
  await engine.stop(); await writeFile(join(output, 'result.json'), JSON.stringify({ passed, error, testedAt: new Date().toISOString(), runtime: 'real CLI with existing API accounts', maximumNativeCalls: 2, calls, checks, tools, detail: store.detail(c.id) }, null, 2)); owner.close();
  console.log(JSON.stringify({ passed, error, calls, checks: checks.length, output }));
}
if (!passed) process.exitCode = 1;
