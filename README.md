# Multi Agent Collab

本地多 Agent 持续协作平台。用户在同一会话中直接提问、追问或 @成员，成员结合自己的职责，通过持久投递和工具调用请求其他成员协助。平台保存来源、执行、输入与结果之间的关系，让协作过程可以追踪和核查。

当前产品为 **0.8.0，已交付 N0–N7 的当前范围**：持续协作内核、Codex/Claude Code 接入、运行契约与输入冻结、执行核查、原生会话延续、可选任务交接、版本化产物审批、固定版本评审，以及来源排序、多来源消费、精确 Codex 活动追加与多人征询，以及会话整理、文本附件、项目授权和成员账户管理。N7 已通过 GPT-6.1 Terra 独立验收及补验，已升级本地服务。正式规则见[实施指导](docs/implementation-guide.md)，验证范围与后续进度见[实施进度](docs/implementation-progress.md)。

N7 已验证 223 项自动化、97 项浏览器断言和双 CLI API 纯附件实机链路；官方订阅模式推理仍未验证，具体限制见实施进度。

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
  HTTP --> WORKBENCH["会话整理 / 附件与引用 / 工作区授权 / 配置版本"]
  WORKBENCH <--> DB
  WORKBENCH --> DISCOVERY["只读账户与模型目录探测"]
  HTTP --> CORE["协作内核<br/>Store 事务与 Engine 调度"]
  CORE --> ROUTE["自然路由"]
  CORE <--> COOP["来源排位 / 输入归并 / 精确追加 / 多人征询"]
  COOP <--> DB
  CORE --> CONTEXT["契约快照与输入组装"]
  CORE <--> DB[("SQLite<br/>来源、投递、执行、证据、事件")]
  CORE --> TASK["可选任务与交接<br/>ownerRevision / executionRef"]
  TASK <--> DB
  TASK -->|"释放证据齐全后提交新来源"| CORE
  CORE --> SESSION["会话代次与兼容检查"]
  CORE <--> ARTIFACT["版本化产物、审批与固定材料评审"]
  ARTIFACT <--> DB
  ARTIFACT --> JOB["受管写入作业 / 准确文件回执"]
  JOB --> FILES["私有产物目录 / 不覆盖版本对象"]
  CORE <--> QUESTION["绑定执行的用户提问"]
  QUESTION <--> DB
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
| 产物与交互 | [artifacts.ts](server/collaboration/artifacts.ts)、[artifact-files.ts](server/collaboration/artifact-files.ts)、[interactions.ts](server/collaboration/interactions.ts)、[ArtifactPanel.tsx](web/ArtifactPanel.tsx) | 精确审批、不可变文件、评审失效、原作业核查与有界提问 |
| N7 工作台与配置 | [workbench.ts](server/collaboration/workbench.ts)、[account-discovery.ts](server/collaboration/account-discovery.ts)、[WorkbenchPanel.tsx](web/WorkbenchPanel.tsx) | 附件正文和来源摘要、授权目录身份、成员账户 CRUD、默认配置 CAS、目录/身份/额度分离 |
| N6 协作分支 | [cooperation.ts](server/collaboration/cooperation.ts)、[CooperationPanel.tsx](web/CooperationPanel.tsx) | 来源排序、抑制/退避、准确多来源消费、追加交付状态和多人征询收集 |
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

新执行工具为 `workspace_list`、`workspace_read`、`collaboration_request`，`task_list`、`task_create`、`task_update`、`task_handoff`，以及 `artifact_list`、`artifact_read`、`artifact_propose`、`review_request`、`review_submit`、`user_question`；N6 增加 `conversation_pending`、`conversation_read`、`multi_mention`。旧冻结契约保留原工具集合，权限变化会使旧原生会话重建。工作区访问限制在配置目录内，读取工具只读，拒绝越界及软链接逃逸；任意 Shell 和工作区写入不开放。产物审批只允许将固定版本保存到平台数据目录。

