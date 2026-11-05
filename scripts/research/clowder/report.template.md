---
type: "research"
status: "frozen"
scope: "{{TRACE_SCOPE}}"
updated: "{{GENERATED_DATE}}"
---

# Clowder AI 协作与球权：真实源码运行及数据流转报告

报告生成日期：{{GENERATED_DATE}}。本文补足[上一版概述]({{ARCHIVE_OVERVIEW_URL}})缺少数据和可复现验证的问题。源记录的实际运行日期见下方，不因重新排版而改变。

{{META}}

这里的“真实”指**直接执行该提交的状态机、服务、内存存储及指定路由代码，记录函数的真实返回值**。用户、消息、执行身份、响应正文及外部事实均为研究测试数据，不是线上聊天记录。快照覆盖各场景追踪的相关记录，不是全库备份。没有调用 Codex/Claude 模型、连接生产 Redis 或验证真实进程退出；没有将上游实现移入我们的产品。以下明确区分源码实跑、受控输入与静态调用链。

完整输入、返回值和前后快照：[trace.json]({{TRACE_URL}})。可复现脚本：[run.mjs]({{RUN_SCRIPT_URL}})。本文代码块从这份运行记录提取，保留原字段和值；部分代码块只选择与当前问题有关的字段，完整对象以 JSON 为准。

JSON 无法直接表达 JavaScript 的 `undefined`，原始记录以 `{"$js":"undefined"}` 表示它；该标记由记录器添加，不是 Clowder 业务字段。不存在的属性仍然省略，与原值为 null 分开。

## 1 先明确数据对象：不存在一个包办所有协作的“球”

| 对象 | 本次实际观察的关键字段 | 决定什么 | 不决定什么 |
| --- | --- | --- | --- |
| 消息 `StoredMessage` | `id/from/threadId/mentions/origin/lifecycle` | 谁发了什么、发给谁、来源是什么 | 不直接改 Task owner |
| 队列 `QueueLedgerEntry` | `id/owner/targets/payload/execution/status/claimId/claimedTargetIds` | 哪些输入需要投递、哪个目标被临时领取 | `claimed` 不等于模型已开始；这里 `owner` 是队列归属用户 |
| 普通任务 `TaskItem` | `ownerCatId/ownerRevision/status/executionRef/lastAppliedHandoffMessageRef` | 工作归属、归属版本、任务状态及精确执行占用 | `done` 不自动代表执行退出 |
| 执行记录 | `invocationId/parentInvocationId/status/providerStartedAt/providerTeardownAt` | 某次成员执行的生命周期 | `canceled` 一项不足以证明 provider 已停 |
| 任务交接请求 | `expected/issuer/targetCatId/targetThreadId/ownerCatId` | 对哪一版责任发起哪一次交接 | `prepare` 的返回不等于已交接 |
| 动作责任 `ActionSuccessorLease` | `key/holderCatIds/generation/revision/status/holderOutcomes/terminalPredicate` | 某对象某动作的持有者、换代、完成证据 | 不能套用于所有普通任务；某些旧入口已退役 |
| 等待状态及注册收据 | `await.generation/ownerFence/baseline/continuation/waitOutcome`；收据另绑来源和 invocation | 哪一代等待可以被哪个结果消费、哪个执行可继续 | 通用等待纯函数支持某形态，不代表当前公开入口仍准入该形态 |
| 球权投影 | `subjectKey/state/holder/heldUntil/lastRejectedEvent` | 如何解释事件、展示当前状态 | 不是全局执行锁，也不是 Task 归属的写入接口 |

因此，需要沿真实关联字段追踪：**消息 ID → 队列来源 → 执行 ID → Task.executionRef → 交接来源**；对特定动作再检查 **leaseId + generation + holder**。不能只按界面上显示的人名判断谁有权限继续写结果。

## 2 主线模拟：Codex 领取任务，再交给 Claude 成员 sonnet

对应运行场景：`task-claim-bind`、`task-handoff-fences`。使用上游内存 `TaskStore/MessageStore/ThreadStore/InMemoryTurnExecutionStore` 与真实 `OrdinaryTaskHandoffService`。认证身份由测试输入提供；callback token 的外层认证未运行。下述 provider teardown 是显式注入的生命周期证据，不是实际启动再杀掉 CLI 的结果。

### 2.1 创建和领取到底改了什么

`TaskStore.create` 创建出的未分配任务如下。`executionRef` 尚未设置，和之后显式写成 `null` 是不同的序列化结果。

{{TASK_INITIAL}}

接着创建 Codex 的真实内存执行记录，并调用 `updateOrdinaryTaskFromCallback(..., data:{status:"doing"})`。返回 `kind="updated"` 后，任务变为：

{{TASK_CLAIMED}}

