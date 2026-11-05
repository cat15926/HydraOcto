---
type: "status"
status: "active"
approval: "confirmed"
scope: "正式实施指导的执行进度与当前产品边界"
updated: "2026-11-05"
---

# 持续协作平台实施进度

实施依据为[正式实施指导](implementation-guide.md)。当前交付产品为 0.6.0，bootstrap 标识 `0.6.0-n5`，协作数据库 schema 为 5；N5 已通过 GPT-6.1 Terra 独立复验并升级本地服务。本页是代码仓内唯一持续维护的进度记录；设计与架构概览见[README](../README.md)。

## 已确认实施范围

| 范围 | 状态 | 交付结果 |
| --- | --- | --- |
| 持续协作主干 | 已交付基本链路 | 持久会话、来源级调度、逐目标投递、批次模式、结构化 A2A、合格失败回报、执行接受/退出证据 |
| 双 CLI 与 API 认证 | 已交付接入路径 | Codex app-server 与 Claude Code CLI，运行时/账户/模型分开配置；官方登录与 API 密钥为不同认证方式 |
| N0 基线与版本 | 已交付当前范围 | schema v2 兼容迁移、冻结运行契约、输入/执行/取消修订、逐项覆盖记录 |
| N1 自然协作与输入 | 已交付公开会话范围 | 历史跟聊、服务端路由提示、准确 caller、同伴职责、输入预算/快照与背景责任审计 |
| N2 核查与恢复 | 已交付有证据的核查流程 | 准确实例检查、受限中断恢复、取消保护、held 原投递重验；证据不足保留未知 |
| N3 原生会话延续 | 已交付双 CLI 范围 | 会话 × 成员绑定、兼容指纹、代次封存重建、准确历史锚点、跨服务重启后的成功会话续接、会话链与原生用量 |
| N4 普通任务与正式交接 | 已交付同会话范围 | 可选任务、ownerRevision 与准确执行绑定、显式完成、等待真实退出的交接、撤销与取消隔离、任务工具及工作台责任投影 |
| N5 产物与评审 | 已交付受管本地产物范围 | 不可变版本、准确审批、真实文件回执、固定版本评审及失效、有界问答、原作业核查与唯一完成通知；独立复验通过 |

已交付不表示完整复刻 Clowder：40 项主干中的历史覆盖为 covered 8、partial 15、deferred 7、unsupported 10。NEXT-01–12 已在 N0–N2 公开会话范围建立对应断言；N3/N4 不凭新增测试数量改写原 40 项覆盖账本。85 项产品需求与测试数量不能折算成同一完成率。

## 当前限制与后续方向

| 后续范围 | 当前状态与进入实施的条件 |
| --- | --- |
| N3 后续扩展 | 当前双 CLI 已交付；官方订阅登录续接尚未实测。未固定模型或身份不可核验时新建；API 直连无原生续接，历史格式不支持或超过 16 MB 时不猜测恢复 |
| N4 后续扩展 | 同会话普通任务已交付；跨会话委托、Action 专用责任和外部条件自动唤醒留在 N9。frozen/degraded/abandoned 由用户明确设置，不是通用暂停恢复 |
| N5 后续扩展 | 任意 Shell/工作区写入、外部作业重启恢复与复杂多轮评审未实现；原生问题实际模型自然触发、官方订阅登录和高并发压力仍未验证 |
| N6 调度剩余分支 | 活动追加、targetless、重排、多来源归并、真实多 caller、部分退避与 multi_mention 尚有缺口 |
| N7–N10 产品与扩展 | 完整账户/项目流程、附件、私聊、记忆、跨会话、会话导入及更多承载属于后续规划 |

以上仅记录待办方向，详细草案保存在本地资料库；不因列入进度表就视为可直接执行的新阶段。正式确认可实施的内容再进入实施指导。

当前 inspect 依赖同一服务进程保留的可靠观察缓存；跨重启远端执行查询尚未接通。缓存缺失或身份不足时返回不支持/仍待核查，不自动重发。工作区工具只读；旧 `/?legacy=1` 的任务、审批和产物不计入新持续协作入口完成度。

## 0.6.0 / N5 实施与验收（2026-11-05）

本轮正式规则见实施指导第 11 节。开发自测与 GPT-6.1 Terra 两轮独立验收分开记账；第一轮发现两项缺陷，修复后第二轮通过。实现文件可从 README 的架构表进入。