## N7 的日常工作台与配置

会话标题下的“会话与项目”提供改名、置顶、归档恢复以及项目只读授权。授权先预览规范路径，再显式应用；有未释放执行或待投递来源时不能切换目录。执行和文件读取都会核对目录身份。附件通过输入栏上传，当前支持每个 32 KiB、单条合计 48 KiB 的 UTF-8 文本；纯附件可发送，正文进入实际输入快照，历史追问仍可引用。图片/PDF 暂不支持。引用回复绑定稳定消息 ID，引用和附件内的 @ 不改变本条消息路由。

成员可以设置稳定别名，账户和模型分别选择跟随运行时默认或保留成员例外。默认设置先展示影响范围，再按版本应用；在途执行保留冻结配置。删除成员保留历史身份，仍被有效配置引用的账户不能删除。新模型和推理强度需从所选账户实际目录选择，目录未返回的能力不虚构支持。

“账户与登录”分别显示配置、连接、官方身份、最近调用与额度。探测不会启动模型。API 密钥沿用环境变量引用；官方登录由用户在终端执行 codex login 或 claude auth login 后刷新，平台不提取订阅 token。不同 CLI 账户名称仍共享本机单个官方身份，多托管身份隔离不属于本轮。

## N6 的连续输入与多人征询

输入栏仍可直接发送。单目标 Codex 正在运行时，后续消息绑定原 invocation / response，取得准确 turn/steer 回执后才消费该投递；userMessage.clientId 匹配另记读取证据。不支持的承载保留下一轮。源码与协议支持不等于所有供应商均已实测。

“协作动态 → 协作调度”可查看来源排序、优先级、撤回、停止当前全部执行、逐条输入归并及追加核查。“多人征询”是可选操作，也可由 Agent 使用 multi_mention 发起；与普通多人 @ 分开，只有全目标返回才发布汇总，成功不自动唤回发起者。初次 prompt 或工具完整读取可承接多条来源；普通任务仍锚定 primarySource，不因此转交负责人。

## 产物如何交付与评审

成员通过 artifact_propose 提出文本版本，也可在“协作动态 → 产物与评审”手动提出。审查页展示完整内容与 SHA-256；批准后由独立作业保存到数据目录的 `collaboration-artifacts`，只有准确文件回执通过校验才发布版本。工作区不因此获得写入权限。

对已发布版本可指定另一成员评审；review_submit 必须来自实际消费该评审来源的执行。新版本发布或代码 HEAD 变化使旧结论不再代表当前材料。任务完成、审批通过、写入完成和评审通过分别记录。成员提问也在协作动态中回答，不增加聊天发送前的选项。

受管作业重启只核查原文件，缺失/不匹配保持 unknown，不自动重写。当前单版文本上限 32 KiB，审批与未完成评审有效期 24 小时，提问等待 120 秒。Codex 原生提问已接桥接协议；原生命令/文件/权限审批拒绝。Claude 使用平台提问工具，未声明 print 承载原生审批支持。

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

- 双 CLI 支持有证据的原生续接；模型未固定、身份不可核验或旧契约执行保守新建。API 直连使用平台公开历史。N6 支持经过本机协议发现的 Codex 精确当前轮追加；Claude/API 直连仍排队。accepted、read 与任务完成独立，未知不自动重发，追加核查目前限原活动句柄。
- 执行核查使用本服务进程保留的准确观察。服务重启、缓存丢失或承载无法查询时，明确保留未知，不自动重发。
- 普通任务支持同会话交接；跨会话委托、Action 专用责任与外部条件自动唤醒尚未实现。N5 的本地受管产物写入已实现，任意外部作业恢复未实现；N6 多人征询收齐后发一次普通汇总，超时不发部分汇总、重启停止收集；N7 已支持文本附件，图片/PDF、私聊、长期记忆和其他承载追加属于后续范围。
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
