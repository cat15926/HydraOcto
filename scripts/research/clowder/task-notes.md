# 普通 Task 研究夹具说明

本脚本只编排合成输入和断言，动态导入独立上游 checkout 的 `src/*.ts`，不重写其业务状态机。统一运行入口为 `run.mjs`；它使用本项目 tsx 加载 API 源码，并将当前 shared 源码用上游 tsc 编译到临时目录，避免纯类型 barrel 重导出与 tsx 的不兼容。不读取已有 API/shared dist 作为被测主体。

## 实跑层与边界

- 使用上游 `TaskStore`、`MessageStore`、`ThreadStore` 和 `InMemoryTurnExecutionStore` 的内存实现。
- 实跑 `OrdinaryTaskHandoffService.prepare/apply/start/finish` 与 `updateOrdinaryTaskFromCallback`。
- 用户/成员/invocation 身份是夹具提供；外层 HTTP callback token 校验不运行，写入 fence 是空实现。
- turn 的 started/canceled/teardown 事实由夹具主动注入；没有启动 CLI 或验证进程退出。
- 跨会话批准锚点由依赖注入提供，只验证 service 如何消费该锚点，不验证审批生成与 ProposalStore。
- 未运行 QueueProcessor、Redis CAS 并发、真实模型、重启恢复或 WebSocket。`task-handoff-fences` 接续 `task-claim-bind` 的同一个任务，跨会话场景另起独立任务。

每步的 before/after 采用 `structuredClone`。多调用步骤的 result 用对象分别收集各真实返回；该收集对象是研究记录格式，不是某个上游统一 API。真实 `void` 返回保留 `undefined`，由统一记录器编码为 `{"$js":"undefined"}`。

## 观察到的主要数据变化

1. 创建普通任务时 `ownerCatId=null`、`ownerRevision=0`、`status=todo`，`executionRef` 未设置。
2. `createRunning` 只创建执行记录，不绑定任务。有效 callback 更新为 `doing` 才同时领取 owner、把 revision 改为 1，并绑定 invocation/parentInvocation/cat/thread/sourceMessage 五个坐标。
3. `prepare` 返回预期责任快照；保存 `extra.taskHandoff` 来源后，任务仍不变。旧执行未释放时 `apply` 返回 waiting。
4. 仅将旧 turn 标为 canceled，`apply` 仍 waiting。注入精确 teardown 后，`apply` 才释放旧 executionRef、把 owner 改为 sonnet、revision 改为 2，并保存来源引用。
5. 重放同一交接返回 replayed，不再加 revision。`start` 单独绑定新执行；这不是与 owner 变化同一个不可分割动作。
6. 旧 revision 的新请求抛出 `task_assignment_changed`；旧 callback 返回 refused；旧 invocation 的 finish 不释放新 invocation。
7. 当前执行显式更新 Task 为 done 时，executionRef 仍保留。随后注入终态和 teardown，调用 finish，才清除 executionRef，owner 与 done 保留。
8. 跨会话无获准锚点时拒绝；获准后 home thread、owner codex、revision 0 保留，executionRef 指向子会话 sonnet。该 `start` 不自动将 todo 改为 doing；精确获准子执行能够显式完成 home Task。

## 上游类型与实现锚点

路径均相对上游根目录，固定基线由统一 trace 记录。

| 路径与行号 | 用途 |
| --- | --- |
| `packages/shared/src/types/task.ts:192` | TaskExecutionRef；随后为 TaskItem |
| `packages/api/src/domains/ball-custody/OrdinaryTaskHandoffContract.ts:6` | expected、issuer、target、owner、stopPrevious 与结果分支 |
| `packages/api/src/domains/cats/services/stores/ports/TaskItemFactory.ts:6` | 创建默认字段 |
| `packages/api/src/domains/cats/services/stores/ports/OrdinaryTaskMutation.ts:207` | 未分配领取与 executionRef 绑定 |
| `packages/api/src/domains/cats/services/stores/ports/OrdinaryTaskMutation.ts:261` | owner、revision、交接来源条件更新 |
| `packages/api/src/domains/ball-custody/OrdinaryTaskHandoffService.ts:45` | 准备与落实交接 |
| `packages/api/src/domains/ball-custody/OrdinaryTaskHandoffService.ts:214` | 精确旧执行释放门槛 |
| `packages/api/src/domains/ball-custody/OrdinaryTaskHandoffService.ts:261` | 新执行绑定与旧 finish 的防护 |
| `packages/api/src/domains/ball-custody/OrdinaryTaskHandoffAuthority.ts:19` | 同用户、同项目与获准子会话锚点 |
| `packages/api/src/routes/callback-ordinary-task-update.ts:13` | 来源、版本和调用身份检查 |

## 复现

从本项目根目录使用 Node.js 24 或以上执行：

```bash
node scripts/research/clowder/run.mjs /absolute/path/to/clowder-ai-latest
```

普通 Task 套件有 3 个场景、21 个记录步骤。断言在实际执行时验证，不由这些说明文字代替；每次最终结果与时间以新生成的 trace 为准。