| 验证类别 | 当前结果 |
| --- | --- |
| 类型与构建 | typecheck、build 通过 |
| 自动化 | 178/178 通过（171 产品 + 7 文档），含新增产物状态、HTTP 与 Codex 原生问答协议测试 |
| 浏览器 | N5 13 项断言、2 次模拟调用通过；N4/N3/N0–N2 共 49 项回归通过。覆盖提问、审批、纯文本预览、发布、评审、旧结论失效、刷新与移动端 |
| 双 CLI 实机 | 2 次真实调用、8 项断言通过：Codex 提议 → 明确审批与实际文件 → Claude 读取准确版本并提交评审。沿用 N4 的 CLI/模型/API 组合；供应商内部请求数未测 |
| GPT-6.1 Terra 独立验收 | 第二轮通过，P1 目录重叠隔离绕过、P2 重启后上级软链接改变写入位置均关闭；178 自动化、13 项 N5 UI、2 次真实 CLI / 8 项断言通过。120 文件前后摘要一致。评审 inputRevision 与原生交互关闭竞态亦通过 |
| 正式服务升级 | schema 4 → 5；29 张原有业务表摘要一致（排除 schema/运行租约/SQLite 内部计数表），保留 4 会话、22 次执行；4310 健康检查通过 |

验证入口：[产物状态测试](../tests/collaboration-artifacts.test.ts)、[HTTP 测试](../tests/collaboration-artifacts-http.test.ts)、[浏览器脚本](../scripts/verify-n5-ui.mjs)、[真实 CLI 脚本](../scripts/verify-n5-live.ts)。临时证据在 `.local-data/validation/n5-*`，不加入 Git；原始选定证据归档至本地资料库 `Multi-Agent-Docs/releases/v0.6.0/evidence/`。第二轮独立报告为 `.local-data/validation/n5-terra/run2/report.md`，冻结摘要 `5fc2eaa0132f606142ccf2e9fee29b0a8c85cf32b447b4150379763dd25dd6e0`。验收后仅更新交付状态文档，业务源码未变。升级备份在 `.local-data/backups/pre-n5-20261105-223831/platform.sqlite`。

当前范围只包括平台私有目录中的 32 KiB 文本产物与本地受管文件作业。CLI 任意命令/工作区文件审批、外部作业重启恢复、附件和复杂多轮评审不计为已交付。Codex 原生 requestUserInput 目前由协议测试证明桥接，实际模型自然触发未计为实机通过；Claude 提问使用平台工具。官方订阅登录不属于本轮实机结论。

## 0.5.0 / N4 验收（2026-11-05）

普通聊天仍可直接发送。需要明确责任时，可在“协作动态 → 新建任务”建立跟踪，或由成员调用任务工具；未分配任务不会自动执行。工作台区分负责人、准确执行者和拟接任成员。没有接单确认阶段，普通 A2A 仍只代表协助。

| 验证类别 | 结果与范围 | 入口 |
| --- | --- | --- |
| 类型与构建 | typecheck、build 通过 | 项目 npm scripts |
| 自动化回归 | 156/156，无跳过；149 项产品测试、7 项文档测试。N4 新增 28 项 | [任务状态与交接测试](../tests/collaboration-tasks.test.ts)、[任务 HTTP/引擎测试](../tests/collaboration-tasks-http.test.ts)及原有回归 |
| 浏览器 | N4 16/16；N3 12/12；N0–N2 21/21；共 12 次模拟调用，无应用异常 | [N4 UI 验证](../scripts/verify-n4-ui.mjs)及已有脚本 |
| 真实 API 双 CLI | 3 次执行、12 项断言通过；Codex 任务 → Claude 普通协助 → Claude 正式接任并显式完成。供应商内部请求数未测 | [N4 实机验证](../scripts/verify-n4-live.ts) |
| 正式库升级 | schema 3 → 4；23 张原有协作表摘要一致，保留 3 会话、11 次执行；没有补造历史任务。4310 健康检查通过 | 本地升级备份与核对记录 |

专项覆盖：准确来源消费与执行 fence、任务/owner 双版本、任务上下文冻结、工具身份防伪、同工具调用跨参数重用拒绝、普通协助不转 owner、交接投递 held 与真实退出分离、旧 owner 迟到回调、源内容与权限失效、任务完成与执行释放分离、事务回滚、重启后的原交接续处理、未知执行隔离，以及准确核查没有独立原始事件时仍可释放任务绑定。

真实验收沿用 API 账户，组合为 Codex `0.166.0-alpha.5.1` / `deepseek-flash`、Claude Code `2.1.220` / `glm-5.3`，在隔离数据库与合成工作区运行。Codex 的 collaboration_request 回执没有改变 owner；task_handoff 回执为 waiting，旧执行仍绑定。持久事件确认先释放原执行，再更新 owner。Claude 的普通 A2A 执行没有任务授权；正式接任执行调用 task_update done 后仍保留 executionRef，直到自身退出才释放。没有额外成功回唤或重复文字接力。

