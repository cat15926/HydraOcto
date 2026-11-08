# Multi Agent Collab

本地多 Agent 持续协作平台。用户在同一会话中直接提问、追问或 @成员，成员结合自己的职责，通过持久投递和工具调用请求其他成员协助。平台保存来源、执行、输入与结果之间的关系，让协作过程可以追踪和核查。

当前产品为 **0.25.0**，本地服务版本为 `0.25.0-p8-pr-ci`，数据库 schema 为 13。已交付 N0–N9 的协作能力、N10-A 本机 CLI 会话导入和 N10-B Hermes 成员接入，涵盖持续协作内核、Codex/Claude Code 接入、冻结输入与执行核查、原生会话延续、可选任务交接、产物审批与评审、来源调度和多人征询、日常工作台与成员账户、私聊与历史分支、记忆治理及词法检索，以及跨会话授权、专用责任和条件等待。[正式规则](docs/implementation-guide.md) · [实施进度](docs/implementation-progress.md)

**在聊天里确认成员的操作。** 在已授权项目会话中打开「工作台 → 项目与成员 → 项目权限」，勾选「在聊天里确认文件和命令」，点击「确认项目工作授权」。从下一次公开项目委托起，可在成员消息旁核对单个文件的完整写入内容或补丁，或查看命令和工作目录。选择「允许一次」「拒绝」或「取消并停止本轮」后，可在原消息中查看执行结果。Claude Code 可申请运行受支持的原生 Bash 命令。Codex 的环境查询由平台在项目副本中执行，卡片会标明执行位置和实际退出码。[验收与上线记录](docs/implementation-progress.md#native-project-progress)

**让成员看截图。** 在会话输入框粘贴截图，或点「＋ 附件」选择 PNG、JPEG、WebP。发送前可点击缩略图放大或移除；发送时写清希望成员根据图片完成什么。每张图片最多 5 MiB，每条消息最多四个附件。使用 API 账户的项目执行目前每轮图片合计最多 1.5 MiB。

**查看项目实际页面。** 在已授权项目的会话打开「工作台 → 项目预览」，点击「启动预览」。可操作页面、查看请求日志，完成后点「停止预览」。支持静态网页和已有构建产物。已上线本机。[实施与验收记录](docs/implementation-progress.md#native-project-progress)。

**在对话中查公开网页。** 在已授权项目的公开会话里向 Codex 或 Claude Code 提问，例如「查一下 Node.js 官方文档怎样说明跨平台支持，给我出处」。也可以直接发网页链接。回复里的出处可以点开，展开「网页查证记录」可核对检索词、原文和读取时间。[实施进度](docs/implementation-progress.md#native-project-progress)

**从聊天推送项目改动。** 在委托中写「完成后提交并推送本次修改」。收到确认卡后核对目标仓库、分支和完整差异，点击「确认推送」或「拒绝」。首批支持 GitHub 已有分支，卡片只收集能归因到成员的普通文本文件；远端读回的提交号可用于核验。[交付范围](docs/implementation-guide.md#native-project-p8)

**从项目会话查资料（P8 只读 MCP）**。管理员通过 `COLLAB_MCP_READERS` 登记服务和搜索工具后，在「工作台 → 项目与成员 → 项目权限」选择资料源并确认。之后直接请项目作者查询，例如「按团队手册核对这个项目的发布编号」。断开资料源后仍可继续项目工作。验收使用单独启动的本机只读服务，不需要用户准备账户或密钥。[配置示例](.env.example) · [验收范围](docs/implementation-guide.md#native-project-p8)

**项目测试、退修与复验（P7）**支持在独立项目副本按 npm 锁文件准备依赖，缺包时在聊天里确认一次下载。要让原作者接收评审意见，可以在第一条委托中写「修好后请 Claude 评审，有问题就继续改」。评审者以真实测试发现问题后，平台将失败命令交给原作者修订，作者自测通过后由同一评审者复验一次。当前本机发布状态见[实施进度](docs/implementation-progress.md#native-project-progress)。

**会话内提 PR 与跟踪 CI（0.25.0）。** 在已授权的项目会话发送「把改动提 PR 到 main，CI 失败就继续修」，核对工作分支、目标分支和差异后点击「确认创建 PR」。卡片会显示 GitHub 链接和当前提交的检查结果；原作者修复后，可在同一会话确认更新该 PR。本机 GitHub CLI 需要已登录且可创建该仓库的 PR、读取检查。[上线进度](docs/implementation-progress.md#native-project-progress)

**单包 npm 项目检查（P8-A）** 已上线本机。在已授权项目的会话中发送「@Codex 修复这个问题，跑测试、类型检查和构建后请 Claude Code 评审，有问题就继续改」。在回复下方可逐项对照初评与复验的命令、退出码及项目快照，即使只有类型检查失败，也能追踪原作者的修订和同一评审者的复验。项目须在根目录提供受支持的 npm 锁文件。缺少检查脚本时，会话显示跳过原因。[八项能力的交付条件](docs/implementation-guide.md#native-project-p8) · [验收与上线记录](docs/implementation-progress.md#native-project-progress)

**项目内持续协作（P0–P2）。** 在公开聊天里发「@Codex 修复这个项目的月报测试，完成后请 Claude Code 评审改动的文件」。首次发送时选择项目文件夹并确认授权，Codex 或 Claude Code 的原生 CLI 即可在本机 Linux 虚拟机中修改 Mac 上的项目。使用已验证的 CLI + API 账户时，对刚完成的同一成员项目委托说「继续」，平台会核对原生历史并续接。受邀评审的成员会独立读取指定文件；展开回复下方的「评审依据」，可以核对哪些文件已读、读取后是否变化，并请求重读。聊天中可停止执行，工作台可收回授权。[正式实施指导第 21 节](docs/implementation-guide.md#native-project) · [项目协作实施与验收进度](docs/implementation-progress.md#native-project-progress)

**官方登录的项目工作（P4，已上线本机）。** 在「成员与运行时」中选用绑定 Codex 官方登录的成员，即可从聊天委托它修改所选 Mac 项目的原文件、运行项目测试。登录和推理使用本机 ChatGPT 账户，项目命令在 Linux 虚拟机中执行。用同一会话追问时，普通 Codex 官方登录使用平台保存的上下文。Claude Code 可用智谱 API 在项目中工作；Claude 官方订阅尚未验证，本机未启用。升级保留已有成员的账户选择。

**双成员项目接力（P5，已上线本机）。** 首次使用时，在「成员与运行时」确认 Codex 成员选用了「Codex 官方 CLI 登录」和对应模型，Claude Code 成员选用了智谱 API。随后在两位成员所在的公开会话中发送「@Codex 修复月报漏掉零金额的问题，跑通原测试后请 Claude Code 评审改动」。Codex 使用官方登录处理修改，再把文件清单交给使用智谱 API 的 Claude Code。展开 Claude 回复下方的「评审依据」，可以查看它实际读取的文件、核对文件是否又有改动，并回到 Codex 发出的评审请求。[P5 实施范围](docs/implementation-guide.md#p5-relay)

**独立项目评审（P6，已上线本机）。** 需要评审者自己找相关代码并复跑测试时，在项目文件夹的授权预览中勾选「允许评审成员查阅项目并运行测试」。已有会话从工作台「项目与成员」进入「评审权限」。确认后照常发送「修复后请 Claude Code 独立评审并跑原测试」。回复下的「评审依据」列出实际读取的文件、测试命令和退出码。测试使用可见文件的独立副本，须由客体提供所需工具和依赖。[P6 规则](docs/implementation-guide.md#p6-project-review) · [实施与验收进度](docs/implementation-progress.md#native-project-progress)

P6 的官方 Codex 原生续聊使用「Codex 项目专用官方登录」账户。在「成员与运行时」打开该账户，复制登录命令，在本机终端按官方流程登录，返回后检查连接，再把项目成员绑定到该账户并选定模型。它在平台专用目录保存项目历史，后续委托核对同一原生线程和上一轮结束位置。已经使用个人 CLI 登录的成员继续按原配置工作。可用范围见[当前实施进度](docs/implementation-progress.md#native-project-progress)。

**项目外导出与失联核查（P3）。** 在聊天里发「把 monthly.csv 导出到桌面」。成员准备好文件后会请求你确认。聊天里选择保存位置、核对完整文件名，再点击“允许导出一次”，平台只新建该文件。执行意外中断时，可以打开“原执行现场”，查看成员已经收到的工具回执，并选择具体文件核对当前内容摘要。

N10-A 新增左侧「导入本机会话」。选择来源账户、项目和消息范围，确认后，首次发送在新会话中使用选定历史。可核验来源包括 Codex 官方索引中的账户/用户归属，以及两种 CLI 在真实终端执行时生成的来源回执。普通 Claude Code JSONL 通常缺少账户归属，无法据此列入候选。空状态提供当前成员与项目的终端命令，可用它记录以后的终端讨论。导入默认仅你与所选成员可见。版本及上线情况以[实施进度](docs/implementation-progress.md)为准。

N9 修订版通过 269 项自动化和 57 项 N9/N8/N7 浏览器复验；首轮开发与独立各通过 137 项浏览器断言及 4 次真实 CLI / 13 项断言，两个协作方向均覆盖。首轮发现的目录身份和原生上下文两项权限缺陷已修复并独立复验关闭。真实模型证据对应首轮冻结版；修复后的权限边界通过确定性输入与独立对抗检查，未新增模型调用。N9 当时未验证官方订阅推理；Codex 官方登录的项目委托已在 P4 验收。

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

### 本机项目执行器

已配置的机器上，用户直接从聊天选择项目。服务管理员首次登记一台专用的、已启动的 Lima/VZ Linux 虚拟机。只挂载一个项目为 `/mnt/project`，禁用宿主用户目录、SSH agent 和端口转发。客体需安装 bubblewrap、Python 3、libseccomp、iproute2，以及项目实际需要的命令。将仓库的 [客体执行器](scripts/runtime/project-vm-runner.py) 安装为 root 所有的 `/opt/multi-agent/project-vm-runner.py`，将验收过的 Linux 原生可执行文件安装到 `/opt/multi-agent/bin/codex` 或 `/opt/multi-agent/bin/claude`。启动时校验二进制、执行器及本次目录选择。

<details>
<summary>专用 Lima 实例配置示例（Apple Silicon）</summary>

此配置用于 Lima 2.3、VZ、Debian 13 arm64 和 virtiofs。本机管理员需把镜像路径、镜像 SHA-512 和初始项目路径替换为实际值。实例使用独立的私有 `LIMA_HOME`，其中的 `_config/` 不设置额外的 `default.yaml` 或 `override.yaml`。

```yaml
minimumLimaVersion: "2.3.0"
vmType: vz
arch: aarch64
cpus: 2
memory: "2GiB"
disk: "12GiB"
images:
  - location: "/absolute/path/debian-arm64.qcow2"
    arch: aarch64
    digest: "sha512:<镜像的完整摘要>"
mountType: virtiofs
mounts:
  - location: "/absolute/path/initial-project"
    mountPoint: /mnt/project
    writable: true
ssh:
  forwardAgent: false
  loadDotSSHPubKeys: false
  forwardX11: false
portForwards:
  - guestIP: "0.0.0.0"
    guestIPMustBeZero: false
    proto: any
    ignore: true
containerd:
  system: false
  user: false
propagateProxyEnv: false
```

客体验收使用兼容 `--as-pid-1`、`--block-fd` 和 `--disable-userns` 的 bubblewrap 0.12.0。Linux 需支持 PID、网络、挂载与用户命名空间、seccomp、pidfd，并启用 Yama 后代追踪限制（`ptrace_scope >= 1`）。在 Debian 13 中安装 `fuse3`、`python3-pyfuse3`、`python3-trio` 和 `python3-fusepy`，供执行器核对 CLI 自身文件描述符，并隔离保存原生会话历史。Lima 管理账户须能用 `sudo -n` 启动 root 所有的执行器，项目命令由受限的普通用户运行。将 Node.js、Git 或测试套件所需的其他命令安装到客体的 `/usr/bin` 工具路径。登记前用合成项目核验所选 Linux CLI，分别保留其二进制 SHA-256 和验证结果。

</details>

使用 Node.js 24 运行以下命令。变量指向这台机器上的绝对路径及已实测 CLI 文件的 SHA-256。两种成员分别登记，可只登记已通过的一种。登记文件的父目录须为私有目录。专用实例开启 `--manage-mount` 后，只有实例空闲、原执行退出可核验时，服务才会切换项目挂载。

```sh
node --import tsx scripts/register-project-vm.ts \
  --lima "$LIMA_EXECUTABLE" --lima-home "$PROJECT_LIMA_HOME" --instance "$PROJECT_VM_INSTANCE" \
  --project "$MOUNTED_PROJECT" --carrier "codex:$CODEX_LINUX_SHA256" \
  --carrier "claude:$CLAUDE_LINUX_SHA256" --manage-mount --history --output "$VM_REGISTRY"
```

`--history` 开启 P2 原生项目历史。仅为已实际验证历史隔离及续接的客体登记此能力。

在服务的 `.env` 中将 `COLLAB_PROJECT_VM_CONFIG` 设为生成的登记文件的绝对路径。推理使用成员绑定的 API 账户。项目内的测试命令在 Linux 运行，选择文件夹不会带入 Mac 的依赖、运行环境或官方登录会话。[本机登记命令](scripts/register-project-vm.ts) · [目录切换验证](scripts/verify-project-vm-switch.ts)

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
  HTTP --> VISIBILITY["可见性 / 选段引用 / 历史分支"]
  VISIBILITY <--> DB
  CORE --> VISIBILITY
  VISIBILITY --> MEMORY["记忆审批 / SQLite 物化 / 授权检索"]
  MEMORY <--> DB
  CORE --> CONTEXT["契约快照与输入组装"]
  CORE <--> DB[("SQLite<br/>来源、投递、执行、证据、事件")]
  CORE --> TASK["可选任务与交接<br/>ownerRevision / executionRef"]
  TASK <--> DB
  TASK -->|"释放证据齐全后提交新来源"| CORE
  HTTP --> CROSS["两端成员授权 / 跨会话精确投递"]
  CROSS <--> DB
  CORE <--> CROSS
  CROSS --> ACTION["专用 Action / 任务委托<br/>holder / generation / candidate / verdict"]
  ACTION <--> DB
  TASK <--> ACTION
  ACTION --> WAIT["有类型的条件 / episode / 事实证据"]
  WAIT -->|"条件满足且原执行确认退出"| CORE
  WAIT <--> DB
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
| N9 跨会话与专用责任 | [cross.ts](server/collaboration/cross.ts)、[actions.ts](server/collaboration/actions.ts)、[ActionPanel.tsx](web/ActionPanel.tsx) | 精确两端授权、公开材料重验、独立 holder、候选/验收分离、任务委托及条件唯一续跑 |
| 产物与交互 | [artifacts.ts](server/collaboration/artifacts.ts)、[artifact-files.ts](server/collaboration/artifact-files.ts)、[interactions.ts](server/collaboration/interactions.ts)、[ArtifactPanel.tsx](web/ArtifactPanel.tsx) | 精确审批、不可变文件、评审失效、原作业核查与有界提问 |
| N8 可见性与长期资料 | [visibility.ts](server/collaboration/visibility.ts)、[memory.ts](server/collaboration/memory.ts)、[KnowledgePanel.tsx](web/KnowledgePanel.tsx) | 同一可见范围的输入与工具、引用失效、历史分支、记忆版本及词法检索 |
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

## N9 的跨会话与专用责任

在“协作动态 → 跨会话与专用责任”批准两个会话的准确成员和有效期后，可发送跨会话消息或建立专用责任。授权冻结双方工作区身份，撤销、过期或目录变更后不能继续投递。只携带明确正文与获准的公开引用；不会继承对端历史、私聊或项目权限。普通跨会话消息成功不会自动叫回发送者。

专用责任 Action 保存主会话负责人、当前执行会话/成员和代次。可选委托已有普通任务，原任务 owner 保持不变。成员提交候选后，用户按准确候选接受结果，或核验固定版本产物的实际发布事实；回复结束本身不完成责任。返回前任、重派和取消都保留准确执行绑定，确认旧执行退出后才能开启下一代。

成员可登记定时、人工命名信号、受管作业成功或已发布产物等待。平台记录事实证据，再等原执行确认退出，创建唯一的续跑来源；重复通知、重启、旧代次和过期不会重复唤醒。每个 Action 同时只有一个 holder，可以建立多个独立 Action；普通会话没有固定唯一负责人。授权和等待最多 30 天，冷却最多一小时。本轮不支持任意外部 webhook、Shell 探针或私密材料跨会话转发。

新工具为 cross_routes、cross_send、action_list、action_create、action_candidate、action_return、action_wait；Agent 身份由准确执行绑定，创建授权与最终验收由本地用户操作。

## N8 的可见性与长期资料

普通输入仍可直接发送；“私聊”是可选入口，回复保留同一接收范围。公开执行不读取未公开私聊，私聊/公开切换会重建原生上下文。私聊暂不写公开任务、产物或向其他范围请求协作；可由用户在消息“更多操作”中选择片段分享。分享按准确引用重验，不依赖旧缓存正文。消息可以显式公开、删除、导出，或从指定历史点建立独立分支。公开回复前需单独公开其引用的私聊；删除引用后不再使用缓存正文，分支也保留独立引用关系。

会话记忆位于右侧“工作台 → 会话资料”，与查找材料、可见范围、成员组并列；聊天区仅显示“记忆待确认”轻量提示，未读数归于会话标题。左侧“记忆库”独立管理跨会话条目，支持搜索、状态筛选、版本和来源查看；新增条目明确关联来源会话及可见成员。进入记忆库再返回会保留聊天草稿。搜索仍支持本会话/全部会话，收藏、已读、导出和回收站位于会话操作菜单。记忆先生成候选，经批准后还需“实际收录”；物化回执与条目 head 在 SQLite 同事务提交。新版本或撤销保留历史审计，不能抹去模型已经读过的信息。Agent 仅可提议本会话当前范围的候选，不能自行审批或扩大权限。

新工具为 memory_read、memory_propose、material_search。检索覆盖获权消息、已发送文本附件、已发布受管产物、已收录记忆和平台回复；不读取原生 transcript、原始冻结输入审计或任意机器目录。semantic/hybrid 暂未接入，显式返回降级状态。当前 HTTP 服务仍是本机单用户；成员视角是用户审查功能，Agent 身份由准确执行绑定，不由请求里的 memberId 声明授予。

## 统一工作台入口

聊天顶部只保留“工作台”工具入口。当前修订按正式指导第 17 节实现：概览呈现当前会话的具体待处理项、任务、执行及产物，七项工具和最近访问收进“＋”；已打开工作以独立标签承接。产物绑定固定版本，支持临时预览、固定、编辑后保留、准确返回来源、最近关闭及按会话恢复布局。草稿保留在本页生命周期，不保存到浏览器持久存储。修订的实际验收与发布状态以实施进度为准。

入口与状态投影见 [WorkspacePanel.tsx](web/WorkspacePanel.tsx)，独立的前端工作集规则见 [workspace-state.ts](web/workspace-state.ts)，浏览器验收见 [verify-workspace-ui.mjs](scripts/verify-workspace-ui.mjs)。布局只持久化可校验的对象引用，不持久化密钥、正文或执行输入；恢复时读取当前业务事实，后台结果不自动切换当前视图。页面复用既有业务命令，不改变审批、权限、调度和执行规则；未选会话时先从消息创建会话。材料正文检索在会话资料内进行，跨会话记忆库和成员账户管理仍为独立入口。

## N7 的日常工作台与配置

左侧会话行的「⋯」可重命名、置顶或归档；进入归档列表可原位恢复。工作台「项目与成员」中点「选择文件夹…」打开服务所在桌面的系统选择器（macOS，或安装 Zenity 的 Linux 桌面）。选好后核对文件夹及完整路径，点「确认只读授权」后才切换；取消保留原工作区。有未释放执行或待投递来源时不能切换目录。执行和文件读取都会核对目录身份。附件通过输入栏上传，当前支持每个 32 KiB、单条合计 48 KiB 的 UTF-8 文本；纯附件可发送，正文进入实际输入快照，历史追问仍可引用。图片/PDF 暂不支持。引用回复绑定稳定消息 ID，引用和附件内的 @ 不改变本条消息路由。

成员可以设置稳定别名，账户和模型分别选择跟随运行时默认或保留成员例外。默认设置先展示影响范围，再按版本应用；在途执行保留冻结配置。删除成员保留历史身份，仍被有效配置引用的账户不能删除。新模型和推理强度需从所选账户实际目录选择，目录未返回的能力不虚构支持。

“账户与登录”分别显示配置、连接、官方身份、最近调用与额度。探测不会启动模型。API 密钥沿用环境变量引用；官方登录由用户在终端执行 codex login 或 claude auth login 后刷新，平台不提取订阅 token。普通 CLI 账户名称共享各自的本机官方登录。P6 另提供一个有独立登录目录的官方 Codex 项目账户。

## N6 的连续输入与多人征询

输入栏仍可直接发送。单目标 Codex 正在运行时，后续消息绑定原 invocation / response，取得准确 turn/steer 回执后才消费该投递；userMessage.clientId 匹配另记读取证据。不支持的承载保留下一轮。源码与协议支持不等于所有供应商均已实测。

“协作动态 → 协作调度”可查看来源排序、优先级、撤回、停止当前全部执行、逐条输入归并及追加核查。多方意见需求通过主输入框表达，成员可使用 multi_mention 发起征询；侧栏只展示已有征询的收集进度、等待成员、原始结果和取消操作，不提供第二套创建表单。普通多人 @ 仍分别投递，不自动建立征询组。征询收齐后只按成员汇集结果，成功不自动唤回发起者，也不代表已由模型综合结论。初次 prompt 或工具完整读取可承接多条来源；普通任务仍锚定 primarySource，不因此转交负责人。

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
| Hermes Agent 0.18.2 | 隔离子进程调用本机 Hermes SDK，使用平台工具与会话历史 | OpenAI 兼容 API 密钥，可复用 Codex 的兼容 API 账户 |
| OpenAI-compatible API | 直接 HTTP 调用 Chat Completions 工具协议 | API 密钥 |
| Anthropic API | 直接 HTTP 调用 Messages 工具协议 | API 密钥 |

在“成员与运行时”配置账户、承载和模型。API 账户需填写明确的服务地址、模型及密钥环境变量名，例如 `MY_MODEL_KEY`；密钥值保存在服务端环境或 `.env`，不通过页面输入。CLI 的 API 服务须兼容对应协议：Codex 使用 Responses，Claude Code 使用 Anthropic。协议兼容不代表底层模型来自协议原厂。

要邀请 Hermes，打开「成员与运行时」，添加成员并选择 **Hermes Agent**。选好账户和目录中的模型后保存，在目标会话的「配置成员」中加入，再从原输入框 @ 成员名。Hermes 发来的表单可以直接在该执行的问题卡上回答。安装检测默认读取 `~/.hermes/hermes-agent/venv/bin/python`，自定义安装可用 `COLLAB_HERMES_PYTHON` 指定解释器。服务端只将所选账户的密钥交给本轮隔离进程。Hermes 暂不支持官方登录、原生续接或执行中追加。

原生续接实测组合为 Codex `0.166.0-alpha.5.1` / `deepseek-flash` 与 Claude Code `2.1.220` / `glm-5.3`，使用 API 认证；官方订阅登录的续接尚未实测。工作台显示原生会话链、重建原因和承载报告用量，缺失值显示未知，报告成本不当作账单。

官方登录使用本机 CLI 账户；可通过 `COLLAB_CODEX_PATH`、`COLLAB_CLAUDE_PATH` 指定 CLI 二进制。环境配置示例见 [.env.example](.env.example)。

## 当前边界

- 双 CLI 支持有证据的原生续接；模型未固定、身份不可核验或旧契约执行保守新建。API 直连使用平台获权历史。N6 支持经过本机协议发现的 Codex 精确当前轮追加；Claude/API 直连仍排队。accepted、read 与任务完成独立，未知不自动重发，追加核查目前限原活动句柄。
- 执行核查使用本服务进程保留的准确观察。服务重启、缓存丢失或承载无法查询时，明确保留未知，不自动重发。
- 普通任务支持同会话交接；跨会话委托、Action 专用责任与外部条件自动唤醒尚未实现。N5 的本地受管产物写入已实现，任意外部作业恢复未实现；N6 多人征询收齐后发一次普通汇总，超时不发部分汇总、重启停止收集；N7 已支持文本附件，N8 已支持私聊、历史分支及长期记忆；图片/PDF、语义检索和其他承载追加属于后续范围。
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
