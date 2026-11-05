# Multi Agent Collab

本地多 Agent 持续协作平台。用户在同一会话中直接提问、追问或 @成员，成员结合自己的职责，通过持久投递和工具调用请求其他成员协助。平台保存来源、执行、输入与结果之间的关系，让协作过程可以追踪和核查。

当前产品为 **0.5.0，已实现 N0–N4**：持续协作内核、Codex/Claude Code 接入、自然跟聊、运行契约与输入冻结、执行核查、原投递重验、双 CLI 原生会话延续及可选普通任务交接。正式开发依据见[实施指导](docs/implementation-guide.md)，交付范围、验证依据和后续进度见[实施进度](docs/implementation-progress.md)。

本项目根据独立设计实现。Clowder AI 用于研究业务行为，没有搬迁其源码、Prompt、数据库或品牌素材。

## 设计方式

会话是持续工作的入口。平台不要求用户预先编排固定角色流水线，也不为整个会话设置永久负责人。路由决定交给谁，来源调度决定何时执行，运行时负责实际调用模型。

- **成员与账户分开配置。** 成员保存职责、承载、模型及账户引用；账户保存认证方式与密钥环境变量引用。Codex、Claude Code 不固定代表某个业务岗位。
- **按来源持久调度。** 一条用户消息或 A2A 请求产生一个逻辑来源，按目标成员建立投递。同来源的可执行目标按成组规则领取；存在目标重叠的后续来源不能越序，独立成员的工作可以并行推进。禁用目标形成的 held 投递需要显式重验。
- **成员主动协作。** `collaboration_request` 创建带准确 caller 身份的新来源。普通成功保存结果，不自动叫回调用方；符合准确调用关系的失败产生唯一的失败回报来源。批次的串行/并行模式影响最终文字提及是否触发接力。
- **冻结执行依据。** 领取时保存成员、账户元数据、工作区、策略版本及历史截止点；发送前保存实际平台输入与摘要。后续配置变化不会改写原输入，背景可见也不等于本轮已消费其来源。
- **成员原生会话独立延续。** 会话 × 成员保存代次和准确历史锚点；上一轮成功退出且账户、模型、职责、权限及运行身份兼容时续接，变化或历史不可用时封存重建。公共历史与成员私有原生状态分别维护。
- **任务责任按需建立。** 普通任务保留独立负责人和准确执行绑定；普通 A2A 不改变负责人。正式转交先保存意图，等旧执行的终态和退出证据齐全后再更换负责人并投递，不增加接单步骤。完成需明确操作，不从回复结束推断。
- **根据证据收敛状态。** 入队、输入准备、承载接受、实际退出和结果分别记录。未知结果不会自动重发；核查和取消使用版本检查，迟到成功不能覆盖用户取消。

## 当前架构

应用使用 **React + TypeScript** 工作台和 **Node.js 24** 服务，数据保存在 **SQLite**，通过 **SSE** 向页面推送持久事件。生产模式由同一进程提供静态页面和 API，只监听 `127.0.0.1`，适用于本机单用户。

```mermaid
flowchart LR
  UI["React 工作台"] -->|"HTTP 命令与查询"| HTTP["Node.js HTTP 层"]
  HTTP --> CORE["协作内核<br/>Store 事务与 Engine 调度"]
  CORE --> ROUTE["自然路由"]
  CORE --> CONTEXT["契约快照与输入组装"]
  CORE <--> DB[("SQLite<br/>来源、投递、执行、证据、事件")]
  CORE --> TASK["可选任务与交接<br/>ownerRevision / executionRef"]
  TASK <--> DB
  TASK -->|"释放证据齐全后提交新来源"| CORE
  CORE --> SESSION["会话代次与兼容检查"]
  SESSION <--> DB
  SESSION --> RUNTIME["运行时适配与核查"]
  RUNTIME --> CLI["Codex app-server<br/>Claude Code CLI"]
  RUNTIME --> API["OpenAI-compatible<br/>Anthropic API"]
  RUNTIME -->|"工具回调与执行证据"| CORE
  CORE -->|"持久事件查询"| HTTP
  HTTP -->|"SSE"| UI
```

