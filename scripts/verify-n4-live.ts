/** Bounded dual CLI/API acceptance: owner Codex → ordinary Claude assistance → formal Claude ownership. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import type { CollaborationBootstrap, CollaborationRuntime, OrdinaryTask } from '../shared/collaboration.js';

const output = resolve(process.env.VALIDATION_OUTPUT_DIR || `.local-data/validation/n4-live/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(join(output, 'workspace'), { recursive: true }); const workspace = await realpath(join(output, 'workspace'));
const boot = await (await fetch(`${process.env.PLATFORM_URL || 'http://127.0.0.1:4310'}/api/collaboration/bootstrap`)).json() as CollaborationBootstrap;
const owner = new Store(join(output, 'acceptance.sqlite')), store = new CollaborationStore(owner, { workspace });
for (const id of ['codex', 'claude']) {
  const member = boot.members.find(m => m.id === id)!, account = boot.accounts.find(a => a.id === member?.accountId)!;
  assert.ok(member?.enabled && member.model && account?.auth === 'api' && account.configured && account.apiKeyEnv && process.env[account.apiKeyEnv]?.trim(), `${id} requires existing API credential`);
  store.saveAccount(account); store.saveMember(member);
}
const native = createCollaborationRuntime({ timeoutMs: 240_000 });
const observations: { invocationId: string; memberId: string; tool: string; callId: string; ownerBefore: string | null; ownerAfter: string | null; task: OrdinaryTask; result: unknown }[] = [];
const runtime: CollaborationRuntime = { ...native, invoke: async request => native.invoke({ ...request, onToolCall: async (name, args, callId) => {
  const before = store.tasks.list(request.conversationId)[0]!;
  const result = await request.onToolCall(name, args, callId);
  const after = store.tasks.getTask(before.id);
  observations.push({ invocationId: request.invocationId, memberId: request.member.id, tool: name, callId, ownerBefore: before.ownerMemberId, ownerAfter: after.ownerMemberId, task: after, result });
  console.log(JSON.stringify({ tool: name, member: request.member.id, owner: after.ownerMemberId, status: after.status, waitingHandoff: !!after.pendingHandoffId }));
  return result;
} }) };
const engine = new CollaborationEngine(store, runtime, { workspace }), checks: string[] = [];
const check = (label: string, ok: unknown) => { assert.ok(ok, label); checks.push(label); };
const c = store.create({ title: 'N4 isolated real handoff acceptance', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
const task = store.tasks.create(c.id, { requestId: randomUUID(), title: 'N4 三次执行的普通协助与正式交接验收', ownerMemberId: 'codex', description:
  '这是合成工具协议验收，没有文件写入。请严格执行分工，不增加额外协作或任务。若你是 codex：先 task_list 读取此任务最新版本，再 task_update doing；然后只调用一次 collaboration_request，targets=["claude"]，content="这是普通 A2A 辅助核验，不是任务交接。仅调用 task_list 查看任务，核对本执行不是 task.executionRef，最终只回复 N4_ASSIST_ONLY。不得调用 task_update/task_handoff，不得继续请求成员，不要在正文写 @提及。"。收到工具回执即可，不等待 Claude 的公共回复；再 task_list 读取最新版本，调用一次 task_handoff 将此任务正式转交 targetMemberId=claude，reason="请接任并显式完成这项合成验收任务，不需要再次请求协助。"。收到 waiting 回执后立即结束本轮，只回复 N4_HANDOFF_WAITING，不要在正文 @成员。若你是 claude 且本次输入是正式交接的任务来源：先 task_list，确认此任务 ownerMemberId=claude 且 executionRef 是你本轮，然后使用当前 task revision/ownerRevision 调用 task_update done，reason="已按正式交接核验并显式完成。"，最后只回复 N4_TASK_DONE。不要创建任务，不要 A2A，不要文本 @。普通 A2A 辅助执行不准修改任务状态。'
}).task;
let passed = false, error: string | undefined;
try {
  engine.start(); const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const d = store.detail(c.id); assert.ok(d.invocations.length <= 3, 'No extra invocation outside the bounded three-step scenario');
    const failed = d.invocations.find(i => ['failed', 'interrupted', 'cancelled'].includes(i.status)); assert.ok(!failed, `Native invocation failed: ${failed?.error}`);
    if (d.invocations.length === 3 && d.invocations.every(i => i.status === 'succeeded' && i.teardown === 'confirmed') && store.tasks.getTask(task.id).status === 'done') break;
    await new Promise(r => setTimeout(r, 500));
  }
  const d = store.detail(c.id), final = store.tasks.getTask(task.id), h = d.taskHandoffs![0]!;
  check('exactly three real CLI invocations succeeded and exited', d.invocations.length === 3 && d.invocations.every(i => i.status === 'succeeded' && i.teardown === 'confirmed'));
  check('all actual inputs were accepted with exact native session identity', d.invocations.every(i => i.acceptance === 'accepted' && i.nativeSessionId));
  check('ordinary assistance leaves owner Codex unchanged', observations.some(o => o.tool === 'collaboration_request' && o.ownerBefore === 'codex' && o.ownerAfter === 'codex'));
  const prepared = observations.find(o => o.tool === 'task_handoff');
  check('real handoff tool returns waiting while old execution remains bound', prepared?.ownerAfter === 'codex' && prepared.task.executionRef?.invocationId === prepared.invocationId && !!prepared.task.pendingHandoffId);
  check('formal handoff applied once after release', d.taskHandoffs!.length === 1 && h.state === 'applied' && final.ownerMemberId === 'claude' && final.ownerRevision === 2);
  const assist = d.sources.find(s => s.kind === 'a2a')!, transfer = d.sources.find(s => s.kind === 'task_handoff')!;
  check('assistance and transfer retain distinct durable source identities', !!assist && !!transfer && assist.id !== transfer.id && transfer.id === h.sourceId && assist.taskRef === undefined);
  const helper = d.invocations.find(i => d.responses.find(r => r.id === i.responseId)?.inputSourceIds.includes(assist.id))!;
  check('A2A helper invocation has no task execution grant', helper.memberId === 'claude' && !helper.taskBindings?.length);
  const completion = observations.find(o => o.tool === 'task_update' && o.task.status === 'done');
  check('Claude explicitly completes only after acquiring exact execution', completion?.memberId === 'claude' && completion.task.executionRef?.invocationId === completion.invocationId && completion.invocationId !== helper.id);
  check('done was recorded before actual execution release', !!completion?.task.executionRef && final.executionRef === undefined && final.lastExecutionRef?.invocationId === completion?.invocationId);
  check('each of the three sources has one exact consumption', d.sources.length === 3 && d.consumptions.length === 3 && d.deliveries.every(x => x.status === 'consumed'));
  const changed = store.events(0, c.id).find(e => e.type === 'task.owner_changed')!, released = store.events(0, c.id).find(e => e.type === 'task.execution_released' && e.data.invocationId === prepared?.invocationId)!;
  check('durable ownership event follows original release event', !!changed && !!released && changed.id > released.id);
  check('both CLI adapters actually executed task tools', ['codex', 'claude'].every(member => observations.some(o => o.memberId === member && o.tool === 'task_list')));
  passed = true;
} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); process.exitCode = 1; }
finally {
  await engine.stop(); const detail = store.detail(c.id);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed, testedAt: new Date().toISOString(), version: '0.5.0-n4', checks, error, runtimeInvocations: detail.invocations.length, providerRequestCount: 'not_measured', observations, detail,
    limitations: ['API-authenticated CLI combinations only; no official subscription login acceptance.', 'Three platform invocations; internal provider requests and billing not measured.', 'Task transfer is same-conversation; unknown in-flight instances still require exact release proof.'] }, null, 2) + '\n');
  owner.close(); console.log(JSON.stringify({ passed, checks: checks.length, error, output }));
}