可见这条路径不只是“把状态设成进行中”：它同时领取 owner、把 `ownerRevision` 从 0 改为 1，并绑定 invocation、parent invocation、会话和来源消息。**仅有相同 catId 不足以替代整个 executionRef。**

### 2.2 准备交接得到一个“预期版本快照”，尚未改 owner

真实 `prepare` 返回：

{{HANDOFF_REQUEST}}

`expected` 冻结当前归属与执行身份；`issuer` 记录谁在发起；`targetCatId/targetThreadId` 决定接收位置；`ownerCatId` 决定交接后的责任人。脚本将该对象放入新消息的 `extra.taskHandoff`，再让 `apply` 读取这条已保存的来源。

实际调用顺序与结果：

{{HANDOFF_FLOW}}

这里有三个容易被语言概括掩盖的差异：

1. `prepare`、保存消息、`apply` 是不同步骤。A 还在执行时，交接来源已经存在，但 owner 仍然是 A。
2. A 的执行 `status=canceled` 后，第二次 `apply` 仍返回 `waiting`。只有注入与旧 invocation 精确匹配的 provider teardown 记录后，下一次 `apply` 才成功。
3. `apply` 成功只移交任务责任并释放旧绑定。直到 `start` 才绑定 B 的新 invocation；这两个动作不是一个不可分割的“传球动画”。

交接落实后、B 尚未开始前的数据：

{{TASK_AFTER_APPLY}}

同一来源重复 `apply` 返回 `replayed`，不会再递增 `ownerRevision`。旧 ownerRevision 的新请求返回 `task_assignment_changed`；A 的旧 callback 不能把 B 正在执行的任务设为 done；A 的迟到 `finish` 也没有清掉 B 的 executionRef。

### 2.3 任务完成与执行释放确实是两次变化

B 明确更新任务为 done 后，实际记录仍然保留 B 的执行引用：

{{TASK_DONE}}

下一步对 B 记录终态并调用 `finish`，`executionRef` 才变为 `null`，`status` 继续是 `done`。所以前端需要分别表达任务状态和执行状态。反过来，单次执行结束也不能据此自动把 Task 设为 done。

### 2.4 跨会话委派：负责人和执行者真实分离

`task-cross-thread-delegation` 先不提供批准锚点，得到 `task_approved_contract_unavailable`；再通过服务的测试依赖注入精确 `(catId, threadId, evidenceRef)` 锚点。**这一步只验证锚点被使用后的交接逻辑，未运行审批创建、审核或审批存储。**

{{CROSS_FLOW}}

委派后调用 `start` 的 Task 实际快照：

{{CROSS_TASK}}

`ownerCatId=codex`、`ownerRevision=0`、Task 的 home `threadId` 均保留；`executionRef.catId=sonnet` 且 executionRef 指向另一个会话。该路径的 `start` 不自动把 todo 改为 doing。本场景之后通过获准子执行的明确 callback 将 home Task 设为 done，而不是把 home owner 换成 sonnet。

这正是原型不应把“当前说话者”“执行者”“任务负责人”画成同一个固定位置的具体依据。

## 3 消息协作：一条消息怎样进入可执行待办

### 3.1 普通多目标消息的数据链

`message-queue` 直接调用真实 `InvocationQueue.send`，后端是上游 `InMemoryQueueLedgerStore`；准入通知回调只记录调用，没有启动 QueueProcessor/provider。

调用输入：

{{QUEUE_INPUT}}

返回的消息与队列行节选：

{{QUEUE_OUTPUT}}

本例是一条 Queue row 内有两个 `targets`，不是“每个成员必定一行”。`payload.messageId/sourceRecordId` 指回来源，`execution.a2aParentInvocationId/a2aTriggerMessageId` 记录派发血缘；`execution.autoExecute=true` 是执行意图，不能把它当作已运行证据。

{{QUEUE_FLOW}}

`markProcessingByIdDurable` 的名字容易让人以为已经进入 processing；本次真实返回是 `status="claimed"`，带 `claimId` 和一个 `claimedTargetIds`。恢复领取后回到 queued。这里没有推进到 provider 执行，不据此推断两个模型的实际启动顺序或并发可靠性。

最后一条普通回复用 `MessageStore.append` 保存，`mentions=[]`，队列不变。这证明 append 本身不创建新执行；它不是完整模型结束链的端到端证明。正式 QueueProcessor 对多目标使用并行策略的结论另由源码调用点支持。

### 3.2 并行汇总的真实对象和终态

`MultiMentionRequest` 与 `MultiMentionResult` 实际包含请求 `id/threadId/initiator/callbackTo/targets/status` 和 `responses[]`。每项分支记录 `catId/content/timestamp/status`。本次直接执行聚合器，正文为合成输入。

{{AGG_FLOW}}

