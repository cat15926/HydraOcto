# 消息协作运行证据补充

基线 `c238b40ac92277cb8ef6dba2d9fe3d22785d8992`，2026-10-31。只读上游，脚本导入当前源码，不复制实现，不运行 provider、HTTP listener 或 Redis。

## 本脚本真实执行的五个范围

1. `message-aggregate`：上游 `MultiMentionOrchestrator` 的创建、start、相同幂等键重放、partial、重复/非目标忽略、done 与终态迟到忽略。
2. `message-timeout`：真实 `handleTimeout` 转换，直接调用代表截止输入；没有等三分钟定时器。新建另一个聚合器读取旧 ID 失败，只证明内存实例不共享，不冒充服务崩溃恢复测试。
3. `message-queue`：真实 `MessageStore`、`InvocationQueue`、`InMemoryQueueLedgerStore`；准入、一来源多目标、重放、单目标 claim、restore 和独立 append。这里没有跑 QueueProcessor，所以 `claimed` 不是模型已启动。
4. `message-coordination`：真实纯 helper，terminal 无新工作变 ACK/suppressRouting；有显式新工作变 fresh active。该输入表示服务器已经识别出的路由意图，不验证文本解析或 HTTP 权限。
5. `message-route-flush`：直接运行 `registerMultiMentionRoutes` 注册的真实 POST handler，进而运行真实 Queue 准入、注册的完成 hook、settleGroupIfComplete 与 flushResult。HTTP 承载、已认证 callbackAuth、三名测试成员、活动回复来源、完成事件、socket 都是明确夹具；未监听端口、未运行外层 token 校验或 provider。每次完成通过上游注册回调输入合成正文，再等一个 event-loop turn，让 detached flush 的内存 append 完成。

第 5 场景的可复核事实：请求准入一个 Queue 行含 B/C 两目标；第一完成使组 partial，无汇总；第二完成使组 done，保存一个 external 汇总，其 mentions 为空、source.meta.initiator 指向 A，并广播一次 connector_message。汇总前后 Queue 完整对象相同，没有 A 的新派发。**本夹具没有执行 QueueProcessor 的 B/C 领取和退休，因此 B/C 行仍在；不能据此推断真实执行完成后队列仍保留。** 也未覆盖故障注入、重复 completion hook 导致重复 flush、HTTP 延迟、生产恢复。此路径未注入 TaskStore，也没有传 action 元数据；不验证或修改 Task 负责人。普通回复场景只调用 append，未运行普通回复的完整 route/provider completion，因此不能把该局部结论泛化为所有返回协议。

最新统一运行：`node scripts/research/clowder/run.mjs /Users/ruhonglin/lhz/clowder-ai-latest /tmp/clowder-message-route-check`，消息部分 5 场景、23 步通过；整套当次 13 场景、79 步、192 项文字核对通过。运行记录中 void 保留为 JS undefined，由统一 JSON writer 编码为 `{$js:"undefined"}`，不伪装为 null。

## 数据关联（源码行号）

- `packages/shared/src/types/multi-mention.ts:27`：请求字段 `id/threadId/initiator/callbackTo/targets/question/timeoutMinutes/status/createdAt`；响应字段 `catId/content/timestamp/status`；结果是 `{request,responses}`。
- `packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts:43`：请求 Map，`threadId:idempotencyKey` 索引与 `requestId:catId` controller Map 是内存状态，不是 Redis key。
- `packages/api/src/routes/callback-multi-mention-routes.ts:365`：通过幂等键 `message-lifecycle-response:${invocationId}` 查当前 callback 的真实 response source，并检查生命周期/作者/会话。
- 同文件 `:424`：多目标源消息 `from=agent`、`mentions=targets`、`replyTo=当前 response source.id`、`origin=callback`、`idempotencyKey=multi-mention-source:${requestId}`；extra.causal 指向当前 response source。
- `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:736`：真实 `send` 保存消息与 Queue；字段包括 `kind=message_wake`、from、owner、targets、payload 与 execution。当前一条来源一个 Queue row，targets 是尚待投递集合。
- `packages/api/src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.ts:79`：schema v2。`payload.sourceRecordId/messageId` 指来源；`execution.a2aParentInvocationId/a2aTriggerMessageId` 记录调用血缘；`claimId/claimedTargetIds` 是短期领取身份。
- 同文件 `:215`：Queue id 是来源持久 ID 的 SHA-256 前 32 个十六进制字符，加 `queue:` 前缀；它不等于 Redis hash key。
- `packages/api/src/routes/callback-multi-mention-routes.ts:302`：注册真实 Queue completion hook；取消跳过、失败用占位正文记录、正常完成交给 recordResponse。
- 同文件 `:541`、`:561`：done 时真实 flush 把汇总保存为 external，`mentions=[]`，`source.connector=multi-mention-result`、`source.meta.initiator=callbackTo`，向 thread room 广播。
- `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts:5431` 与 `:6570`：生产多目标并行策略、批次结束后调用 completion hooks；本次没有运行 QueueProcessor，这两处仍属静态追踪。
- `packages/api/src/index.ts:1080`：生产 onAdmitted 请求 drain；本次 queue 场景只收集准入通知，route 场景没有接这个生产调度器。

## 持久存储位置（仅静态，不连接 Redis）

`packages/api/src/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-keys.ts` 定义每线程 `queue:{encodeURIComponent(threadId)}:entries`、`:order`、`:messages`、`:schema`、`:private-admissions`；部署的 Redis client keyPrefix 还可能增加外部前缀。Queue entry.id 是 entries 内的字段/行身份，不能与 hash key 混为一谈。

`packages/api/src/domains/cats/services/stores/redis/RedisMessageStore.ts:41` 说明消息 Hash 与全局、用户、mention、thread 时间线索引；本研究实际运行的是上游内存 MessageStore，因此没有写入任何这些 Redis 数据。

## 报告审查

第 3 节原有 Queue/聚合器解释与实跑一致，没有发现重要语义错误。新增 route 场景之后，应将“只静态追踪汇总发表”更新成“真实 handler+flush、受控 transport/auth/completion”，保留未运行 HTTP/provider 的限定；重生成表格以修正先前 void 显示 null 的记录。不能把新增验证称为全栈端到端。