| 模块 | 实现位置 | 责任 |
| --- | --- | --- |
| 工作台 | [web/CollaborationApp.tsx](web/CollaborationApp.tsx) | 会话、成员/账户、路由提示、输入详情及恢复操作 |
| 服务入口与 API | [server/index.ts](server/index.ts)、[http.ts](server/collaboration/http.ts) | 本地请求校验、CSRF、HTTP/SSE、启动和停止 |
| 路由与上下文 | [routing.ts](server/collaboration/routing.ts)、[context.ts](server/collaboration/context.ts) | 自然跟聊选目标、准确 caller、公开背景与输入预算 |
| 持久协作内核 | [store.ts](server/collaboration/store.ts) | 幂等命令、来源领取、责任关联、冻结输入、终态及恢复事务 |
| 任务责任 | [tasks.ts](server/collaboration/tasks.ts)、[TaskPanel.tsx](web/TaskPanel.tsx) | 任务状态、准确执行授权、等待释放的交接与责任投影 |
| 调度执行 | [engine.ts](server/collaboration/engine.ts) | 在数据库事务外调用承载，处理工具回调、取消与核查结果 |
| 原生连续性 | [continuity.ts](server/collaboration/continuity.ts)、[runtime-session.ts](server/collaboration/runtime-session.ts) | 配置指纹、CLI 身份、准确历史证明；持久绑定由协作 Store 管理 |
| 运行时 | [runtime.ts](server/collaboration/runtime.ts)、[inspection.ts](server/collaboration/inspection.ts) | CLI/API 适配、协议证据与准确执行观察 |
| 数据契约 | [shared/collaboration.ts](shared/collaboration.ts) | 前后端共用的成员、来源、投递、执行、回复与证据类型 |

SQLite 短事务保证命令幂等、来源领取、回复关联和合格失败回报原子提交；模型调用和外部核查在事务外执行。服务租约隔离同一数据目录的运行实例，内存执行表管理本进程调用，持久记录负责恢复与审计。

## 一条消息如何执行

1. 发送事务根据显式提及或合法会话历史，保存 `RoutingDecision → SourceWork → Delivery`。预览只是当前预测，幂等重放返回原来源和原路由。
2. 调度器检查来源顺序、目标占用及 held 规则，创建 `DispatchBatch`。同批次共享历史截止点，每名成员有独立的 `Invocation` 和 `Response`。
3. `Consumption` 将原来源及投递绑定到准确回复，投递退出待处理状态。这证明由哪个回复承接输入，不能单独证明供应商接受或业务完成。
4. 保存 `ExecutionContractSnapshot`、`InputManifest` 和实际平台 prompt，校验摘要及版本后交给运行时。CLI 内部额外上下文不属于平台输入快照的证明范围。
5. 选择并保存原生会话计划，再次验证运行身份。Codex 核对已存轮次，Claude 核对本平台创建的 transcript 祖先链；没有恢复证据时不冒充 resumed。
6. 原生回执、工具调用、使用量和退出证据陆续落库，结果保存到原回复。页面通过 SSE 获取变化，断线后按事件游标补取。

新执行工具为 `workspace_list`、`workspace_read`、`collaboration_request`，以及 `task_list`、`task_create`、`task_update`、`task_handoff`。旧冻结契约保留原工具集合，权限变化会使旧原生会话重建。工作区访问限制在配置目录内，读取工具只读，拒绝越界及软链接逃逸；任意 Shell 和持续协作入口的产物写入审批尚未开放。

## 普通任务如何交接

打开会话的“协作动态”可按需新建任务，或在对话中让成员通过任务工具建立跟踪。负责人、当前执行者与消息目标分别展示；未分配任务不会启动模型。

```mermaid
sequenceDiagram
  participant O as 原负责人执行
  participant T as 任务事务
  participant E as 退出证据
  participant D as 来源调度
  participant N as 新负责人执行
  O->>T: task_handoff（任务/owner 修订、准确回调）
  T-->>O: 保存等待意图与 held 投递
  O->>E: 本轮结束与真实退出
  E->>T: 精确绑定对应的终态 + teardown confirmed
  T->>T: 重验来源/权限/owner 版本
  T->>D: 原子更换 owner，原交接投递改 pending
  D->>N: 领取来源并绑定新 executionRef
  N->>T: task_update done（明确完成）
```

用户可选择停止旧执行后转交，也可撤销尚未应用的交接。停止请求本身不释放执行。`done`、冻结、降级结束或放弃任务跟踪也不能证明进程退出；未知执行继续隔离。责任面板的 dead、void、zombie 仅为可追溯事实的诊断，不能据此自动重发。

