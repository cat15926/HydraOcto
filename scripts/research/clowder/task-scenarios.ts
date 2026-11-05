import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Step = { label: string; call: string; input: unknown; before: unknown; result: unknown; after: unknown; checks: string[] };
type Scenario = { id: string; title: string; scope: string; steps: Step[] };

/** Research fixture only: execute upstream TypeScript, never reimplement its transitions. */
export async function runTaskScenarios(upstreamRoot: string) {
  const source = (relative: string) => import(pathToFileURL(join(upstreamRoot, relative)).href);
  const ports = 'packages/api/src/domains/cats/services/stores/ports/';
  const custody = 'packages/api/src/domains/ball-custody/';
  const [{ TaskStore }, { MessageStore }, { ThreadStore }, { InMemoryTurnExecutionStore },
    { OrdinaryTaskHandoffService }, { updateOrdinaryTaskFromCallback }] = await Promise.all([
    source(`${ports}TaskStore.ts`), source(`${ports}MessageStore.ts`), source(`${ports}ThreadStore.ts`),
    source('packages/api/src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts'),
    source(`${custody}OrdinaryTaskHandoffService.ts`), source('packages/api/src/routes/callback-ordinary-task-update.ts'),
  ]);
  const scenarios: Scenario[] = [];
  const clone = <T>(value: T): T => structuredClone(value);
  const identityFence = { assertCurrent() {} };
  const baseScope = '直接运行上游 src 中的内存 Task/Message/Thread/TurnExecution store、OrdinaryTaskHandoffService 和 callback 更新 helper。用户、成员及 invocation 身份由研究夹具注入，callback token 校验使用空 fence；不经过 HTTP、Queue、Redis、CLI 或真实模型。turn 的开始、取消和 teardown 证据为显式夹具输入，不代表真实进程确已退出。Task 时间与 ID 由上游实现生成；未覆写全局时钟。';

  async function fixture(owner: string | null) {
    const tasks = new TaskStore();
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const turns = new InMemoryTurnExecutionStore();
    const userId = 'research-task-user';
    const home = await threads.create(userId, 'Research: ordinary Task home', '/research/fixture');
    const accepted = await messages.append({
      userId, from: { kind: 'user', userId }, threadId: home.id,
      content: 'Research fixture: implement the assigned task.', mentions: ['codex', 'sonnet'], timestamp: Date.now(),
    });
    const input = { threadId: home.id, title: 'Research fixture task', why: 'Inspect native Task transitions',
      createdBy: 'codex', kind: 'work', subjectKey: null, ownerCatId: owner, userId, sourceMessageId: accepted.id };
    const task = tasks.create(input);
    const service = new OrdinaryTaskHandoffService({ tasks, messages, threads, turns });
    const turnIds: string[] = [];
    const sourceIds = [accepted.id];
    const snapshot = async () => clone({
      task: await tasks.get(task.id),
      turns: await Promise.all(turnIds.map((id) => turns.get(id))),
      messages: await Promise.all(sourceIds.map((id) => messages.getById(id))),
    });
    return { tasks, messages, threads, turns, userId, home, accepted, task, service, turnIds, sourceIds, snapshot, input };
  }
  async function step(f: any, scenario: Scenario, label: string, call: string, input: unknown,
    run: () => unknown | Promise<unknown>, verify: (result: any, after: any, before: any) => string[]) {
    const before = await f.snapshot();
    const result = await run();
    const after = await f.snapshot();
    const checks = verify(result, after, before);
    scenario.steps.push({ label, call, input: clone(input), before, result: clone(result), after, checks });
    return result;
  }
  async function appendHandoff(f: any, request: any) {
    const message = await f.messages.append({
      from: { kind: 'agent', catId: request.issuer.catId }, userId: request.issuer.userId,
      threadId: request.targetThreadId, content: 'Research fixture: continue this exact Task.',
      mentions: [request.targetCatId], origin: 'callback', timestamp: Date.now(), extra: { taskHandoff: request },
    });
    f.sourceIds.push(message.id);
    return message;
  }
  async function errorResult(run: () => unknown | Promise<unknown>) {
    try { return { returned: await run() }; }
    catch (error) { return { error: { name: (error as Error).name, message: (error as Error).message, code: (error as any).code } }; }
  }

  const f = await fixture(null);
  const first: Scenario = { id: 'task-claim-bind', title: '未分配任务被领取，并绑定精确执行身份', scope: baseScope, steps: [] };
  scenarios.push(first);
  first.steps.push({ label: '创建未分配普通 Task', call: 'TaskStore.create', input: clone(f.input),
    before: clone({ task: null, turns: [], messages: [f.accepted] }), result: clone(f.task), after: await f.snapshot(),
    checks: ['ownerCatId 为 null', 'ownerRevision 为 0', 'status 为 todo', '未设置 executionRef'] });
  assert.equal(f.task.ownerCatId, null); assert.equal(f.task.ownerRevision, 0);
  assert.equal(f.task.status, 'todo'); assert.equal(f.task.executionRef, undefined);
  const a = { userId: f.userId, catId: 'codex', threadId: f.home.id, invocationId: 'research-task-a-1' };
  const t0 = Date.now();
  const turnA = { ...a, parentInvocationId: 'research-task-parent-a', executionKind: 'ordinary', startedAt: t0, providerLifecycleTracked: true };
  await step(f, first, '登记 A 的运行记录并注入 provider 已开始证据', 'InMemoryTurnExecutionStore.createRunning + markProviderStarted',
    { turn: turnA, providerStartedAt: t0 + 1 }, () => {
    const created = f.turns.createRunning(turnA); f.turnIds.push(a.invocationId);
    return { created, providerStarted: f.turns.markProviderStarted(a.invocationId, t0 + 1) };
  }, (result, after) => {
    assert.equal(result.created.outcome, 'created'); assert.equal(result.providerStarted, true);
    assert.equal(after.task.executionRef, undefined);
    return ['运行记录创建成功', '仅登记运行记录尚未绑定任务 executionRef'];
  });
  const recordA = { ...a, parentInvocationId: turnA.parentInvocationId, createdAt: t0,
    originTriggerMessageId: f.accepted.id, callbackToken: 'research-only-not-authenticated' };
  await step(f, first, 'A 将未分配任务更新为 doing', 'updateOrdinaryTaskFromCallback',
    { record: recordA, data: { status: 'doing' }, expectedOwnerRevision: 0 }, () => updateOrdinaryTaskFromCallback({
      task: f.tasks.get(f.task.id), record: recordA, data: { status: 'doing' }, expectedOwnerRevision: 0,
      tasks: f.tasks, messages: f.messages, handoffs: f.service, fence: identityFence,
    }), (result, after) => {
      assert.equal(result.kind, 'updated'); assert.equal(after.task.ownerCatId, 'codex'); assert.equal(after.task.ownerRevision, 1);
      assert.equal(after.task.status, 'doing'); assert.deepEqual(after.task.executionRef, {
        invocationId: a.invocationId, parentInvocationId: turnA.parentInvocationId, catId: a.catId,
        threadId: a.threadId, sourceMessageId: f.accepted.id,
      });
      return ['负责人 null → codex', 'ownerRevision 0 → 1', 'status todo → doing', 'executionRef 五个坐标与 A 的具体调用完全一致'];
    });

  const second: Scenario = { id: 'task-handoff-fences', title: '旧执行退出前不能交接，交接后拒绝旧版本和旧回调',
    scope: `${baseScope} 本场景接续 task-claim-bind 的同一个 Task。未调用 Queue，直接调用其使用的交接准入服务。`, steps: [] };
  scenarios.push(second);
  const handoffInput = { taskId: f.task.id, expectedOwnerRevision: 1, actor: a,
    targetCatId: 'sonnet', targetThreadId: f.home.id };
  const request = await step(f, second, '准备 A → B 交接；尚不修改 Task', 'OrdinaryTaskHandoffService.prepare', handoffInput,
    () => f.service.prepare(handoffInput), (result, after, before) => {
      assert.equal(result.ownerCatId, 'sonnet'); assert.deepEqual(after.task, before.task);
      return ['交接请求中的新 owner 为 sonnet', '准备请求未改变 Task'];
    });
  const message = await step(f, second, '将交接请求保存为来源消息', 'MessageStore.append', { request },
    () => appendHandoff(f, request), (result, after, before) => {
      assert.deepEqual(result.extra.taskHandoff, request); assert.deepEqual(after.task, before.task);
      return ['持久来源结构包含完整 taskHandoff 请求（本次使用内存 store）', '保存消息未改负责人'];
    });
  await step(f, second, 'A 仍运行时尝试落实交接', 'OrdinaryTaskHandoffService.apply', { sourceMessageId: message.id },
    () => f.service.apply(message.id), (result, after, before) => {
      assert.equal(result.kind, 'waiting'); assert.deepEqual(after.task, before.task);
      return ['返回 waiting', 'owner、revision 与 executionRef 均保持原值'];
    });
  await step(f, second, '仅写入 canceled 终态，再尝试交接', 'InMemoryTurnExecutionStore.transitionTerminal + OrdinaryTaskHandoffService.apply',
    { invocationId: a.invocationId, terminal: { status: 'canceled', endedAt: t0 + 2, terminalReason: 'user_cancel' }, sourceMessageId: message.id },
    async () => ({ terminal: f.turns.transitionTerminal(a.invocationId, { status: 'canceled', endedAt: t0 + 2, terminalReason: 'user_cancel' }),
      admission: await f.service.apply(message.id) }), (result, after, before) => {
        assert.equal(result.admission.kind, 'waiting'); assert.equal(after.turns[0].status, 'canceled');
        assert.equal(after.turns[0].providerTeardownAt, undefined); assert.deepEqual(after.task, before.task);
        return ['canceled 不是 provider 退出证明', '交接仍 waiting，Task 不变'];
      });
  await step(f, second, '注入精确 provider teardown 证据', 'InMemoryTurnExecutionStore.recordProviderTeardown + get',
    { invocationId: a.invocationId, at: t0 + 3 }, () => {
      const recorded = f.turns.recordProviderTeardown(a.invocationId, t0 + 3);
      return { recorded, record: f.turns.get(a.invocationId) };
    }, (result, after, before) => {
      assert.equal(result.recorded, undefined); assert.equal(result.record.providerTeardownAt, t0 + 3);
      assert.deepEqual(after.task, before.task);
      return ['退出证据绑定精确 A invocation', '此步仅写证据，尚未释放任务或改变 owner'];
    });
  await step(f, second, '退出证据齐备，落实原交接来源', 'OrdinaryTaskHandoffService.apply', { sourceMessageId: message.id },
    () => f.service.apply(message.id), (result, after) => {
      assert.equal(result.kind, 'applied'); assert.equal(after.task.ownerCatId, 'sonnet'); assert.equal(after.task.ownerRevision, 2);
      assert.equal(after.task.executionRef, null); assert.equal(after.task.lastAppliedHandoffMessageRef, `message:${message.id}`);
      return ['旧 executionRef 释放', 'owner codex → sonnet', 'ownerRevision 1 → 2', '记录精确交接来源'];
    });
  await step(f, second, '重复落实同一来源', 'OrdinaryTaskHandoffService.apply', { sourceMessageId: message.id },
    () => f.service.apply(message.id), (result, after, before) => {
      assert.equal(result.kind, 'replayed'); assert.deepEqual(after.task, before.task);
      return ['返回 replayed', '重复请求不再递增 ownerRevision'];
    });
  const b = { userId: f.userId, catId: 'sonnet', threadId: f.home.id, invocationId: 'research-task-b-1' };
  const turnB = { ...b, parentInvocationId: 'research-task-parent-b', executionKind: 'ordinary', startedAt: t0 + 4, providerLifecycleTracked: true };
  await step(f, second, '绑定 B 的新执行记录并注入 provider 已开始证据', 'InMemoryTurnExecutionStore.createRunning + OrdinaryTaskHandoffService.start + markProviderStarted',
    { turn: turnB, sourceMessageId: message.id, actor: b, providerStartedAt: t0 + 5 }, async () => {
      const created = f.turns.createRunning(turnB); f.turnIds.push(b.invocationId);
      const taskId = await f.service.start(message.id, b, turnB.parentInvocationId);
      const providerStarted = f.turns.markProviderStarted(b.invocationId, t0 + 5);
      return { created, taskId, providerStarted };
    }, (result, after) => {
      assert.equal(result.taskId, f.task.id); assert.equal(result.providerStarted, true);
      assert.deepEqual(after.task.executionRef, {
        invocationId: b.invocationId, parentInvocationId: turnB.parentInvocationId,
        catId: b.catId, threadId: b.threadId, sourceMessageId: message.id,
      });
      return ['B 的具体 invocation 绑定到原 Task', '执行来源精确指向这次交接消息'];
    });
  await step(f, second, '使用旧 ownerRevision 准备下一次交接', 'OrdinaryTaskHandoffService.prepare',
    { ...handoffInput, expectedOwnerRevision: 1 }, () => errorResult(() => f.service.prepare(handoffInput)),
    (result, after, before) => {
      assert.equal(result.error?.code, 'task_assignment_changed'); assert.deepEqual(after.task, before.task);
      return ['旧 revision 1 被拒绝，当前 revision 为 2', '负责人及 B 执行占用不变'];
    });
  await step(f, second, 'A 的旧 callback 尝试把任务标为 done', 'updateOrdinaryTaskFromCallback',
    { record: recordA, expectedOwnerRevision: 1, data: { status: 'done' } }, () => updateOrdinaryTaskFromCallback({
      task: f.tasks.get(f.task.id), record: recordA, data: { status: 'done' }, expectedOwnerRevision: 1,
      tasks: f.tasks, messages: f.messages, handoffs: f.service, fence: identityFence,
    }), (result, after, before) => {
      assert.equal(result.kind, 'refused'); assert.equal(result.reason, 'task_assignment_changed');
      assert.deepEqual(after.task, before.task);
      return ['旧 callback 被 task_assignment_changed 拒绝', '任务仍 doing，B 仍占用'];
    });
  await step(f, second, 'A 的迟到 finish 通知尝试释放任务', 'OrdinaryTaskHandoffService.finish',
    { taskId: f.task.id, invocationId: a.invocationId }, () => f.service.finish(f.task.id, a.invocationId), (result, after, before) => {
      assert.equal(result, undefined);
      assert.deepEqual(after.task, before.task); assert.equal(after.task.executionRef.invocationId, b.invocationId);
      return ['旧 finish 不释放 B 的新 invocation'];
    });
  const recordB = { ...b, parentInvocationId: turnB.parentInvocationId, createdAt: t0 + 4,
    originTriggerMessageId: message.id, callbackToken: 'research-only-not-authenticated' };
  await step(f, second, 'B 通过当前交接来源明确完成任务', 'updateOrdinaryTaskFromCallback',
    { record: recordB, data: { status: 'done' } }, () => updateOrdinaryTaskFromCallback({
      task: f.tasks.get(f.task.id), record: recordB, data: { status: 'done' },
      tasks: f.tasks, messages: f.messages, handoffs: f.service, fence: identityFence,
    }), (result, after, before) => {
      assert.equal(result.kind, 'updated'); assert.equal(after.task.status, 'done');
      assert.deepEqual(after.task.executionRef, before.task.executionRef);
      return ['只有有效 B 更新将 status 改为 done', '业务 done 本身不清除 executionRef'];
    });
  await step(f, second, '注入 B 的终态与退出证据后，单独释放执行占用', 'InMemoryTurnExecutionStore.transitionTerminal + OrdinaryTaskHandoffService.finish',
    { invocationId: b.invocationId, terminal: { status: 'succeeded', endedAt: t0 + 6, providerTeardownAt: t0 + 6 } },
    async () => {
      const terminal = f.turns.transitionTerminal(b.invocationId, { status: 'succeeded', endedAt: t0 + 6, providerTeardownAt: t0 + 6 });
      const finished = await f.service.finish(f.task.id, b.invocationId); return { terminal, finished };
    }, (_result, after) => {
      assert.equal(after.task.executionRef, null); assert.equal(after.task.status, 'done');
      assert.equal(after.task.ownerCatId, 'sonnet'); assert.equal(after.task.ownerRevision, 2);
      return ['executionRef 清为 null', 'done 与负责人 sonnet 保留', '释放执行不回滚负责人'];
    });

  const g = await fixture('codex');
  const third: Scenario = { id: 'task-cross-thread-delegation', title: '跨会话委派保留 home owner，同时绑定子会话执行者',
    scope: `${baseScope} 使用新的独立 Task。获准 delegate provider 是夹具注入的精确 (catId, threadId, evidenceRef) 记录；未验证 ProposalStore 或人工审批产生该记录的流程，也未运行真实跨会话队列。`, steps: [] };
  scenarios.push(third);
  const child = await g.threads.create(g.userId, 'Research: approved child', '/research/fixture');
  const coordinator = { userId: g.userId, catId: 'codex', threadId: g.home.id, invocationId: 'research-cross-coordinator' };
  const crossInput = { taskId: g.task.id, expectedOwnerRevision: 0, actor: coordinator,
    targetCatId: 'sonnet', targetThreadId: child.id };
  await step(g, third, '没有获准委派锚点时尝试跨会话交接', 'OrdinaryTaskHandoffService.prepare', crossInput,
    () => errorResult(() => g.service.prepare(crossInput)), (result, after, before) => {
      assert.equal(result.error?.code, 'task_approved_contract_unavailable'); assert.deepEqual(after.task, before.task);
      return ['仅同一用户和项目不足以获得跨会话执行权', '无 approved anchor，准备请求被拒绝'];
    });
  const approvedDelegate = { catId: 'sonnet', threadId: child.id, evidenceRef: 'research:injected-approved-anchor' };
  const delegatedService = new OrdinaryTaskHandoffService({ tasks: g.tasks, messages: g.messages, threads: g.threads,
    turns: g.turns, delegates: { async getForTask() { return [clone(approvedDelegate)]; } } });
  const crossRequest = await step(g, third, '注入精确获准锚点后准备委派', 'OrdinaryTaskHandoffService.prepare',
    { request: crossInput, injectedApprovedDelegate: approvedDelegate }, () => delegatedService.prepare(crossInput),
    (result, after, before) => {
      assert.equal(result.ownerCatId, 'codex'); assert.equal(result.targetCatId, 'sonnet');
      assert.equal(result.targetThreadId, child.id); assert.deepEqual(result.approvedAnchor, approvedDelegate);
      assert.deepEqual(after.task, before.task);
      return ['请求 owner 仍为 codex', '执行目标是子会话 sonnet', '锚点与获准的具体成员/会话/证据相等'];
    });
  const crossMessage = await step(g, third, '保存子会话交接来源并落实委派', 'MessageStore.append + OrdinaryTaskHandoffService.apply',
    { request: crossRequest }, async () => {
      const source = await appendHandoff(g, crossRequest);
      return { message: source, admission: await delegatedService.apply(source.id) };
    }, (result, after) => {
      assert.equal(result.admission.kind, 'applied'); assert.equal(after.task.ownerCatId, 'codex');
      assert.equal(after.task.threadId, g.home.id); assert.equal(after.task.ownerRevision, 0);
      assert.equal(after.task.lastAppliedHandoffMessageRef, `message:${result.message.id}`);
      return ['Task 的 home thread 保留', 'owner codex 和 ownerRevision 0 保留', '交接来源记录已更新'];
    });
  const delegatedActor = { userId: g.userId, catId: 'sonnet', threadId: child.id, invocationId: 'research-cross-child-1' };
  const t1 = Date.now();
  const delegatedTurn = { ...delegatedActor, parentInvocationId: 'research-cross-parent', executionKind: 'ordinary', startedAt: t1 };
  await step(g, third, '将子会话 sonnet 的执行记录绑定到原 Task', 'InMemoryTurnExecutionStore.createRunning + OrdinaryTaskHandoffService.start',
    { turn: delegatedTurn, sourceMessageId: crossMessage.message.id }, async () => {
      const created = g.turns.createRunning(delegatedTurn); g.turnIds.push(delegatedActor.invocationId);
      return { created, taskId: await delegatedService.start(crossMessage.message.id, delegatedActor, delegatedTurn.parentInvocationId) };
    }, (result, after) => {
      assert.equal(result.taskId, g.task.id); assert.equal(after.task.ownerCatId, 'codex'); assert.equal(after.task.threadId, g.home.id);
      assert.deepEqual(after.task.executionRef, { invocationId: delegatedActor.invocationId,
        parentInvocationId: delegatedTurn.parentInvocationId, catId: 'sonnet', threadId: child.id, sourceMessageId: crossMessage.message.id });
      return ['整体 owner=codex/home thread', '实际 executionRef=sonnet/child thread', '两种身份可以同时存在而不矛盾'];
    });
  const delegatedRecord = { ...delegatedActor, parentInvocationId: delegatedTurn.parentInvocationId, createdAt: t1,
    originTriggerMessageId: crossMessage.message.id, callbackToken: 'research-only-not-authenticated' };
  await step(g, third, '获准子执行通过明确 callback 完成 home Task', 'updateOrdinaryTaskFromCallback',
    { record: delegatedRecord, data: { status: 'done' } }, () => updateOrdinaryTaskFromCallback({
      task: g.tasks.get(g.task.id), record: delegatedRecord, data: { status: 'done' }, tasks: g.tasks,
      messages: g.messages, handoffs: delegatedService, fence: identityFence,
    }), (result, after) => {
      assert.equal(result.kind, 'updated'); assert.equal(after.task.status, 'done'); assert.equal(after.task.ownerCatId, 'codex');
      assert.equal(after.task.threadId, g.home.id); assert.equal(after.task.executionRef.invocationId, delegatedActor.invocationId);
      return ['精确绑定的子执行可完成原 Task', '完成不移动 home、不改 owner，也不自动清除 executionRef'];
    });

  return { scenarios, sources: [
    { path: 'packages/shared/src/types/task.ts', line: 192, purpose: 'TaskExecutionRef 与 TaskItem 的实际字段' },
    { path: `${ports}TaskItemFactory.ts`, line: 6, purpose: '普通 Task 创建默认值与初始执行匹配校验' },
    { path: `${ports}TaskStore.ts`, line: 87, purpose: '本 harness 使用的上游内存 store 与原生 mutation 调用' },
    { path: `${ports}OrdinaryTaskMutation.ts`, line: 207, purpose: '未分配领取、更新与精确 callback actor 匹配' },
    { path: `${ports}OrdinaryTaskMutation.ts`, line: 261, purpose: '原生 handoff 与 ownerRevision 变化' },
    { path: `${custody}OrdinaryTaskHandoffContract.ts`, line: 6, purpose: '交接请求/结果字段与预期 assignment 快照' },
    { path: `${custody}OrdinaryTaskHandoffService.ts`, line: 45, purpose: 'prepare/apply/start/finish 真实编排实现' },
    { path: `${custody}OrdinaryTaskHandoffService.ts`, line: 214, purpose: 'provider teardown 与精确执行释放条件' },
    { path: `${custody}OrdinaryTaskHandoffAuthority.ts`, line: 19, purpose: '跨会话同用户/项目及精确 delegate 锚点校验' },
    { path: 'packages/api/src/routes/callback-ordinary-task-update.ts', line: 13, purpose: '旧来源、版本和具体调用的任务更新校验' },
    { path: 'packages/api/src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts', line: 35, purpose: '真实运行记录 store；本次 lifecycle 事实由夹具注入' },
  ] };
}