从运行结果可以分出四件不同的事：分支到达、组变成 done、发表汇总消息、再次调用发起者。前两件由聚合器处理，后两件不能从 `callbackTo` 字段自行推导。

截止分支也有实际数据：

{{TIMEOUT_FLOW}}

`handleTimeout` 保留已收到分支，把缺失分支记为 timeout；终态后迟到结果被忽略。创建一个新聚合器实例无法读取之前的请求。这验证了本次使用的内存状态行为，未模拟真正服务器崩溃或跨进程恢复。

汇总发表路径的补充验证：

{{ROUTE_FLOW}}

### 3.3 礼貌确认不必引发无限来回

`message-coordination` 对真实 `resolveCrossThreadCoordination` 输入 `incoming.coordination.phase="terminal"`。无明确新派工时，返回沿用旧 ID 的 `phase="ack"`、`hop+1`、`suppressRouting=true`；显式新工作意图则得到新的 active 协调 ID、`hop=0`、`suppressRouting=false`。这是 helper 层实跑，外层跨会话权限和自然语言意图识别没有在这里运行。

## 4 特定动作责任：真实 lease，而非所有任务的通用“锁”

本节直接执行 ActionSuccessor 的纯状态转换及完成事实 resolver。它**不等于普通 Task 当前正式入口的完整流程**：上一节的普通 Task 已走原生 owner/executionRef 路径；相关旧 task action lease 路径被退役。

单 holder 场景只构造动作身份，没有创建或加载 Task；并行场景向 getter 提供一个非空 `subjectKey` 的受控 Task，以测试该分支的完成事实核验。这不证明合成的 Task 能通过真实 proposal、standing 或 admission，也不能把“非空 subjectKey”理解为入口通行证。

### 4.1 一次动作的身份和持有者

首次 `claimActionSuccessor` 得到的 lease 节选：

{{ACTION_INITIAL}}

`key` 的实际值由 `tenantScope + U+001F + subjectRef + U+001F + actionFamily + U+001F + successorSlot` 组成。`leaseId` 是记录身份；`generation` 用于隔离换人前后的执行；`revision` 是记录修订，不应与 Task.ownerRevision 混为同一个版本号。

{{ACTION_FLOW}}

本次出现的返回值有 `claimed/replayed/replay_mismatch/safe_wait/proof_required/replaced`。它们来自真实函数，不是报告自拟状态。竞争同一动作时不会自动追加第三个 holder；活跃状态不能直接任意换人；记录失败后才进入 replaceable，再换到第二代。

`returnToPredecessor` 的真实结果节选：

{{ACTION_RETURN}}

这次操作是**拒绝当前归属**：holder 变回 Claude，generation 从 2 到 3，原 Researcher 成为 predecessor，`returnDeliveryState=pending`。责任已退回不代表承载返回通知的消息已投递；后续有单独的 delivered 登记。它不是“任务成功后自动回传”的同义词。

### 4.2 并行动作怎样结算

{{PARALLEL_FLOW}}

本例 Task getter 是受控事实端口：先返回 doing，后显式注入 done 和对应 updatedAt。真实 resolver 先返回 `mismatch / task is not done`，后验证精确的 `task:research-parallel:done:2300` 证据。**不是给一句“完成了”就把成功字段设上。**

最终 `holderOutcomes` 同时含 researcher=failed 和 codex=succeeded，而 lease.status=completed。这个模型要求全部 holder 已有终结结果，再看是否至少有一个成功；所以 completed 不能展示成“所有分支全部成功”。此结果只描述该状态机规则，没有验证 Redis 的并发原子提交。

## 5 持球等待：注册身份、代次和结果是不同记录

### 5.1 当前部署等待的注册收据

真实 `createTypedWaitRegistration` 返回：

{{WAIT_RECEIPT}}

{{WAIT_REGISTRATION_FLOW}}

这个收据同时绑定 invocation、来源消息、Task、成员、会话、subject 和 generation，并附 `predicateDigest`。更换 invocation 或让 Task owner 漂移后，`isLiveTypedWaitRegistration` 返回 false。该函数仅给 boolean，不编造不存在的细分拒绝码。这里没有执行部署观测、安装等待的原子写入或实际唤醒。

### 5.2 通用状态机的续代和一次消费

这是另一个独立场景：以源码支持的 PR 形态测试通用 `transitionWaitState`。它用于证明纯函数如何续代、拒绝旧信号，**不证明现有 PR 注册入口仍开放该能力**；当前部署等待场景本身 `autoRenew=false` 且没有 deadline，不能把下面的行为套给部署等待。

第四代匹配、同时安装第五代后的实际 state：

{{WAIT_RENEWED}}

{{WAIT_FLOW}}

