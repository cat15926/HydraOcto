import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Step = { label: string; call: string; input: unknown; before: unknown; result: unknown; after: unknown; checks: string[] };
type Scenario = { id: string; title: string; scope: string; steps: Step[] };
const copy = (value: unknown): any => structuredClone(value);

/** Research fixtures call upstream source directly; no provider, HTTP listener, Redis or model is started. */
export async function runMessageScenarios(upstreamRoot: string) {
  const source = (path: string) => import(pathToFileURL(join(upstreamRoot, path)).href);
  const routing = 'packages/api/src/domains/cats/services/agents/routing/';
  const invocation = 'packages/api/src/domains/cats/services/agents/invocation/';
  const { MultiMentionOrchestrator } = await source(`${routing}MultiMentionOrchestrator.ts`);
  const { resolveCrossThreadCoordination } = await source('packages/api/src/routes/cross-thread-coordination.ts');
  const { InvocationQueue } = await source(`${invocation}InvocationQueue.ts`);
  const { InMemoryQueueLedgerStore } = await source(`${invocation}queue-ledger/InMemoryQueueLedgerStore.ts`);
  const { MessageStore } = await source('packages/api/src/domains/cats/services/stores/ports/MessageStore.ts');
  const scenarios: Scenario[] = [];
  const base = {
    threadId: 'research-message-thread', initiator: 'research-planner', callbackTo: 'research-planner',
    targets: ['research-implementer', 'research-reviewer'], question: '独立判断方案的两个风险，并给出依据。',
    context: '全部内容是本地研究夹具，不代表真实模型输出。', timeoutMinutes: 3,
  };
  const orch = new MultiMentionOrchestrator();
  const happy: Scenario = { id: 'message-aggregate', title: '两分支聚合：创建、去重、部分结果与完成',
    scope: '实跑上游 MultiMentionOrchestrator 内存状态机；响应文本由研究脚本提供，未执行 HTTP 路由、调度器、模型或汇总发表。callbackTo 只是这里的请求字段，不能据此推断回唤。', steps: [] };
  scenarios.push(happy);
  let requestId: string | undefined;
  const aggregateSnapshot = () => requestId ? copy(orch.getResult(requestId)) : null;
  const recordStep = async (scenario: Scenario, label: string, call: string, input: unknown,
    snapshot: () => unknown, run: () => unknown | Promise<unknown>, verify: (result: any, before: any, after: any) => string[]) => {
    const before = copy(snapshot());
    const result = copy(await run());
    const after = copy(snapshot());
    const checks = verify(result, before, after);
    scenario.steps.push({ label, call, input: copy(input), before, result, after, checks });
  };
  const createInput = { ...base, idempotencyKey: 'research-two-branches' };
  await recordStep(happy, '创建两分支请求', 'MultiMentionOrchestrator.create', createInput, aggregateSnapshot,
    () => { const r = orch.create(copy(createInput)); requestId = r.id; return r; },
    (r, _b, a) => { assert.equal(r.status, 'pending'); assert.equal(a.responses.length, 0); assert.equal(r.targets.length, 2); return ['请求为 pending', '目标有两名，尚无分支结果']; });
  await recordStep(happy, '开始收集', 'MultiMentionOrchestrator.start', { requestId }, aggregateSnapshot,
    () => orch.start(requestId), (_r, _b, a) => { assert.equal(a.request.status, 'running'); return ['状态从 pending 变为 running']; });
  await recordStep(happy, '相同幂等键重放创建', 'MultiMentionOrchestrator.create', createInput, aggregateSnapshot,
    () => orch.create(copy(createInput)), (r, b, a) => { assert.equal(r.id, requestId); assert.deepEqual(a, b); return ['返回同一 requestId', '没有创建新组或改变状态']; });
  await recordStep(happy, '第一成员交付', 'MultiMentionOrchestrator.recordResponse', { requestId, catId: base.targets[0], content: '夹具结果：输入边界存在歧义。' }, aggregateSnapshot,
    () => orch.recordResponse(requestId, base.targets[0], '夹具结果：输入边界存在歧义。'), (r, _b, a) => { assert.equal(r, 'partial'); assert.equal(a.responses.length, 1); return ['仅一项 received', '组状态为 partial']; });
  await recordStep(happy, '重复结果不会覆盖首个结果', 'MultiMentionOrchestrator.recordResponse', { requestId, catId: base.targets[0], content: '重复且不同的内容' }, aggregateSnapshot,
    () => orch.recordResponse(requestId, base.targets[0], '重复且不同的内容'), (r, b, a) => { assert.equal(r, 'partial'); assert.deepEqual(a, b); return ['相同成员重复提交被忽略', '首个分支正文保持不变']; });
  await recordStep(happy, '非目标成员结果被忽略', 'MultiMentionOrchestrator.recordResponse', { requestId, catId: 'research-outsider', content: '非目标结果' }, aggregateSnapshot,
    () => orch.recordResponse(requestId, 'research-outsider', '非目标结果'), (_r, b, a) => { assert.deepEqual(a, b); return ['非目标成员不能加入该聚合结果']; });
  await recordStep(happy, '第二成员交付后收齐', 'MultiMentionOrchestrator.recordResponse', { requestId, catId: base.targets[1], content: '夹具结果：补充重试约束后可接受。' }, aggregateSnapshot,
    () => orch.recordResponse(requestId, base.targets[1], '夹具结果：补充重试约束后可接受。'), (r, _b, a) => { assert.equal(r, 'done'); assert.equal(a.responses.length, 2); assert.equal(a.request.callbackTo, base.initiator); return ['组成为 done', '结果包含两项 received', 'callbackTo 仍是请求元数据；这个类没有消息队列依赖']; });
  await recordStep(happy, '完成后的迟到改写被忽略', 'MultiMentionOrchestrator.recordResponse', { requestId, catId: base.targets[1], content: '迟到改写' }, aggregateSnapshot,
    () => orch.recordResponse(requestId, base.targets[1], '迟到改写'), (_r, b, a) => { assert.deepEqual(a, b); return ['终态保持 done', '迟到正文未进入该聚合器结果']; });

  const timeoutOrch = new MultiMentionOrchestrator();
  let timeoutId: string | undefined;
  const timeoutSnapshot = () => timeoutId ? copy(timeoutOrch.getResult(timeoutId)) : null;
  const timed: Scenario = { id: 'message-timeout', title: '聚合截止、迟到结果与新实例读取',
    scope: '实跑上游聚合器；直接调用 handleTimeout 表示截止事件，未等待真实定时器、未运行 HTTP 超时处理或部分汇总发表。new 实例模拟内存状态消失，未重启真实服务。', steps: [] };
  scenarios.push(timed);
  await recordStep(timed, '创建并启动另一个组', 'MultiMentionOrchestrator.create + start', { ...base, idempotencyKey: 'research-timeout' }, timeoutSnapshot,
    () => { const r = timeoutOrch.create({ ...copy(base), idempotencyKey: 'research-timeout' }); timeoutId = r.id; timeoutOrch.start(r.id); return timeoutOrch.getResult(r.id); },
    (_r, _b, a) => { assert.equal(a.request.status, 'running'); return ['独立组进入 running']; });
  await recordStep(timed, '截止前第一成员交付', 'MultiMentionOrchestrator.recordResponse', { requestId: timeoutId, catId: base.targets[0], content: '夹具：已检查输入契约。' }, timeoutSnapshot,
    () => timeoutOrch.recordResponse(timeoutId, base.targets[0], '夹具：已检查输入契约。'), (r) => { assert.equal(r, 'partial'); return ['截止前已有一项 received']; });
  await recordStep(timed, '人为触发截止入口', 'MultiMentionOrchestrator.handleTimeout', { requestId: timeoutId, clock: '直接调用；没有伪装真实时间经过' }, timeoutSnapshot,
    () => timeoutOrch.handleTimeout(timeoutId), (_r, _b, a) => { assert.equal(a.request.status, 'timeout'); assert.equal(a.responses.find((v: any) => v.catId === base.targets[1]).status, 'timeout'); assert.equal(a.responses.find((v: any) => v.catId === base.targets[0]).status, 'received'); return ['已收到结果保留', '未返回分支记录 timeout', '组状态为 timeout；未代表汇总已经发表']; });
  await recordStep(timed, '第二成员迟到不会改变 timeout', 'MultiMentionOrchestrator.recordResponse', { requestId: timeoutId, catId: base.targets[1], content: '夹具：截止后才返回。' }, timeoutSnapshot,
    () => timeoutOrch.recordResponse(timeoutId, base.targets[1], '夹具：截止后才返回。'), (_r, b, a) => { assert.deepEqual(a, b); return ['迟到正文被忽略', '缺失分支仍是 timeout']; });
  await recordStep(timed, '新实例找不到旧聚合请求', 'new MultiMentionOrchestrator().getResult', { requestId: timeoutId }, timeoutSnapshot,
    () => { try { new MultiMentionOrchestrator().getResult(timeoutId); assert.fail('expected missing request'); } catch (error) { assert.match(String(error), /Multi-mention request not found/); return { error: String(error) }; } },
    (r, b, a) => { assert.match(r.error, /not found/); assert.deepEqual(a, b); return ['原实例数据仍存在', '新实例没有旧组，未提供持久恢复']; });

  const ledger = new InMemoryQueueLedgerStore();
  const messages = new MessageStore();
  const admitted: any[] = [];
  const queue = new InvocationQueue(ledger, { onAdmitted: (event: any) => admitted.push({ threadId: event.threadId, messageId: event.message?.id, entries: copy(event.entries) }) });
  const queueThread = 'research-durable-message';
  const userId = 'research-user';
  const sourceMessage = { from: { kind: 'agent', catId: base.initiator }, userId, threadId: queueThread, content: '请两位成员分别检查输入与错误处理。', mentions: [...base.targets], timestamp: Date.now(), origin: 'callback', idempotencyKey: 'research-source-message' };
  const queueInput = { threadId: queueThread, userId, kind: 'message_wake', ownerAuthProvenance: 'strict', from: sourceMessage.from, content: sourceMessage.content, targetCats: [...base.targets], intent: 'execute', autoExecute: true, sourceCategory: 'a2a', a2aParentInvocationId: 'research-parent-invocation' };
  const queueSnapshot = () => ({ messages: copy(messages.getByThread(queueThread, 100, userId, { includeQueuedCatMessages: true })), queue: copy(queue.list(queueThread, userId)), admissions: copy(admitted) });
  const queued: Scenario = { id: 'message-queue', title: '真实消息与 Queue 记录：一条来源、多接收者和重放',
    scope: '实跑源码 MessageStore、InvocationQueue 和 InMemoryQueueLedgerStore。onAdmitted 仅记录通知，不调度执行；没有运行 QueueProcessor/provider/HTTP，因此后面的普通回复仅证明 append 本身不创建 Queue。', steps: [] };
  scenarios.push(queued);
  let sourceId: string | undefined;
  let entryId: string | undefined;
  await recordStep(queued, '消息与待办一同准入', 'InvocationQueue.send', { message: sourceMessage, input: queueInput }, queueSnapshot,
    async () => { const r = await queue.send(messages, copy(sourceMessage), copy(queueInput)); sourceId = r.message.id; entryId = r.entry.id; return r; },
    (r, _b, a) => { assert.equal(r.outcome, 'enqueued'); assert.equal(r.entries.length, 1); assert.deepEqual(r.entry.targets, base.targets); assert.equal(r.entry.payload.messageId, r.message.id); assert.equal(a.admissions.length, 1); return ['一条来源生成一个 Queue row，而不是每目标一行', 'targets 中保存两个待投递成员', 'Queue payload.messageId 指向真实来源消息', '已触发准入通知，但研究适配器未启动执行']; });
  await recordStep(queued, '重发相同来源', 'InvocationQueue.send', { message: sourceMessage, input: queueInput }, queueSnapshot,
    () => queue.send(messages, copy(sourceMessage), copy(queueInput)), (r, b, a) => { assert.equal(r.deduped, true); assert.equal(r.message.id, sourceId); assert.equal(r.entries[0].id, entryId); assert.equal(a.messages.length, b.messages.length); assert.equal(a.queue.length, 1); return ['幂等重放使用同一 messageId 和 Queue id', '未重复发表正文或创建第二行待办']; });
  await recordStep(queued, '只领取第一个接收者', 'InvocationQueue.markProcessingByIdDurable', { threadId: queueThread, entryId, targetCatId: base.targets[0] }, queueSnapshot,
    () => queue.markProcessingByIdDurable(queueThread, entryId, base.targets[0]), (_r, _b, a) => { const row = a.queue.find((v: any) => v.id === entryId); assert.equal(row.status, 'claimed'); assert.deepEqual(row.claimedTargetIds, [base.targets[0]]); return ['领取使用 claimed 与 claimId', '只保护所选目标，未把第二目标冒充为正在执行']; });
  await recordStep(queued, '恢复短期领取', 'InvocationQueue.restoreClaimedEntries', { threadId: queueThread, entryIds: [entryId] }, queueSnapshot,
    () => queue.restoreClaimedEntries(queueThread, [entryId]), (r, _b, a) => { assert.equal(r, true); assert.equal(a.queue[0].status, 'queued'); assert.deepEqual(a.queue[0].targets, base.targets); return ['未运行模型，恢复原行等待两名接收者']; });
  const ordinaryReply = { from: { kind: 'agent', catId: base.targets[0] }, userId, threadId: queueThread, content: '夹具普通回复：检查完成。', mentions: [], timestamp: Date.now() };
  await recordStep(queued, '发表没有接收目标的普通回复', 'MessageStore.append', ordinaryReply, queueSnapshot,
    () => messages.append(copy(ordinaryReply)), (r, b, a) => { assert.deepEqual(r.mentions, []); assert.equal(a.messages.length, b.messages.length + 1); assert.deepEqual(a.queue, b.queue); assert.equal(a.queue.some((v: any) => v.targets.includes(base.initiator)), false); return ['回复进入公共历史', 'append 本身不创建新的 Queue 行', '此步骤未运行完整 provider 完成链；不把它当作全栈实测']; });

  const coord: Scenario = { id: 'message-coordination', title: '跨会话协调的终止 ACK 与明确新工作',
    scope: '实跑 resolveCrossThreadCoordination 纯 helper；输入是合成的服务器已识别意图，未运行跨会话 HTTP 入口、权限检查或派发。', steps: [] };
  scenarios.push(coord);
  const incoming = { sourceThreadId: 'research-source-thread', coordination: { id: 'coord-research-existing', phase: 'terminal', hop: 4, subjectRef: 'subject:research:message-flow' } };
  let coordResult: unknown = null;
  const ackInput = { incoming, targetThreadId: incoming.sourceThreadId, hasExplicitRoutingIntent: false };
  await recordStep(coord, '终止结果后的无新工作确认', 'resolveCrossThreadCoordination', ackInput, () => coordResult,
    () => coordResult = resolveCrossThreadCoordination(copy(ackInput)), (r) => { assert.equal(r.coordination.phase, 'ack'); assert.equal(r.coordination.id, incoming.coordination.id); assert.equal(r.suppressRouting, true); return ['沿用原协调 id，hop + 1', 'ACK 设置 suppressRouting=true']; });
  const workInput = { ...ackInput, hasExplicitRoutingIntent: true };
  await recordStep(coord, '终止后明确指定新的派工', 'resolveCrossThreadCoordination', workInput, () => coordResult,
    () => coordResult = resolveCrossThreadCoordination(copy(workInput)), (r) => { assert.equal(r.coordination.phase, 'active'); assert.notEqual(r.coordination.id, incoming.coordination.id); assert.equal(r.suppressRouting, false); return ['新的明确意图建立 fresh active id', '新工作不被礼貌 ACK 规则吞掉']; });
  // Run the actual route handler/flush with explicitly fake transport and completion boundaries.
  const { catRegistry } = await import('@cat-cafe/shared');
  const routeMembers = ['research-route-a', 'research-route-b', 'research-route-c'];
  for (const id of routeMembers) if (!catRegistry.has(id)) catRegistry.register(id, {
    id, displayName: id, mentionPatterns: [`@${id}`], provider: 'research-fixture', model: 'no-model',
  } as any);
  const { registerMultiMentionRoutes, getMultiMentionOrchestrator, resetMultiMentionOrchestrator } = await source('packages/api/src/routes/callback-multi-mention-routes.ts');
  resetMultiMentionOrchestrator();
  const routeMessages = new MessageStore();
  const routeQueue = new InvocationQueue(new InMemoryQueueLedgerStore());
  const routeThread = 'research-route-flush';
  const routeUser = 'research-route-user';
  const turnId = 'research-route-callback-invocation';
  const now = Date.now();
  const trigger = routeMessages.append({ from: { kind: 'user', userId: routeUser }, userId: routeUser, threadId: routeThread,
    content: '合成用户输入：请发起双人评估。', mentions: [routeMembers[0]], timestamp: now });
  routeMessages.append({ from: { kind: 'agent', catId: routeMembers[0] }, userId: routeUser, threadId: routeThread,
    content: '合成的活动回复来源。', mentions: [], timestamp: now + 1, origin: 'stream',
    idempotencyKey: `message-lifecycle-response:${turnId}`,
    lifecycle: { kind: 'response', orderKey: `${now + 1}:${turnId}`, invocationId: turnId, targetId: routeMembers[0],
      inputEntryIds: [], inputMessageIds: [trigger.id], status: 'processing', startedAt: now + 1 } });
  const handlers = new Map<string, any>();
  const hooks = new Map<string, { entryId: string; callback: (...args: any[]) => unknown }>();
  const broadcasts: any[] = [];
  const routeErrors: any[] = [];
  const quiet = () => {};
  const log = { info: quiet, debug: quiet, warn: quiet, error: (...args: any[]) => routeErrors.push(args.map(String)) };
  registerMultiMentionRoutes({ post: (path: string, handler: any) => handlers.set(path, handler), get: quiet, log } as any, {
    messageStore: routeMessages, invocationQueue: routeQueue, router: {}, invocationRecordStore: {},
    socketManager: { broadcastToRoom: (...args: any[]) => broadcasts.push(copy(args)), broadcastAgentMessage: quiet, emitToUser: quiet },
    queueProcessor: { registerEntryCompleteHook: (entryId: string, callback: any, targetCatId: string) => hooks.set(targetCatId, { entryId, callback }),
      unregisterEntryCompleteHook: quiet },
  } as any);
  let routeRequestId: string | undefined;
  const routeSnapshot = () => ({
    messages: routeMessages.getByThread(routeThread, 100, routeUser, { includeQueuedCatMessages: true }),
    queue: routeQueue.list(routeThread, routeUser),
    aggregate: routeRequestId ? getMultiMentionOrchestrator().getResult(routeRequestId) : null,
    registeredCompletionTargets: [...hooks.keys()], broadcasts, routeErrors,
  });
  const routeScenario: Scenario = { id: 'message-route-flush', title: '真实 multi-mention handler：队列准入与汇总发表',
    scope: '直接调用上游 registerMultiMentionRoutes 注册的真实 handler，未开启 HTTP listener；callbackAuth、成员配置、回复来源、socket 和 QueueProcessor completion 是显式研究夹具。MessageStore/InvocationQueue/聚合器/完成 hook/flushResult 均运行真实源码。没有真实 provider，也未模拟 QueueProcessor 领取和退休队列，因此原目标仍留在 Queue；只核对汇总是否新增 caller 派发。', steps: [] };
  scenarios.push(routeScenario);
  const routeBody = { targets: routeMembers.slice(1), question: '合成评审题：请分别评价输入与重试。', callbackTo: routeMembers[0], idempotencyKey: 'research-route-flush-group', timeoutMinutes: 3 };
  await recordStep(routeScenario, '调用真实 multi-mention handler', 'registerMultiMentionRoutes POST handler (in-process fixture transport)', routeBody, routeSnapshot,
    async () => {
      let statusCode = 200; let body: any;
      const reply: any = { status: (code: number) => { statusCode = code; return reply; }, code: (code: number) => { statusCode = code; return reply; }, send: (value: any) => { body = value; return value; } };
      await handlers.get('/api/callbacks/multi-mention')({ body: copy(routeBody), log, callbackAuth: {
        catId: routeMembers[0], threadId: routeThread, userId: routeUser, invocationId: turnId,
        ownerAuthProvenance: 'strict', originTriggerMessageId: trigger.id,
      } }, reply);
      assert.equal(statusCode, 200, JSON.stringify(body)); routeRequestId = body.requestId;
      return { statusCode, body };
    }, (_r, _b, a) => { assert.equal(a.aggregate.request.status, 'running'); assert.equal(a.queue.length, 1); assert.deepEqual(a.queue[0].targets, routeMembers.slice(1)); assert.equal(hooks.size, 2); return ['真实 handler 接受请求并注册两个完成 hook', '真实 Queue 保存一个两目标来源行', '未调用模型或真实 HTTP 认证']; });
  const complete = async (catId: string, content: string) => {
    const hook = hooks.get(catId); assert.ok(hook); const value = hook.callback(hook.entryId, 'succeeded', content);
    // flushResult is detached by upstream; one event-loop turn lets its awaited in-memory append finish.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { completionBoundary: 'synthetic QueueProcessor callback', callbackReturn: value };
  };
  await recordStep(routeScenario, '注入第一成员的完成通知', 'upstream registered entryCompleteHook (synthetic completion input)', { target: routeMembers[1], status: 'succeeded', responseText: '合成 B 结果：输入契约合理。' }, routeSnapshot,
    () => complete(routeMembers[1], '合成 B 结果：输入契约合理。'), (_r, _b, a) => { assert.equal(a.aggregate.request.status, 'partial'); assert.equal(a.messages.filter((m: any) => m.source?.connector === 'multi-mention-result').length, 0); return ['真实完成 hook 将组变为 partial', '尚未发表组汇总']; });
  await recordStep(routeScenario, '注入第二完成通知并等待真实 flush', 'upstream entryCompleteHook → settleGroupIfComplete → flushResult', { target: routeMembers[2], status: 'succeeded', responseText: '合成 C 结果：需要限制重试次数。' }, routeSnapshot,
    () => complete(routeMembers[2], '合成 C 结果：需要限制重试次数。'), (_r, b, a) => {
      assert.equal(a.aggregate.request.status, 'done'); const summaries = a.messages.filter((m: any) => m.source?.connector === 'multi-mention-result');
      assert.equal(summaries.length, 1); assert.deepEqual(summaries[0].mentions, []); assert.equal(summaries[0].source.meta.initiator, routeMembers[0]);
      assert.deepEqual(a.queue, b.queue); assert.equal(a.queue.some((row: any) => row.targets.includes(routeMembers[0])), false);
      assert.equal(a.broadcasts.filter((event: any[]) => event[1] === 'connector_message').length, 1); assert.deepEqual(routeErrors, []);
      return ['真实 flush 发表一个 external 汇总消息', 'mentions=[]，callbackTo 只体现为 source.meta.initiator', '汇总阶段没有创建发起者 Queue 行', '已发一次 connector_message 广播；未宣称完整 provider/HTTP 链路实测']; });
  return { scenarios, sources: [
    { path: `${routing}MultiMentionOrchestrator.ts`, line: 43, purpose: '实跑：聚合器真实内存结构、创建、响应、截止与终态' },
    { path: 'packages/shared/src/types/multi-mention.ts', line: 27, purpose: '真实请求、分支响应与聚合结果类型' },
    { path: `${invocation}InvocationQueue.ts`, line: 736, purpose: '实跑：消息与 Queue 准入、幂等重放和通知' },
    { path: `${invocation}queue-ledger/QueueLedger.ts`, line: 79, purpose: '真实 Queue row schema：一来源一行，targets 是待投递集合' },
    { path: `${invocation}queue-ledger/InMemoryQueueLedgerStore.ts`, line: 1, purpose: '实跑：隔离内存账本，未连接 Redis' },
    { path: 'packages/api/src/domains/cats/services/stores/ports/MessageStore.ts', line: 2632, purpose: '实跑：内存消息的 append 与实际存储对象' },
    { path: 'packages/api/src/routes/cross-thread-coordination.ts', line: 134, purpose: '实跑：协调 pure helper，ACK 抑制与新意图重开' },
    { path: 'packages/api/src/routes/callback-multi-mention-routes.ts', line: 561, purpose: '实跑：真实 handler/完成 hook/flush；HTTP 承载、认证与执行完成输入是夹具，未运行 provider' },
    { path: `${invocation}QueueProcessor.ts`, line: 5431, purpose: '静态：多目标并行执行；本研究没有启动真实 QueueProcessor/provider' },
  ] };
}