## 运行时与认证

运行程序与认证方式是独立配置。通过 CLI 使用 API 密钥时，实际执行仍由对应 CLI 承载。

| 承载 | 执行方式 | 认证 |
| --- | --- | --- |
| Codex app-server | Codex CLI 子进程与原生协议 | 官方 CLI 登录或 API 密钥 |
| Claude Code CLI | Claude CLI 子进程与平台 MCP 工具 | 官方 CLI 登录或 API 密钥 |
| OpenAI-compatible API | 直接 HTTP 调用 Chat Completions 工具协议 | API 密钥 |
| Anthropic API | 直接 HTTP 调用 Messages 工具协议 | API 密钥 |

在“成员与运行时”配置账户、承载和模型。API 账户需填写明确的服务地址、模型及密钥环境变量名，例如 `MY_MODEL_KEY`；密钥值保存在服务端环境或 `.env`，不通过页面输入。CLI 的 API 服务须兼容对应协议：Codex 使用 Responses，Claude Code 使用 Anthropic。协议兼容不代表底层模型来自协议原厂。

原生续接实测组合为 Codex `0.166.0-alpha.5.1` / `deepseek-flash` 与 Claude Code `2.1.220` / `glm-5.3`，使用 API 认证；官方订阅登录的续接尚未实测。工作台显示原生会话链、重建原因和承载报告用量，缺失值显示未知，报告成本不当作账单。

官方登录使用本机 CLI 账户；可通过 `COLLAB_CODEX_PATH`、`COLLAB_CLAUDE_PATH` 指定 CLI 二进制。环境配置示例见 [.env.example](.env.example)。

## 当前边界

- 双 CLI 支持有证据的原生续接；模型未固定、身份不可核验或旧契约执行保守新建。API 直连使用平台公开历史。活动追加仍未实现。
- 执行核查使用本服务进程保留的准确观察。服务重启、缓存丢失或承载无法查询时，明确保留未知，不自动重发。
- 普通任务支持同会话交接；跨会话委托、Action 专用责任与外部条件自动唤醒尚未实现。下一阶段为 N5 产物与评审；附件、私聊、长期记忆及完整多人汇总也属于后续范围。
- `/?legacy=1` 保留早期顺序任务原型。它与持续协作共用服务连接和租约，但使用独立数据表、API 与业务状态，其审批和产物能力不计入持续协作入口。

## 快速启动

需要 Node.js 24。在项目根目录运行：

```bash
npm ci
npm run build
npm start
```

打开[本地工作台](http://127.0.0.1:4310)。直接输入可创建会话，首次使用默认成员；`@claude` 或 `@Claude Code` 可指定成员，后续追问按合法历史延续。真实执行前先配置可用的 CLI 登录或 API 账户。

运行数据默认保存在 `.local-data/`，数据库为 `platform.sqlite`，工作区为 `workspace/`；`.env` 和运行数据不进入 Git。`APP_PORT`、`APP_DATA_DIR`、`APP_WORKSPACE` 可调整端口、数据目录和工作区。

本地后台管理可使用：

```bash
python3 scripts/platform-local.py start
python3 scripts/platform-local.py status
python3 scripts/platform-local.py stop
```

升级前停止服务并备份数据库。运行中的 SQLite 备份应使用 backup API，避免仅复制主文件而遗漏 WAL；保留对应工作区与环境配置。

## 开发与正式文档

```bash
npm run typecheck
npm test
npm run docs:check
```

开发时在两个终端分别执行 `npm run dev` 和 `npm run dev:web`。前端地址为 `http://127.0.0.1:4311`，代理到 4310 后端。

代码仓的 `docs/` 仅维护两份正式文档：

- [实施指导](docs/implementation-guide.md)：已确认可实施的范围、规则及实现约束。
- [实施进度](docs/implementation-progress.md)：已交付内容、验证依据、限制和待确认事项。

完整研究、历史方案、架构图谱、运行材料和发布证据保存在本地同级目录 `../Multi-Agent-Docs/`，不提交到本代码仓。构建、测试和阅读本项目的正式指导不依赖该本地资料库。协作与文档维护约定见 [AGENTS.md](AGENTS.md)。