当次正式服务升级为 `0.5.0-n4`。备份位于 `.local-data/backups/pre-n4-20261105-004714/platform.sqlite`；原始材料归档在本地资料库 `Multi-Agent-Docs/releases/v0.5.0/evidence/`。官方订阅登录组合、跨会话交接及真实远端在途作业重启核查不属于本次实机结论。此为 N4 当次交付记录；N5 当前状态见前文与下节。

## 0.4.0 / N3 验收（2026-11-05）

| 验证类别 | 结果与范围 | 入口 |
| --- | --- | --- |
| 类型与构建 | typecheck、build 通过 | 项目 npm scripts |
| 自动化回归 | 128/128，无跳过；包含 7 项文档检查测试，产品测试为 121 项，不改写历史数字 | [连续性状态测试](../tests/collaboration-continuity.test.ts)、[双 CLI 协议测试](../tests/collaboration-continuity-runtime.test.ts)及原有回归 |
| 浏览器 | N3 12/12，3 次模拟调用；N0–N2 回归 21/21，6 次模拟调用；无应用异常 | [N3 UI 验证](../scripts/verify-n3-ui.mjs)、[既有 UI 回归](../scripts/verify-n0-n2-ui.mjs) |
| 真实 API 双 CLI | 4 次真实执行、19 项断言通过，两名成员均 fresh → resumed；实际模型内部请求数未测量 | [N3 实机验证](../scripts/verify-n3-live.ts) |
| 正式服务升级 | schema 2 → 3；原 3 会话、11 执行及关联数据逐行保留，无历史 session 绑定补造；4310 健康检查通过 | 本地升级备份与核对记录 |

原生续接验收固定 Codex `0.166.0-alpha.5.1` / `deepseek-flash`、Claude Code `2.1.220` / `glm-5.3`，沿用 API 账户，在隔离数据库与合成工作区运行。首轮通过 workspace_read 读取随机标记，公共回复不包含标记；关闭验收服务、删除标记文件并重建 Store/运行时后，第二轮在没有工具调用的情况下正确回忆。第二轮平台 prompt 不含该成员的标记，原生身份与上一轮锚点均匹配。

Codex 续接核对 `thread/resume` 与原生末轮；Claude 续接核对准确 assistant UUID、本次输入与 transcript parentUuid 链。工作台展示成员会话链、封存原因和报告用量。Codex 用量范围为最后一次模型请求，Claude 为本次 CLI 执行；缺失成本显示未知，CLI 报告费用不等于供应商账单。

升级前已备份 `.local-data/backups/pre-n3-20261105-000713/platform.sqlite`。本轮原始验收材料归档在本地资料库 `Multi-Agent-Docs/releases/v0.4.0/evidence/`，临时完整验收数据库保留在 `.local-data/validation/n3-live/`。旧资料和证据未改写。后续正式执行按新契约建立绑定，旧执行仍使用各自冻结契约。

## 0.3.0 历史产品验收

以下为 **2026-11-03** 保存的产品验收结果。2026-11-04 的文档整理没有重新执行产品或付费模型验收，也不证明服务此刻的运行状态。

| 验证类别 | 当次结果 | 可定位的实现测试 |
| --- | --- | --- |
| 自动化回归 | 101/101，无跳过；最终背景分类调整后相关 23 项另行通过 | [治理测试](../tests/collaboration-governance.test.ts)、[输入测试](../tests/collaboration-inputs.test.ts)、[HTTP 测试](../tests/collaboration-n0-n2-http.test.ts)等 |
| 浏览器夹具 | 21/21，6 次模拟 runtime 调用，0 应用异常 | [UI 验证脚本](../scripts/verify-n0-n2-ui.mjs) |
| 真实 API 双 CLI | 4 次执行成功，12 项断言通过；供应商内部请求数未测量 | [实机验证脚本](../scripts/verify-n0-n2-live.ts) |
| 旧库升级 | 原 2 会话、7 执行及成员/账户身份完整保留 | [迁移与重启测试](../tests/collaboration-governance.test.ts) |

实机组合为 Codex app-server / `deepseek-flash` 与 Claude Code CLI / `glm-5.3` 的 API 认证；不能据此推断全部模型、官方订阅登录和承载能力都已验证。恢复专项见[核查测试](../tests/collaboration-inspection.test.ts)、[恢复测试](../tests/collaboration-recovery.test.ts)及[租约测试](../tests/lease-recovery.test.ts)。

原始 JSON、日志、截图和详细来源链保存在本地资料库 `Multi-Agent-Docs/releases/v0.3.0/evidence/`。本页保留结论、日期和范围，代码仓无需携带或依赖这些本地附件。

## 进度更新规则

变更已实现范围时同步更新本页及适用指导，列明验证时间与边界；未执行的验证不得记为通过。新测试增加不改写历史 101 项数字，下次真实产品回归另记新结果。文档维护与检查方法见[项目协作约定](../AGENTS.md)。