关键不是笼统的“收到通知就继续”，而是检查当前 active generation。第四代的 outcome 保留为 `delivery=pending`，第五代已经成为新 await；重复第四代信号返回 `generation_inactive`。第五代在 5001 收到本应匹配的信号，但 deadline 是 5000，因此产出 expired、清除 active await，不继续自动续订。

`delivery=pending` 仍不是“通知已送达模型”。本次只验证状态消费，不宣称整个外部事件链具有 exactly-once 语义。

## 6 球权投影：让事件和权限记录分开检查

`projection-replay` 直接调用 `reduceBallCustodyEvent`。事件与时间是测试输入，未经过事件生产路由或 Redis 日志；该函数不写 Task，也不取消 provider。

{{PROJECTION_FLOW}}

A 的 hold 被 B 的交接覆盖后，`heldUntil` 清空；A 的旧 `fireAt` 到达时，返回 `accepted=false`、state 继续 active、holder 继续 B，同时记录 `lastRejectedEvent`。因此“拒绝状态转换”也不意味着整个 JSON 零变化，审计字段仍会更新。

`retired=true` 的旧 execution disposition 被接受为不改变当前责任的事件；`ball.abandoned` 能使投影 resolved，却没有成功执行的含义。之后 `ball.handed` 还可以重新进入 active。完整事件回放与逐步执行的最终投影 deepEqual 通过。

## 7 对平台设计评审的具体修正

| 旧原型容易表达出的假设 | 本次数据证据 | 应评审的设计行为 |
| --- | --- | --- |
| 一个会话一个永久负责人 | 每个 Task 各有 owner；跨会话的 owner 与 executionRef 成员不同 | 选中任务时展示负责人；成员运行状态独立展示 |
| 发出交接消息就立刻换人执行 | 来源已保存但 apply=waiting；apply 成功后 executionRef 先为空 | 展示“交接待旧执行退出”“责任已交接、执行待开始” |
| canceled 就可以马上启动下一人 | canceled 后仍 waiting，provider teardown 后才 applied | 以精确退出证据解除旧执行占用，保留拒绝原因 |
| done 就代表所有执行与责任都清空 | done 时仍有 executionRef；动作 completed 可含 failed holder | 分别展示任务结论、执行占用和各分支结论 |
| callbackTo 就能自动回唤发起者 | 聚合器中它只是请求字段，汇总发布另有路径 | 若需要稳定回传，明确设计有持久身份的返回待办及接收确认 |
| 界面最后一个 holder 控制整个线程 | reducer 不写 Task；多任务、多目标与执行身份各有自己的记录 | 球权展示标明对象，不能拿线程投影替代写权限 |

这些是根据研究结果提出的产品设计调整，本轮没有据此修改现有原型或业务服务。

## 8 复现、证据范围和后续可验证边界

从项目根目录执行（Node.js 24+，两边仓库依赖需已安装）：

```bash
node scripts/research/clowder/run.mjs /absolute/path/to/clowder-ai-latest
python3 scripts/research/clowder/render-trace.py --trace .local-data/validation/clowder-simulation/trace.json
```

当前机器运行使用 `/Users/ruhonglin/.local/node-v24/bin/node`。runner 先确认上游工作树干净，再用上游 TypeScript 将当前 shared 源码编译进临时目录；全部 shared exports 指向该新产物，API 主体用 tsx 直接导入当前 `.ts`。这样避开共享 barrel 的类型重导出问题，不使用已有旧 dist。临时构建在运行结束后移除。

执行成功后默认生成 `.local-data/validation/clowder-simulation/trace.json`，包括固定提交、运行时间、Node 版本、所有场景输入/输出/快照、通过的核对项、源码引用及引用文件 SHA-256。`VALIDATION_OUTPUT_DIR` 或 runner 的第二个位置参数可指定本机输出目录；渲染器用 `--trace` 明确选择输入，省略时读取本地资料库中已冻结的研究 trace。资料库默认是代码仓同级的 `Multi-Agent-Docs/`，可通过 `MULTI_AGENT_DOCS_DIR` 指定。渲染报告默认也在本机暂存目录，可用 `--output-dir` 指定；选定发布材料后再复制到资料库研究目录并更新索引。runner 核对上游工作树运行前后未变化。时间和部分 ID 由上游生成，重跑会不同，断言验证的是规则与关联关系，不要求字节完全相同。引用文件哈希不冒充全部第三方依赖或完整导入图的审计清单。

本次**没有运行上游全量测试套件，也没有做实际模型/CLI、生产数据、Redis CAS 并发、OS 进程树退出、断电恢复或完整 WebSocket 前端交互测试**。这些边界不能由纯函数和内存测试补证。远端最新 HEAD 本轮未确认，结论绑定上面的固定提交。

### 场景清单

{{SCENARIOS}}

### 固定提交源码索引

下表说明每个引用负责什么；标为静态的调用点不计作该路径实跑。

{{SOURCES}}
