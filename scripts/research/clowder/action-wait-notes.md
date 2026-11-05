# ActionSuccessor 与 typed wait 源码模拟说明

研究日期：2026-10-31（Asia/Shanghai）。固定源码提交：`c238b40ac92277cb8ef6dba2d9fe3d22785d8992`。没有验证远端最新 HEAD。

入口为 `action-wait-scenarios.ts` 导出的 `runActionWaitScenarios(upstreamRoot)`，不复制上游状态机实现。每步的 `input/before/result/after` 都使用 `structuredClone` 保存；每项结果由 Node `assert` 实际核对，失败会使整次研究运行失败。

统一 `run.mjs` 已运行本模块：**4 个场景、26 步、59 个描述性核对项全部通过**。核对项数不是 `assert` 调用次数。对应 trace 完成时间 `2026-10-30T16:45:56.156Z`，即北京时间 2026-10-31 00:45:56。源码运行前后均干净。复现请使用统一 runner：

```sh
/Users/ruhonglin/.local/node-v24/bin/node scripts/research/clowder/run.mjs
```

API 模块由 tsx 直接导入 `src/*.ts`。shared 源码 barrel 含非 `type` 形式的类型重导出，直接用 tsx alias 会报缺少 `ApprovalFeatureId` 导出；统一 runner 使用上游 TypeScript 编译**当前 shared 源码**到临时目录，再为每个 shared export 配置路径。没有把旧 `dist` 当作本次验证对象，也不改上游源码。

## 场景与真实返回

| 场景 | 步数 | 执行对象和关键返回 |
| --- | --- | --- |
| `action-single-replacement-return` | 10 | claim → `claimed`；同派发重放 → `replayed`；重放偷换 holder → `replay_mismatch`；不同派发竞争 → `safe_wait`；active 直接换人 → `proof_required`；failed → `replaceable`；replace → `replaced/generation=2`；旧代次 preflight → `stale_generation`；拒绝归属 → `returned/generation=3`；返回运输登记 → `delivered` |
| `action-parallel-evidence` | 8 | 显式两名 holder；一人 failed 后 lease 仍 active；迟到 canceled 不覆盖首个 failed；记录 candidate 后仍 active；真实 resolver 返回 `mismatch / task is not done`；注入 Task.done 后返回 `verified`；最终 `completed` 同时包含一名 succeeded 和一名 failed |
| `typed-deployment-registration` | 4 | 当前注册函数生成 `proofKind=deployment_predicate` 收据；精确身份检查为 true；错误 invocation 为 false；Task owner 漂移后旧收据为 false |
| `wait-generation-renewal-expiry` | 4 | generation 4 matched 并安装 generation 5；旧信号 → `generation_inactive`；过期后的匹配 → `expired/delivery=pending`，清除 await；重复通知再次 → `generation_inactive` |

## 字段含义与注入边界

`ActionSuccessor.key` 是租户、subjectRef、actionFamily、successorSlot 拼接的身份；本例具体为 `implement/implementer/task_done`。`generation` 隔离换代，`revision` 是记录修订。它们不等于普通 Task 的 `ownerRevision`。

单人链直接调用纯状态机，没有创建或读取 Task，未执行 `ActionSuccessorAdmissionService` 的 standing、subject 当前事实、批准委派或 freshness 检查。`recordActionSuccessorOutcome` 的 failed、`markActionSuccessorReturnDelivered` 的已投递都是研究者注入的受控观测：验证其消费后的状态变化，不声称发生了真实 provider 故障或消息运输。

并行链额外调用真实 `ActionSubjectTruthResolver.resolveCompletion`，只替换其 Task getter 依赖为内存事实端口。getter 使用 `kind=work, subjectKey=research:controlled-action:parallel`，而不是普通 Task 的 `subjectKey=null`。这是为了隔离研究该动作协议的事实核验规则，**非空 subjectKey 不是正式入口的通行证**；本次没有验证该合成 Task 能通过真实创建、proposal、standing 或 action admission。

普通 implement Task 判定在 `TaskStoreContract.ts:38`：`kind=work && subjectKey===null && entrustedWork===undefined`。这种 Task 的当前流程是原生 owner/executionRef 交接；`ActionSubjectTruthResolver.resolveCompletion` 会拒绝它，返回 `ordinary Task has no lease completion contract`。本模块不代替普通 Task 活链验证。

并行链中的 `fixture.updateTask` 明确不是上游接口：先提供 doing，再把受控 getter 事实变为 done、updatedAt=2300。真实 resolver 此后验证 `task:research-parallel:done:2300`，并绑定 candidateRevision/evidenceDigest。随后调用上游纯提交函数；未运行 production Task 写入或 Redis 的并发 CAS。

部署等待调用的是当前 `createTypedWaitRegistration` 与 `isLiveTypedWaitRegistration`。输入 Task/await 是受控对象；没有执行 Host 注册 HTTP、TaskStore 原子安装或部署观测。`isLiveTypedWaitRegistration` 只返回 boolean，不编造细分拒绝码。收据绑定 invocation/sourceMessageId/taskId/catId/threadId/subjectRef/generation/predicateDigest；此处 autoRenew=false 且无 expiresAt。

通用 wait 场景使用 PR 形态的独立输入来执行 `transitionWaitState`，没有拿 PR 的历史 schema 证明当前 PR 注册入口仍开放 live continuation authority。续代是纯函数同次转换，不代表我们验证了持久写入原子性；`delivery=pending` 不代表消息已入队或模型已消费。

## 源码锚点

以下均为固定提交下的上游路径：

| 路径 | 行号 | 本次关联行为 |
| --- | --- | --- |
| `packages/api/src/domains/ball-custody/action-successor-state-machine.ts` | 284、334 | claim / replay / safe_wait / preflight |
| `packages/api/src/domains/ball-custody/action-successor-outcome-state-machine.ts` | 24 | holder 首个终态及并行收敛 |
| `packages/api/src/domains/ball-custody/action-successor-replacement-state-machine.ts` | 143 | replaceable 与 returned reattach 特例；无任意 active 换人 |
| `packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts` | 81、319 | 拒绝归属退回前手、独立运输登记 |
| `packages/api/src/domains/ball-custody/ActionSubjectTruthResolver.ts` | 118 | 真实完成事实 resolver，普通 Task 被拒绝 |
| `packages/api/src/domains/ball-custody/action-successor-completion-state-machine.ts` | 107 | candidate 与 frozen predicate 的精确提交 |
| `packages/api/src/domains/ball-custody/TypedWaitRegistration.ts` | 154、185 | 当前 deployment 注册及 live 检查 |
| `packages/api/src/domains/ball-custody/wait-state-machine.ts` | 214 | 代次、续订、截止与重复信号 |

本次未验证 Redis 事务竞争、API 重启恢复、真实外部命令、模型续跑、真实 CLI 会话、投递 exactly-once 或操作系统进程退出。这些不从纯状态机成功推导。
