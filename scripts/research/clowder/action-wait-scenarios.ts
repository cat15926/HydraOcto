import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Step = { label: string; call: string; input: unknown; before: unknown; result: unknown; after: unknown; checks: string[] };
type Scenario = { id: string; title: string; scope: string; steps: Step[] };
const copy = <T>(value: T): T => structuredClone(value);

/** Research-only: execute upstream source functions, never reproduce their implementation. */
export async function runActionWaitScenarios(upstreamRoot: string) {
  const source = (relative: string) => pathToFileURL(path.join(upstreamRoot, relative)).href;
  const custody = 'packages/api/src/domains/ball-custody/';
  const [action, catalog, truthModule, registration, waits] = await Promise.all([
    import(source(`${custody}action-successor-state-machine.ts`)),
    import(source(`${custody}ActionTerminalPredicateCatalog.ts`)),
    import(source(`${custody}ActionSubjectTruthResolver.ts`)),
    import(source(`${custody}TypedWaitRegistration.ts`)),
    import(source(`${custody}wait-state-machine.ts`)),
  ]);
  const scenarios: Scenario[] = [];
  const record = async (
    scenario: Scenario, label: string, call: string, input: unknown, before: unknown,
    invoke: () => unknown | Promise<unknown>, check: (result: any) => string[],
    after: (result: any) => unknown = (result) => result.lease ?? result.state ?? before,
  ) => {
    const inputSnapshot = copy(input);
    const beforeSnapshot = copy(before);
    const result = await invoke();
    const checks = check(result);
    scenario.steps.push({ label, call, input: inputSnapshot, before: beforeSnapshot, result: copy(result), after: copy(after(result)), checks });
    return result;
  };
  const claimInput = (suffix: string) => {
    const subjectRef = `subject:task:research-${suffix}`;
    return {
      leaseId: `research-lease-${suffix}`, tenantScope: 'research-user', subjectRef,
      actionFamily: 'implement', successorSlot: 'implementer', mode: 'single',
      holderCatIds: ['codex'], dispatchId: `research-dispatch-${suffix}`,
      claimOrigin: 'structured_transfer', holderThreadId: 'research-child',
      predecessorCatId: 'claude', predecessorThreadId: 'research-parent',
      issuerStandingEvidenceRef: `message:research-request-${suffix}`,
      evidenceRefs: [`message:research-request-${suffix}`],
      terminalPredicate: catalog.canonicalizeActionTerminalPredicate({ actionFamily: 'implement', subjectRef, predicate: { kind: 'task_done' } }),
      now: 1000,
    };
  };

  const single: Scenario = {
    id: 'action-single-replacement-return', title: '特定动作：领取、重复、竞争、失败换代与归属退回',
    scope: '直接调用上游纯状态机；输入为虚构、非生产动作。未经过 HTTP、授权 standing、Redis CAS 或真实队列。用于验证同一动作身份的状态转换，不能当作普通 Task 的领取接口。', steps: [],
  };
  scenarios.push(single);
  let lease: any = null;
  const first = claimInput('single');
  lease = (await record(single, 'Claude 把该实现动作交给 Codex', 'claimActionSuccessor', first, lease,
    () => action.claimActionSuccessor(lease, first), (r) => {
      assert.equal(r.outcome, 'claimed'); assert.equal(r.lease.generation, 1); assert.equal(r.lease.status, 'active');
      return ['outcome=claimed', 'generation=1', 'status=active'];
    })).lease;
  await record(single, '相同 dispatch 重放不增加持有者', 'claimActionSuccessor', first, lease,
    () => action.claimActionSuccessor(lease, first), (r) => {
      assert.equal(r.outcome, 'replayed'); assert.deepEqual(r.lease, lease);
      return ['outcome=replayed', 'lease 全字段保持不变'];
    });
  const changedReplay = { ...first, holderCatIds: ['researcher'] };
  await record(single, '同一 dispatch 偷换接收者被拒绝', 'claimActionSuccessor', changedReplay, lease,
    () => action.claimActionSuccessor(lease, changedReplay), (r) => {
      assert.equal(r.outcome, 'replay_mismatch'); assert.deepEqual(r.lease, lease);
      return ['outcome=replay_mismatch', '原持有者仍是 codex'];
    });
  const competing = { ...first, dispatchId: 'research-dispatch-competing', holderCatIds: ['researcher'] };
  await record(single, '另一派发竞争同一动作进入 safe_wait', 'claimActionSuccessor', competing, lease,
    () => action.claimActionSuccessor(lease, competing), (r) => {
      assert.equal(r.outcome, 'safe_wait'); assert.deepEqual(r.lease, lease);
      return ['outcome=safe_wait', '没有增加第二名 holder'];
    });
  const replacement = {
    expectedGeneration: 1, holderCatIds: ['researcher'], holderThreadId: 'research-child',
    predecessorCatId: 'claude', predecessorThreadId: 'research-parent', dispatchId: 'research-replacement',
    terminalPredicate: first.terminalPredicate, evidenceRef: 'message:research-replacement-request', now: 1300,
  };
  await record(single, '动作仍活跃，不能直接换人', 'replaceActionSuccessor', replacement, lease,
    () => action.replaceActionSuccessor(lease, replacement), (r) => {
      assert.equal(r.outcome, 'proof_required'); assert.deepEqual(r.lease, lease);
      return ['outcome=proof_required', 'active generation 不变'];
    });
  const failure = { generation: 1, catId: 'codex', outcome: 'failed', evidenceRef: 'queue:research-single:codex:failed', now: 1400 };
  lease = await record(single, '注入 Codex 执行失败事实', 'recordActionSuccessorOutcome', failure, lease,
    () => action.recordActionSuccessorOutcome(lease, failure), (r) => {
      assert.equal(r.status, 'replaceable'); assert.equal(r.holderOutcomes.codex.outcome, 'failed');
      return ['status=replaceable', 'holderOutcomes.codex.outcome=failed'];
    }, (r) => r);
  lease = (await record(single, '有终态证据后将动作交给 Researcher', 'replaceActionSuccessor', { ...replacement, now: 1500 }, lease,
    () => action.replaceActionSuccessor(lease, { ...replacement, now: 1500 }), (r) => {
      assert.equal(r.outcome, 'replaced'); assert.equal(r.lease.generation, 2); assert.deepEqual(r.lease.holderCatIds, ['researcher']);
      assert.equal(r.lease.replacementTransitions.length, 1);
      return ['outcome=replaced', 'generation=2', 'holderCatIds=[researcher]', '保留 replacementTransitions'];
    })).lease;
  const stale = { generation: 1, subjectTerminal: false, terminalPredicateDigest: lease.terminalPredicate.digest };
  await record(single, 'Codex 第一代迟到执行被 fence 拒绝', 'preflightActionSuccessor', stale, lease,
    () => action.preflightActionSuccessor(lease, stale), (r) => {
      assert.deepEqual(r, { ok: false, reason: 'stale_generation' });
      return ['ok=false', 'reason=stale_generation'];
    }, () => lease);
  const returned = { expectedGeneration: 2, rejectingCatId: 'researcher', rejectingThreadId: 'research-child', dispatchId: 'research-return', groundingEvidenceRef: 'message:research-wrong-owner', now: 1600 };
  lease = (await record(single, 'Researcher 拒绝归属，责任退回前手 Claude', 'returnActionSuccessorToPredecessor', returned, lease,
    () => action.returnActionSuccessorToPredecessor(lease, returned), (r) => {
      assert.equal(r.outcome, 'returned'); assert.equal(r.lease.generation, 3); assert.deepEqual(r.lease.holderCatIds, ['claude']);
      assert.equal(r.lease.returnDeliveryState, 'pending'); assert.equal(r.lease.status, 'active');
      return ['outcome=returned', 'generation=3', 'holder=claude', 'returnDeliveryState=pending', '责任活跃，尚非完成'];
    })).lease;
  const ack = { expectedGeneration: 3, evidenceRef: 'invocation:research-return-consumer', now: 1700 };
  lease = (await record(single, '注入返回投递完成事实，独立更新运输记录', 'markActionSuccessorReturnDelivered', ack, lease,
    () => action.markActionSuccessorReturnDelivered(lease, ack), (r) => {
      assert.equal(r.outcome, 'delivered'); assert.equal(r.lease.returnDeliveryState, 'delivered');
      assert.deepEqual(r.lease.holderCatIds, ['claude']); assert.equal(r.lease.generation, 3);
      return ['投递状态变为 delivered', '投递确认没有再次改变 holder/generation'];
    })).lease;

  const parallel: Scenario = {
    id: 'action-parallel-evidence', title: '并行动作：一员失败、一员经事实核验完成',
    scope: '执行真实 ActionSuccessor 状态机和 ActionSubjectTruthResolver.resolveCompletion。Task 事实由内存测试端口注入，更新 Task.done 是显式外部 fixture 事件；未执行生产 Task 完成写入、Approval Hub、Redis 事务或模型。', steps: [],
  };
  scenarios.push(parallel);
  let parallelLease: any = null;
  let task: any = { id: 'research-parallel', kind: 'work', subjectKey: 'research:controlled-action:parallel', title: '受控动作测试', status: 'doing', ownerCatId: 'claude', threadId: 'research-parent', userId: 'research-user', updatedAt: 2000 };
  const forbiddenPort = async () => { throw new Error('本场景不允许读写终态标记端口'); };
  const resolver = new truthModule.ActionSubjectTruthResolver(
    { getSubjectTerminal: forbiddenPort, markSubjectTerminal: forbiddenPort, clearSubjectTerminal: forbiddenPort },
    { get: async (id: string) => id === task.id ? copy(task) : null },
  );
  const parallelInput = { ...claimInput('parallel'), mode: 'parallel', holderCatIds: ['codex', 'researcher'], parallelIntent: '独立核验同一受控任务的不同方面', now: 2000 };
  parallelLease = (await record(parallel, '显式建立两个持有者', 'claimActionSuccessor', parallelInput, null,
    () => action.claimActionSuccessor(null, parallelInput), (r) => {
      assert.equal(r.outcome, 'claimed'); assert.equal(r.lease.holderCatIds.length, 2);
      return ['mode=parallel', '两个唯一 holder'];
    })).lease;
  const peerFailure = { generation: 1, catId: 'researcher', outcome: 'failed', evidenceRef: 'queue:research-parallel:researcher:failed', now: 2100 };
  parallelLease = await record(parallel, '注入 Researcher 失败事实，Codex 仍持有自己的分支', 'recordActionSuccessorOutcome', peerFailure, parallelLease,
    () => action.recordActionSuccessorOutcome(parallelLease, peerFailure), (r) => {
      assert.equal(r.status, 'active'); assert.equal(r.holderOutcomes.researcher.outcome, 'failed'); assert.equal(r.holderOutcomes.codex, undefined);
      return ['status 仍为 active', '失败仅记录在 researcher holder 下'];
    }, (r) => r);
  const lateCancel = { ...peerFailure, outcome: 'canceled', evidenceRef: 'queue:research-parallel:late-cleanup', now: 2200 };
  await record(parallel, '迟到清理不能把首次 failed 改成 canceled', 'recordActionSuccessorOutcome', lateCancel, parallelLease,
    () => action.recordActionSuccessorOutcome(parallelLease, lateCancel), (r) => {
      assert.deepEqual(r, parallelLease); return ['首个 terminal observation 胜出', 'lease 全字段未变'];
    }, (r) => r);
  const evidence = { generation: 1, catId: 'codex', evidenceRefs: ['task:research-parallel:done:2300'], now: 2250 };
  parallelLease = await record(parallel, 'Codex 提交精确任务完成证据引用', 'recordActionCompletionCandidate', evidence, parallelLease,
    () => action.recordActionCompletionCandidate(parallelLease, evidence), (r) => {
      assert.equal(r.completionCandidates.codex.candidateRevision, 1); assert.equal(r.status, 'active');
      return ['保存 candidateRevision=1 和 evidenceDigest', '提交证据不自动变成 succeeded'];
    }, (r) => r);
  await record(parallel, '引用存在但 Task 尚未完成，真实 resolver 拒绝', 'ActionSubjectTruthResolver.resolveCompletion',
    { predicate: parallelLease.terminalPredicate, candidate: parallelLease.completionCandidates.codex, injectedTask: task }, parallelLease,
    () => resolver.resolveCompletion(parallelLease.terminalPredicate, parallelLease.completionCandidates.codex), (r) => {
      assert.equal(r.status, 'mismatch'); assert.equal(r.reason, 'task is not done');
      return ['status=mismatch', 'reason=task is not done'];
    }, () => parallelLease);
  const oldTask = copy(task);
  await record(parallel, '受控测试事件：Task 事实变为 done', 'fixture.updateTask（外部事实注入，不是上游写接口）',
    { status: 'done', updatedAt: 2300 }, oldTask,
    () => { task = { ...task, status: 'done', updatedAt: 2300 }; return copy(task); }, (r) => {
      assert.equal(r.status, 'done'); assert.equal(r.updatedAt, 2300); return ['仅更改内存注入的 Task 事实'];
    }, (r) => r);
  const verdict = await record(parallel, '真实 resolver 验证精确 done 证据', 'ActionSubjectTruthResolver.resolveCompletion',
    { predicate: parallelLease.terminalPredicate, candidate: parallelLease.completionCandidates.codex, injectedTask: task }, parallelLease,
    () => resolver.resolveCompletion(parallelLease.terminalPredicate, parallelLease.completionCandidates.codex), (r) => {
      assert.equal(r.status, 'verified'); assert.equal(r.evidenceRef, 'task:research-parallel:done:2300');
      assert.equal(r.candidateRevision, 1); return ['status=verified', '证据绑定当前 candidateRevision/evidenceDigest'];
    }, () => parallelLease);
  const commit = { generation: 1, catId: 'codex', verdict, now: 2400 };
  parallelLease = await record(parallel, '提交 verified verdict，两个 holder 都已终结', 'commitActionCompletionVerdict', commit, parallelLease,
    () => action.commitActionCompletionVerdict(parallelLease, commit), (r) => {
      assert.equal(r.status, 'completed'); assert.equal(r.holderOutcomes.codex.outcome, 'succeeded'); assert.equal(r.holderOutcomes.researcher.outcome, 'failed');
      return ['status=completed', 'codex=succeeded + researcher=failed', 'completed 不表示所有分支成功'];
    }, (r) => r);

  const typed: Scenario = {
    id: 'typed-deployment-registration', title: '当前 typed wait：精确注册、来源与 owner 约束',
    scope: '直接调用当前部署等待注册及 live predicate 源码；Task 和 deployment await 是受控输入。未执行注册 HTTP、TaskStore 原子安装、部署观测或唤醒投递。部署等待 autoRenew=false 且无 deadline，与下一场景通用 wait 状态机分开。', steps: [],
  };
  scenarios.push(typed);
  const active = { v: 1, generation: 1, subjectRef: 'deployment:research:runtime', ownerFence: { kind: 'containing_task', generation: 1 }, baseline: { bootSequence: 10, bootId: 'research-boot-10', capturedAt: 3000 }, continuation: { when: [{ kind: 'new_ready_boot', services: ['api'] }], then: '检查新部署的 API readiness' }, createdAt: 3000, autoRenew: false };
  const waitTask = { id: 'research-deployment-task', kind: 'work', status: 'doing', title: '等待 API 新启动', subjectKey: null, ownerCatId: 'codex', threadId: 'research-thread', userId: 'research-user', deploymentWait: { await: active } };
  const registerInput = { task: waitTask, active, invocationId: 'research-invocation-1', source: { kind: 'primary', sourceMessageId: 'research-deployment-source' } };
  const receipt = await record(typed, '为当前部署等待生成真实注册收据', 'createTypedWaitRegistration', registerInput, { task: waitTask, receipt: null },
    () => registration.createTypedWaitRegistration(registerInput), (r) => {
      assert.ok(r); assert.equal(r.proofKind, 'deployment_predicate'); assert.equal(r.generation, 1); assert.equal(r.expiresAt, undefined);
      return ['proofKind=deployment_predicate', 'generation=1', '无 expiresAt'];
    }, (r) => ({ task: waitTask, receipt: r }));
  const snapshot = { task: waitTask, receipt };
  const identity = { invocationId: 'research-invocation-1', userId: 'research-user', catId: 'codex', threadId: 'research-thread', sourceMessageId: 'research-deployment-source' };
  await record(typed, '同一来源、轮次、持有者获得 live continuation', 'isLiveTypedWaitRegistration', { identity, now: 3100 }, snapshot,
    () => registration.isLiveTypedWaitRegistration(snapshot, identity, 3100), (r) => {
      assert.equal(r, true); return ['live=true'];
    }, () => snapshot);
  const foreignIdentity = { ...identity, invocationId: 'research-invocation-unrelated' };
  await record(typed, '无关轮次不能借用这个等待收据', 'isLiveTypedWaitRegistration', { identity: foreignIdentity, now: 3101 }, snapshot,
    () => registration.isLiveTypedWaitRegistration(snapshot, foreignIdentity, 3101), (r) => {
      assert.equal(r, false); return ['live=false；该函数仅返回 boolean，无 typed 拒绝原因'];
    }, () => snapshot);
  const ownerChanged = copy(snapshot); ownerChanged.task.ownerCatId = 'claude';
  await record(typed, '受控 owner 漂移后，旧收据失去 live authority', 'isLiveTypedWaitRegistration', { identity, now: 3200, injectedOwnerChange: 'claude' }, ownerChanged,
    () => registration.isLiveTypedWaitRegistration(ownerChanged, identity, 3200), (r) => {
      assert.equal(r, false); return ['live=false', '旧 codex 收据不授权新 owner'];
    }, () => ownerChanged);

  const waitScenario: Scenario = {
    id: 'wait-generation-renewal-expiry', title: '通用 wait 状态机：续代、旧信号、超时与一次消费',
    scope: '直接执行 wait-state-machine.ts 的纯状态转换。采用该状态机支持的 GitHub 样式受控输入；这是状态机行为研究，不宣称历史 GitHub 注册入口仍提供当前 live continuation authority，亦不运行外部轮询。', steps: [],
  };
  scenarios.push(waitScenario);
  let waitState: any = { await: { v: 1, generation: 4, subjectRef: 'pr:research/example#7', ownerFence: { kind: 'containing_task', generation: 4 }, baseline: { capturedAt: 4000, headSha: 'a'.repeat(40) }, continuation: { when: [{ kind: 'pr_head_changed' }], then: '重新审阅精确的新 HEAD' }, expiresAt: 5000, createdAt: 4000 } };
  const matched = { type: 'predicates_matched', generation: 4, at: 4500, matched: [{ kind: 'pr_head_changed', delta: 'HEAD A -> B' }], renewal: { kind: 'renew', baseline: { capturedAt: 4500, headSha: 'b'.repeat(40) } } };
  waitState = (await record(waitScenario, '匹配第四代，在同次转换安装第五代', 'transitionWaitState', matched, waitState,
    () => waits.transitionWaitState(waitState, matched), (r) => {
      assert.equal(r.applied, true); assert.equal(r.state.waitOutcome.generation, 4); assert.equal(r.state.waitOutcome.renewal, 'rearmed');
      assert.equal(r.state.await.generation, 5); assert.equal(r.state.await.expiresAt, 5000);
      return ['第四代 outcome=matched/renewal=rearmed', 'await.generation=5', '原 deadline=5000 不会无限延长'];
    })).state;
  const oldSignal = { ...matched, at: 4501 };
  await record(waitScenario, '第四代重复信号不能消费第五代', 'transitionWaitState', oldSignal, waitState,
    () => waits.transitionWaitState(waitState, oldSignal), (r) => {
      assert.equal(r.applied, false); assert.equal(r.reason, 'generation_inactive'); assert.deepEqual(r.state, waitState);
      return ['applied=false', 'reason=generation_inactive'];
    });
  const lateMatch = { ...matched, generation: 5, at: 5001 };
  waitState = (await record(waitScenario, '第五代截止后的匹配成为过期通知，不再续订', 'transitionWaitState', lateMatch, waitState,
    () => waits.transitionWaitState(waitState, lateMatch), (r) => {
      assert.equal(r.applied, true); assert.equal(r.state.await, undefined); assert.equal(r.state.waitOutcome.reason, 'expired'); assert.equal(r.state.waitOutcome.delivery, 'pending');
      return ['await 被移除', 'reason=expired', 'delivery=pending；过期并非静默丢弃'];
    })).state;
  await record(waitScenario, '终结后重复通知不能再次消费', 'transitionWaitState', { ...lateMatch, at: 5002 }, waitState,
    () => waits.transitionWaitState(waitState, { ...lateMatch, at: 5002 }), (r) => {
      assert.equal(r.applied, false); assert.equal(r.reason, 'generation_inactive'); assert.deepEqual(r.state, waitState);
      return ['applied=false', '已保存的 expired outcome 未被改写'];
    });

  return { scenarios: copy(scenarios), sources: [
    { path: `${custody}action-successor-state-machine.ts`, line: 284, purpose: 'claim、replay、safe_wait；preflight 在334行' },
    { path: `${custody}action-successor-outcome-state-machine.ts`, line: 24, purpose: 'holder outcome 与并行终态收敛' },
    { path: `${custody}action-successor-replacement-state-machine.ts`, line: 143, purpose: '只在 replaceable 或返回重接特例换代' },
    { path: `${custody}action-successor-return-state-machine.ts`, line: 81, purpose: '归属拒绝后退回前手及运输状态' },
    { path: `${custody}ActionSubjectTruthResolver.ts`, line: 118, purpose: '真实服务端 Task.done 完成事实核验' },
    { path: `${custody}action-successor-completion-state-machine.ts`, line: 107, purpose: '证据快照与冻结 predicate 的提交校验' },
    { path: `${custody}TypedWaitRegistration.ts`, line: 154, purpose: '当前 deployment 收据及185行live authority校验' },
    { path: `${custody}wait-state-machine.ts`, line: 214, purpose: '代次、匹配、续订、截止与终结转换' },
  ] };
}
