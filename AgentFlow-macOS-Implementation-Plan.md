# AgentFlow：macOS 桌面应用实施计划 v1.1

本文是实施基线，不是功能愿望清单。v1.1 已按用户修订切换为 Tauri、React、React Flow 与 Rust 单一技术路线。交给后续 Agent 时，应提供完整文件。用户后续明确指令优先；实施 Agent 不得自行扩大产品范围或静默降低验收要求。

本次交付是实施计划，尚未创建应用或验证真实 Agent CLI。所有真实 CLI 能力、登录方式和版本需在 P0 验证。

## 1. 产品目标与最终演示

交付一个从 Finder 启动的独立 `AgentFlow.app`。界面使用随 App 打包的网页技术并在内嵌 WebView 中运行，不依赖外部浏览器或在线网站。用户在 App 内管理多个 Agent 类型及其独立账号，创建普通任务、定时任务和长期目标，通过可视化工作流安排开发、测试、Review、修复和人工确认，查看执行状态、日志、文件产物和 Git Checkpoint，并能在异常后从可确认的位置继续。

最终演示必须包含：同一种 Agent 的三个真实账号同时执行不同任务；至少另一种真实 Agent 可接入；一个代码任务经历测试失败、修复、Review 拒绝、再次修复、再次测试及 Review、人工确认；运行期间强制结束 App，再启动后已确认完成的步骤不重复执行；全部历史仍可追踪。

“本地”指编排、界面和数据存储在本机；Agent CLI 本身可以调用远程模型，不代表离线模型推理。

## 2. 固定范围与默认决策

### 2.1 必须实现

1. 独立 macOS App 窗口、菜单栏入口和应用内任务操作。
2. 至少两种真实 Agent CLI 的适配；其中一种验证三个账号的并行隔离。
3. 每账号独立 profile、显式环境、认证状态和占用管理。
4. 普通任务、定时触发、长期目标及里程碑。
5. 不同 Run 并行、同账号串行、同工作区单写入者。
6. React Flow 可视化工作流编辑，以及与画布一致的真实执行。
7. 自动测试、结构化 Review、有上限返工、人工确认。
8. Git Worktree、版本 Checkpoint、产物和失败现场保留。
9. Run/Attempt 持久化、日志、重启核对、安全恢复。
10. App 内完成创建、查看、取消、继续、批准、结果管理；日常使用不要求打开终端。

### 2.2 第一版明确不做

- 外部浏览器产品界面、依赖在线网站或生产环境前端开发服务器。
- Electron、SwiftUI/AppKit 主界面、Swift 执行核心和自研原生工作流画布。
- HTTP 服务、云服务、团队账号系统、云同步、远程控制、插件市场。
- 任意有向图循环、同一 Run 内并行分叉和自动合并代码。
- 全功能终端模拟器、自动安装或升级第三方 Agent CLI。
- App 明确退出、Mac 关机或休眠时仍保证执行的后台调度。
- 自动发布、自动推送远端、自动合并主分支、自动发送消息。
- 无预算限制的自主目标探索、自动切换付费账号。
- 容器或虚拟机管理平台、跨账号恶意访问防护承诺。

### 2.3 默认工程决策

| 项目 | 第一版决定 |
|---|---|
| 桌面应用框架 | Tauri 2 |
| UI | React + TypeScript，编译为随 App 打包的静态资源 |
| 工作流画布 | React Flow；仅负责编辑和展示 |
| 执行核心 | Rust，独立于 UI 模块 |
| 存储 | 系统 SQLite3；小型参数化 SQL 封装，不实现通用 ORM |
| 数据流 | App 内 Swift 调用与可观察状态；App 与 runner 使用文件协议 |
| 执行进程 | 每 Attempt 一个随 App 打包的 Rust runner |
| UI 与核心通信 | 明确声明的 Tauri Commands / Events，不提供任意 shell 或文件访问接口 |
| 打包 | 原生 `.app`，直接分发路径，第一版不以 Mac App Store 为目标 |
| Sandbox | 第一版不启用 App Sandbox；明确仅保证正常使用时的 profile/工作区隔离 |
| 系统版本 | 默认 deployment target macOS 14；P0 核对用户系统后确定并记录 |
| CPU | 避免架构专属逻辑；先验证用户实际架构，未测试的架构不能宣称支持 |
| 第三方依赖 | 初始为零；确有必要时记录用途、替代方案、维护成本并锁定版本 |
| 调度 | 单个 App 调度实例，全局默认最多 3 个执行步骤，每账号最多 1 个 |
| 队列 | FIFO；第一版不做优先级调度 |

App Sandbox 对嵌入命令行工具及文件访问有额外约束，选择直接分发是本产品调用用户已安装 CLI 的设计取舍，不代表 macOS 原生应用天然不能使用 Sandbox。[Apple 官方说明](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)

### 2.4 唯一待补充的接入输入

P0 记录用户实际 macOS 版本、CPU 架构、首批两种 Agent CLI 名称与安装路径，以及可用于验证的账号。不得替用户凭空指定供应商或虚构认证参数。用户登录所需操作在 App 的接入向导中说明；不要求用户把凭据交给实施 Agent。

未获得真实账号时可以完成 mock 和通用核心，但真实接入验收保持“未验证”。不得为了通过验收，悄悄将两种真实 Agent 缩减为 mock。

若供应商认证要求系统授权网页，明确这是一次性登录流程；产品操作仍全部在原生 App 内。如果用户也禁止登录网页，需选择支持其他认证方式的 CLI，而不是绕过供应商认证。

## 3. 防跑偏规则

1. 每次开始实施，先读本文、仓库 AGENTS.md、`docs/STATUS.md` 和对应阶段验收项。
2. 一个阶段完成后更新证据和状态，再进入依赖它的阶段。
3. 不把 mock 测试标为真实 Agent 验证，不把编译通过标为运行恢复通过。
4. 不凭猜测写 Agent 参数、认证路径、JSON 输出格式或恢复 API；保存实际版本和验证依据。
5. 不以简化为由删除账号隔离、失败现场、持久化、可视化画布、第二种 Agent 或验收测试。
6. 不增加未列入第一版的基础设施。模块内部实现可自主决定；改变产品边界需先说明原因和影响。
7. Run 固定配置与工作流快照。运行中的编辑不得修改已有执行事实。
8. 未完成的功能必须标为未完成，不以 TODO、占位数据或成功动画掩盖。
9. 日常控制全部在 App 内；开发验证允许使用 `cargo`、`npm`、Tauri CLI、Git 和测试命令。
10. 在非 macOS 环境可以编写文档和部分代码，但必须明确未完成 macOS 构建与实机验收。

## 4. 领域模型与状态规则

### 4.1 对象

| 对象 | 定义及关键字段 |
|---|---|
| AgentAccount | adapterID、显示名、profile 路径、认证状态、验证身份、能力、配置版本 |
| Project | 用户仓库路径、Git 路径、默认基线、允许提交范围、测试命令 |
| Task | 用户需求、验收条件、项目、工作流版本、角色与账号绑定 |
| WorkflowVersion | 不可变执行定义、schemaVersion、版本号；布局数据独立 |
| Run | taskID、触发来源、配置快照、状态、开始/结束时间、预算、当前步骤 |
| StepExecution | 某节点某轮次的逻辑执行，负责区分返工循环中的重复节点 |
| Attempt | stepExecutionID、尝试序号、实际账号、输入摘要、runner 身份、结果、错误 |
| Artifact | 来源 Attempt、相对路径、类型、大小、SHA-256、是否存在 |
| Checkpoint | 来源 Attempt、repo 标识、baseSHA、commitSHA、文件清单 |
| Approval | runID、节点执行、候选版本、证据摘要、决定、意见和时间 |
| Schedule | 规则、时区、下次时间、漏跑及重叠策略、启用状态 |
| Goal | 目标、验收条件、里程碑、预算、状态；关联多个 Task |

Task 表示意图，Run 表示某次执行，Attempt 表示某一步的一次实际启动。重试和返工不得覆盖旧 Attempt。

### 4.2 状态

- Run：`queued / running / waiting_input / interrupted / succeeded / failed / cancelled`。
- Attempt：`prepared / starting / running / finalizing / succeeded / failed / interrupted / cancelled`。
- StepExecution：`pending / running / waiting_input / succeeded / failed / skipped`。
- 账号认证与占用状态分开：认证状态 `unverified / ready / needs_login / unavailable`；占用状态 `idle / busy / blocked_unknown`。
- Run 的 `waiting_input` 必须保存 reason，例如 `approval_required / budget_exhausted / account_unavailable / recovery_decision`。
- “修复中”“Review 中”属于当前阶段，不另造顶层状态。
- Run succeeded 只能由引擎在结束节点及验收满足后写入，UI 不能直接设置。
- 有合法 Review 结果 `changes_requested`，表示 Review 步骤成功执行并选择返工分支，不属于 CLI 技术失败。
- `cancelled` 是终态；再次执行创建新 Run。`interrupted` 可通过明确恢复动作继续，但原 Attempt 保留。

### 4.3 数据库

表按需要分阶段落地，完整范围为：

```text
schema_migrations, accounts, projects, tasks,
workflow_versions, runs, step_executions, attempts,
resource_locks, events, artifacts, checkpoints,
approvals, schedules, schedule_firings, goals, goal_tasks
```

必须存在的约束：

- `UNIQUE(step_execution_id, attempt_number)`。
- `UNIQUE(run_id, node_id, iteration_key)`。
- `UNIQUE(resource_type, resource_id)` 防止同账号、同工作区双占用。
- `UNIQUE(schedule_id, scheduled_at_utc)` 防重复触发。
- `UNIQUE(attempt_id, runner_event_seq)` 防重放事件重复入库。
- StepExecution 与新 Attempt 的创建、资源占用在同一事务内完成。
- 状态变更与对应结构化事件在同一事务内提交。

采用单个存储 actor 串行写库、参数化 SQL、外键校验、WAL 和有界 busy timeout。事务内不得等待 CLI、网络或用户输入。WAL 不是多写入者机制；高频日志保存在文件中。[SQLite 官方说明](https://www.sqlite.org/wal.html)

## 5. 模块边界与数据目录

工程包含一个 Tauri App、React 前端、Rust Core crate、Rust runner 和测试。不要为每个小模块单独拆 crate。

```text
AgentFlow/
  src/                         # React、TypeScript、React Flow
  src-tauri/                   # Tauri Commands、Events 和桌面生命周期
  crates/
    agentflow-core/            # 领域、存储、账号、调度、工作流、Git 与恢复
    agentflow-runner/          # 独立可执行文件入口
  tests/                       # 集成与故障注入
  fixtures/                    # 小型 Git 项目和 mock 事件
  docs/
    PLAN.md
    STATUS.md
    DECISIONS.md
    ACCEPTANCE.md
    ADAPTER_CAPABILITIES.md
```

主数据目录通过系统 Application Support API 获取，不硬编码用户名：

```text
Application Support/AgentFlow/
  agentflow.sqlite
  profiles/<account-id>/
    home/
    config/
    cache/
    tmp/
  runs/<run-id>/
    manifest.json
    attempts/<attempt-id>/
      launch.json
      identity.json
      heartbeat.json
      control/cancel.json
      stdout.log
      stderr.log
      events.jsonl
      result.json
    artifacts/
  workspaces/<run-id>/
    generation-<n>/
  reviews/<attempt-id>/
  locks/
```

React UI 只通过明确声明的 Tauri Commands 发出业务请求，并通过查询或 Events 读取展示数据；不直接启动 CLI、更新执行终态、操作 Git，也不获得任意 shell 或文件访问能力。参数校验和权限判断在 Rust 核心完成。只有 App 内 Storage 层写 SQLite；runner 只写自己的 Attempt 目录。App 重启后通过目录协议继续观察仍在运行的 runner。Events 只用于界面刷新通知，不能代替持久化事实。

文件协议第一版采用简单可验证方式：App 对活跃目录做有界轮询，默认每秒一次；日志按偏移量增量读取，界面节流更新，不反复读取整个文件。协议带版本，不另加 HTTP、XPC 或消息队列。

## 6. 账号隔离与适配器合同

### 6.1 账号隔离流程

1. 用户选择已安装 CLI；App 保存可执行文件绝对路径及实际版本。
2. 新建独立 profile，默认目录权限仅当前系统用户可读写。
3. 构造显式子进程环境，指定 HOME、XDG、TMPDIR 以及经验证的工具专属目录变量；这些修改只作用于子进程。
4. 不整体复制父进程环境。PATH 使用检测后保存的工具链目录；用户可显式配置必需代理或额外变量。
5. 验证登录方式、凭据存储、钥匙串、全局 socket、共享后台服务、会话目录和缓存目录。
6. 使用独立账号标记和供应商可提供的身份信息验证账号，不能只检查目录名不同。
7. 登录、重新认证、配置修改、任务执行共用账号占用机制。
8. profile 变更或 CLI 升级后，相关能力验证失效或需重新确认。

独立 HOME 不保证 macOS Keychain 隔离，也不能阻止同一系统用户的进程读取其他目录。不能通过轮换全局凭据文件实现并行。认证位置无法隔离的 CLI 标为“该模式不支持多账号”，不得假报成功。

第一版是运行配置隔离，不是安全沙箱；未知身份应显示“未验证”。如果 CLI 没有身份查询能力，保存人工核对状态及依据，不能声称已自动验证。

### 6.2 最小适配器接口

```text
probe(executableURL) -> 安装版本和能力
validateAccount(account) -> 认证状态和可验证身份
prepareLaunch(accountSnapshot, stepInput) -> LaunchSpec
parseEvent(bytes) -> 归一化事件（可选）
collectOutcome(files, exitInfo) -> 结构化结果或解析错误
```

会话恢复能力是可选项，只有真实验证过的工具才暴露。取消主要由 runner 管理；工具专属优雅退出可作为能力补充。

`LaunchSpec` 至少包含 executableURL、arguments 数组、workingDirectory、环境配置引用、stdin 输入文件、超时和输出协议版本。不得把可变参数拼成 shell 命令字符串。用户显式配置的 shell 脚本作为一种 Command 执行模式单独保存。

Foundation Process 支持独立指定可执行文件、参数、工作目录、环境和标准流；进程组管理另在 runner 层实现并测试。[Apple Process 文档](https://developer.apple.com/documentation/foundation/process/executableurl)

不得假定 Finder 启动时具有用户交互式 shell 的 PATH。CLI 使用 `/usr/bin/env` 寻找语言运行时时，也必须通过配置的 PATH 验证。不要默认读取用户 shell 启动脚本来“修复环境”。

### 6.3 认证与记录

- App 数据库不保存明文认证 token，只存引用和状态。
- CLI 自有凭据留在它已验证的独立存储位置，不擅自改变供应商格式。
- App 自己管理的秘密使用 Keychain 或仅用于当次运行的受限输入；不得写入普通 manifest。
- 保存“请求账号”和“实际绑定账号”，不静默换账号。
- 限流、认证过期或额度不足进入等待处理，其他账号继续工作。
- 不修改第三方工具的权限保护或自动启用绕过确认模式。
- 需要交互但不支持非交互运行的 CLI，明确接入限制；不在第一版追加完整终端模拟器。

## 7. runner、调度与取消

### 7.1 启动协议

1. App 获取单实例 OS 文件锁；启动完成恢复扫描前不派发任务。
2. 数据库事务创建 Attempt，写入 `prepared`，占用账号和工作区。
3. 原子写入 `launch.json`，含 Attempt ID、唯一 execution token、输入摘要和协议版本；敏感值不进入普通快照。
4. 写入 `starting`，启动随 App 打包的 runner。
5. runner 获取该 Attempt 独占 OS 文件锁；同一 Attempt 的第二个 runner 必须拒绝运行。
6. runner 写入自己的 PID、进程启动信息、execution token 和子进程组标识。
7. runner 启动 CLI，持续排空 stdout/stderr、处理日志、记录心跳和结果。
8. App 观察到有效启动身份后写入 `running`；启动阶段崩溃也必须可核对。
9. CLI 结束后 runner 先将结果写临时文件、刷新并原子替换为 `result.json`。
10. App 标记 `finalizing`，验证结果和产物，生成或核对 Checkpoint，再事务提交终态和下一步。

控制文件和结果文件必须包含 Attempt ID 与 token，防止旧文件误用于新执行。token 仅用于一致性识别，不是同系统用户之间的安全边界。

### 7.2 进程生命周期

- CLI 及普通子进程处于独立进程组；对取消和超时，先发温和退出信号，默认等待 10 秒，再按已验证身份终止该组。
- 不能只调用父进程 terminate 就认为所有子进程消失。
- CLI 若脱离进程组并使用共享 daemon，P0 必须查清隔离及终止方式；无法确认结束则占用状态为 blocked_unknown。
- App 崩溃后 runner 应继续写文件；不可将 App 持有的 Pipe 当成日志唯一去处。
- App 不存在时 runner 只完成当前 Attempt，不调度下一个节点。
- 子进程结束、关键输出落盘、共享 daemon 状态可确认后，才释放执行资源。
- 心跳过期只触发核对，不能单独作为“进程已死”的证据。
- PID 识别必须结合启动信息、token 和 runner 锁；不得向无法确认身份的进程发送信号。

### 7.3 默认预算

- 全局并发 3，每账号并发 1，每工作区写入 1。
- 单步骤超时默认 30 分钟，可在模板中修改。
- 技术失败默认不自动重试；明确无副作用的节点可配置最多 1 次自动重试。
- 开发/修复循环默认最多 3 轮；技术重试不增加逻辑轮次，但消耗执行预算。
- 长期目标默认总 Attempt 上限 100，活跃执行时间预算 8 小时，可配置。
- 人工等待不消耗活跃执行时长；预算包含已失败的执行时间。
- 达到预算不再启动新步骤，进入 waiting_input；提高预算必须形成事件。
- 未提供 token/金额用量的 Agent 显示“不可用”，不能声称已实施金额预算。

## 8. Git 工作区、Checkpoint 和产物

### 8.1 工作区规则

1. 每个代码 Run 固定起点 commit，创建专属分支 `agentflow/<run-id>` 和 Worktree。
2. 用户原仓库存在未提交修改时，不自动 stash、不自动提交、不把这些修改混入任务；界面明确本 Run 从哪个已提交版本开始。
3. 同 Run 的开发与修复顺序使用其工作区；恢复回退时创建新的 generation 分支和目录，旧目录保留。
4. 不同 Run 的分支与目录独立。Worktree 管理操作按仓库串行执行。
5. Git Worktree 共享部分仓库元数据，不能修改用户全局或共享 Git 配置。必要的提交身份用本次命令的显式配置提供。
6. 开发完成后建立候选 Checkpoint；测试从该候选运行，测试若修改了受跟踪文件，结果无效，不得把修改后的文件当成原候选通过。
7. Review 在候选 commit 的独立 detached Worktree 中执行；使用工具支持的只读权限。若无 OS 强制只读能力，检查前后变化并拒绝污染结果，不宣称安全只读。
8. Review 不允许偷偷把修复写入开发工作区，必须产生发现并经修复节点处理。
9. 不自动合并或 push。最终产物提供候选 commit、差异和 Finder 入口。

Git 官方文档明确 Worktree 管理和共享配置行为；只把它作为工作目录隔离手段。[Git Worktree 文档](https://git-scm.com/docs/git-worktree)

### 8.2 Checkpoint 的幂等性

- 每个 Checkpoint 保存 runID、attemptID、baseSHA、commitSHA 和受控文件清单。
- 仅提交项目允许范围内的改动，尊重忽略规则，排除凭据、日志、缓存和构建产物。
- 不使用无检查的 `git add -A`；删除、重命名和新增文件都必须纳入显式变更清单。
- 提交说明含稳定 Attempt 标记；重启时若提交已生成但 DB 未写入，核对已记录的父 commit、文件树和标记后补记，不再生成重复提交。
- 无代码变化允许复用已有 commit，但必须记录“无变化”，不能伪造新 SHA。
- 引擎创建 Checkpoint 期间不允许另一个步骤写同一工作区。
- 处理 Git hook 和签名行为：引擎内部 Checkpoint 默认禁用 hook 执行及签名交互，仅作用于该命令；用户需要的质量检查通过显式 Command 节点运行，不修改其仓库配置。

### 8.3 产物与失败现场

- 产物清单保存类型、相对路径、大小、哈希和来源 Attempt。
- 仅接收允许根目录内的普通文件；拒绝越界相对路径和指向外部的符号链接。
- 大文件采用流式哈希和复制，超过配置上限时明确提示，不悄悄丢弃。
- 失败现场保留工作区、diff、Git 状态和允许范围内的未跟踪文件清单；不承诺捕获秘密和任意外部目录。
- 恢复到旧 Checkpoint 时新建工作区，不对旧现场执行 hard reset 或 clean。
- 第一版不自动回收失败现场；删除前列出精确对象并提供确认。

## 9. 工作流格式、返工和验收

### 9.1 固定节点

`Start / Agent / Command / Condition / HumanApproval / End`。

返工作为受限 `RepeatBlock`：一个入口、一个出口、明确回边和最大轮次。只允许块内指定回边；拒绝任意循环和嵌套循环。Condition 使用声明式字段比较，不执行用户提供的 JavaScript 或 Swift。

同一 Run 一次只执行一个活跃路径；第一版不存在并行分叉。多个 Run 可并行，这已经支持多个账号同时执行不同任务。

### 9.2 必备模板

```text
Start
  → 需求分析（analyst）
  → 有限返工块，最多 3 轮
      → 第 1 轮开发；后续轮次修复（developer）
      → 自动测试
          失败 → 将测试结果带入下一轮
          通过 → Review（reviewer）
                    changes_requested → 将发现带入下一轮
                    approved → 人工确认
                                  驳回 → 将意见带入下一轮
                                  批准 → 退出返工块
  → End
```

一个节点可在首轮和后续轮次采用不同输入模板，不需要任意脚本分支。每轮所有测试和 Review 绑定当前候选 SHA。

角色映射在 Run 创建时固定到 accountID。账号不可用则等待，不静默换号。若用户决定换号，第一版创建关联的新 Run，从明确的 Checkpoint 开始；旧 Run 保留，不篡改历史。

### 9.3 数据合同

每个 Attempt 输入至少包含：

```json
{
  "schemaVersion": 1,
  "runID": "uuid",
  "stepExecutionID": "uuid",
  "attemptID": "uuid",
  "iteration": 1,
  "accountID": "uuid",
  "task": {"description": "...", "acceptanceCriteria": ["..."]},
  "workspace": {"path": "...", "baseCommit": "...", "candidateCommit": null},
  "inputs": [{"artifactID": "uuid", "sha256": "..."}],
  "timeoutSeconds": 1800
}
```

代码 Review 必须校验如下形状：

```json
{
  "schemaVersion": 1,
  "verdict": "changes_requested",
  "reviewedCommit": "commit-sha",
  "summary": "发现一个阻塞问题",
  "findings": [
    {"severity": "blocking", "file": "Sources/Search.swift", "line": 42, "message": "空输入行为不符合验收条件"}
  ]
}
```

退出码零只表示进程正常退出；解析失败是 `invalid_output`，不能扫描自然语言中的“通过”来放行。测试执行器区分 passed、failed、infrastructure_error；代码测试命令必须预配置并记录，不能让 Agent 自行把测试替换成总是成功的命令。

上游信息通过受控文件产物及摘要传递，不默认复制所有历史日志到下一 Agent 的 prompt。实际提交给 Agent 的输入必须保存可追溯版本并做必要脱敏。

### 9.4 工作流验证器

执行前必须拒绝：无唯一 Start、无可达 End、悬空边、重复节点 ID、未配置账号角色、缺少条件默认路径、未限次回边、不可达必需节点、不支持的节点版本、必需输入不存在。

画布与执行引擎共用 Codable 定义和同一验证器；画布坐标不参与执行含义。发布产生不可变 WorkflowVersion，修改布局也不能改变 Run 的执行快照。

### 9.5 完成判定

代码类 Run 成功需同时满足：必要步骤成功、测试通过、Review 批准、人工确认通过，且三者对应同一候选 SHA 及执行定义摘要。工作区出现额外代码变动后旧批准失效。非代码任务使用产物清单哈希代替 SHA。

历史步骤不删除。输入、候选版本或定义发生变化时创建新的逻辑执行，旧结果只作历史，不直接复用。缓存键至少覆盖输入摘要、工作流版本、候选 commit 和关键执行配置。

## 10. 重启恢复与失败处理

恢复顺序固定：取得 App 单实例锁 → 打开并迁移 DB → 核对未终结 Attempt 和目录 → 验证 runner/结果/Checkpoint → 修复可确认记录 → 隔离未知资源 → 恢复调度。

| 情况 | 行为 |
|---|---|
| Attempt 已成功、依赖结果有效 | 不重复执行，继续后续节点 |
| 已启动且 runner 身份可确认 | 继续观察，不创建替代进程 |
| runner 结果完整、DB 未提交 | 幂等校验并补记终态 |
| Checkpoint 已提交、DB 未记 | 核对标记、父 SHA 和树后补记 |
| prepared 且可证明从未启动 | 继续启动协议 |
| starting 但是否已执行不明 | interrupted，保留资源占用并等待核对 |
| runner 消失、结果不完整 | interrupted，保留现场 |
| 心跳过期但进程可能仍活着 | 不释放账号和工作区 |
| 结果文件损坏或产物缺失 | 标记原因，阻止依赖步骤执行 |
| 外部副作用结果不明 | 等待人工处理，不自动重试 |
| 旧 runner token 与当前执行不匹配 | 不接纳结果，记录异常，不推进流程 |

恢复面板提供：查看现场、重新核对、确认停止旧执行、从最后有效 Checkpoint 新建 Attempt、取消 Run。仅当旧执行已确认停止且策略允许时才开放重试。不能把“继续”按钮直接实现成重跑全部流程。

恢复承诺针对进程崩溃和程序重启，关键完成边界使用持久化写入；强制掉电时尚未落盘的最后日志片段可能丢失，应显示不完整。不得宣称任意外部操作 exactly-once。

## 11. macOS 应用行为和界面

### 11.1 生命周期

| 操作 | 行为 |
|---|---|
| 关闭主窗口 | App 留在菜单栏，运行继续 |
| 从菜单栏打开 | 恢复原窗口和任务视图 |
| Cmd-Q / 明确退出 | 先停止派发；有活动任务时选择返回 App 或停止执行并退出；保留 interrupted 现场 |
| 强制结束 App | runner 完成当前步骤并写结果；不自行执行下一步 |
| 唤醒 | 暂停新派发直到完成核对；不根据睡眠期间的心跳间隔直接判死 |
| 系统时钟变化 | 重算调度时间，利用触发唯一键防重复 |

任务超时默认包含休眠流逝时间；唤醒后先验证进程，再处理已过期 Attempt。第一版不阻止系统休眠，也不安装 LaunchAgent/常驻调度服务。

菜单栏入口可使用系统 MenuBarExtra。[Apple 文档](https://developer.apple.com/documentation/swiftui/menubarextra)

### 11.2 页面

1. 总览：运行中任务、空闲账号、等待处理、最近失败。
2. 任务：列表和状态筛选；创建普通任务、指定项目、工作流和账号角色；启动前展示执行摘要。
3. Run 详情：工作流当前节点、轮次、时间线、日志、测试、Review、人工操作、产物和 Git 差异。
4. Agent 账号：类型、profile、可执行路径、版本、认证、身份验证级别、当前占用和失败原因。
5. 工作流：模板列表、React Flow 画布、参数面板、验证错误、发布版本。
6. 定时任务：简单规则编辑、时区、下次触发、跳过记录、启停。
7. 长期目标：验收标准、里程碑、关联任务、预算、阻塞原因。
8. 设置：工具路径、数据目录展示、并发、日志和产物限额、备份恢复。

React Flow 画布第一版具备：增删节点、拖动、连线、平移缩放、选中参数、错误定位、保存和发布。React Flow 只负责编辑和展示；发布和执行合法性使用 Rust Core 的同一验证器。不额外扩展协同编辑、自动布局或通用插件。

进度显示当前节点、已完成节点、轮次和运行时长。不提供模型未知的百分比。日志视图支持增量加载、搜索、复制和打开文件；不能一次性把数百 MB 加载到 UI。

## 12. 定时任务与长期目标

### 12.1 定时任务

第一版固定三种规则：一次性、每天指定时刻、每周指定星期及时间。使用 Foundation Calendar 和 IANA 时区，先不加入任意 cron 表达式。

- 内部触发时间保存 UTC；时区按规则解释。
- 夏令时不存在的时刻跳过；重复时刻只触发一次，选第一次，并保存发生日期与 UTC 时间。
- 应用正常运行时到点派发；短暂延迟允许 60 秒宽限，超出视为漏跑。
- App 关闭或休眠期间漏跑默认跳过并记录，不启动后批量补跑。
- 同一 Schedule 已有 queued/running/waiting_input/interrupted Run 时，默认跳过本次。
- 触发记录与 Run 创建同一事务；唯一键防重启或重复 tick 创建多次。
- 账号忙时排队，不切换账号。
- App 未运行时不承诺准时执行，界面明确显示。

### 12.2 长期目标

- 用户定义目标、验收条件、里程碑和预算。
- 通过普通 Task/Run 推进，复用同一引擎，不另建永久 Agent 循环。
- Agent 可以提交“后续任务建议”产物，用户确认后才创建子任务。
- 暂停目标立即停止为该目标启动新步骤；当前步骤可完成，随后停在安全边界。
- 已有关联任务的完成不会自动证明目标达成，第一版由用户核对验收标准后标记完成。
- 超出预算或全部子任务终结但验收未达成，进入等待处理。

## 13. 日志、备份和结果管理

- stdout/stderr 持续排空，防止子进程因缓冲区满而挂起。
- 分块脱敏必须处理秘密跨分块边界；不记录完整环境变量。
- 日志默认完整保留经脱敏内容，不静默截断。配置磁盘限额，接近限额警告，达到限额停止派发并安全处理中运行任务，显示记录不完整原因。
- 处理不完整 UTF-8、超长行和控制字符；日志不是可执行指令。
- 产物在 App 内查看文本/JSON/diff，其他文件提供 Finder 入口，不自动执行产物。
- 备份先暂停派发并等待或停止活动执行，得到一致快照后复制。
- 数据库使用 SQLite Backup API 或经过验证的一致性方式，不能在 WAL 活跃时仅复制 `.sqlite` 主文件。[SQLite Backup API](https://www.sqlite.org/backup.html)
- 备份包括 DB、Run 文件、产物、项目引用、包含 AgentFlow 分支和 Checkpoint 的 Git bundle，以及允许范围内的未提交改动与未跟踪文件；验证 bundle 包含恢复所需对象。
- 不承诺将用户外部整个仓库和任意文件一起备份；文档明确范围。
- 凭据默认不进入普通备份。恢复后账号需重新认证；配置可恢复。
- 恢复到新数据目录，校验哈希、重映射路径、从 bundle 重建仓库和 Worktree；所有旧活动进程引用作废，先进入 interrupted，不自动运行。
- 清理仅作用于明确选择的 Run/工作区；保留仍被引用的 Checkpoint。使用 Git Worktree 管理接口移除登记，再清理专属目录，不做宽泛递归删除。

## 14. 分阶段实施任务单

每阶段执行顺序：阅读输入 → 实现最小闭环 → 运行验收 → 保存证据 → 更新 STATUS。自动测试只覆盖真实风险和行为，不为简单 UI 属性堆积测试。

### P0：Tauri 环境、隔离和生命周期可行性验证

输入：本文、实际 Mac、两种 CLI、测试账号。

步骤：

1. 记录系统、架构、Rust、Node、Tauri、Git 与 CLI 版本；记录 macOS 打包所需 Xcode/Command Line Tools 状态。
2. 确定 deployment target 和实际可执行路径。
3. 为首种 CLI 创建三个 profile，验证认证、配置、缓存、临时目录和会话。
4. 使用三个真实账号并行执行无破坏的小任务，记录身份及文件写入位置。
5. 对第二种 CLI 验证至少一个账号和同样的能力矩阵。
6. 验证非交互执行、结构化结果、取消、共享 daemon 和会话恢复能力。
7. 制作最小 Rust runner 原型，验证 App 父进程退出后结果仍能写入，以及进程组取消。
8. 将未知项明确保留，禁止补造供应商能力。

交付：`docs/ADAPTER_CAPABILITIES.md`、`docs/DECISIONS.md`、可重复探测测试。

退出条件：首种三账号真实隔离通过；第二种基本接入可行；runner 生命周期可验证。缺少真实环境时可推进独立 mock 工作，但 P0 不得标完成。

### P1：Tauri、React 与 Rust 工程骨架

依赖：P0 的系统及工程决策。

步骤：

1. 建立 Tauri App、React 前端、Rust Core、runner 和测试，锁定依赖并配置可复现构建。
2. 建立侧栏、空状态、设置页、菜单栏和窗口关闭行为。
3. 用系统 API 创建数据目录与权限。
4. 建立最小版本化协议和错误模型。
5. 从 Finder 启动开发版 `.app`，确认生产包使用内嵌静态资源且没有前端开发服务器、外部浏览器或终端依赖。

交付：可启动 App、构建说明和一次实机验证记录。

退出条件：`cargo tauri build` 成功；Finder 启动正常；生产包不依赖开发服务器；窗口关闭后菜单栏仍可打开；明确退出不会残留调度进程。

### P2：持久化与 mock 执行闭环

依赖：P1。

步骤：

1. 实现 schema migration、单写 Storage、Task/Run/StepExecution/Attempt、events 和锁。
2. 实现合法状态迁移；拒绝终态被旧事件覆盖。
3. 实现 mock CLI fixture：成功、失败、延迟、无效 JSON、派生子进程、超长日志。
4. 实现 App 内创建简单任务、执行一个 mock 步骤、查看结果。
5. 重开 App 读取同一任务、Run 和 Attempt。

交付：单步持久化闭环和状态约束测试。

退出条件：重启不丢记录；重复导入同一事件不重复；失败不会变成成功；唯一约束阻止重复 Attempt。

### P3：可靠 runner、资源锁与调度

依赖：P2。

步骤：

1. 落地 launch/identity/heartbeat/control/result 文件协议与版本校验。
2. 实现 App 单实例锁、Attempt 独占锁、账号/工作区持久化占用。
3. 实现进程组、stdout/stderr 排空、原子结果、日志增量读取。
4. 实现 FIFO、全局并发、账号串行、超时与取消。
5. 实现初版启动核对，未知进程不释放资源。
6. 模拟 App 崩溃和双启动，验证无重复执行。

交付：不依赖 UI 持续存活的 runner 和故障注入测试。

退出条件：三个 mock 并行；同账号不重叠；取消后普通子进程退出；App 崩溃后 runner 留下结果；启动不确定时不会再次派发。

### P4：真实账号管理与两种适配器

依赖：P0、P3。

步骤：

1. 实现账号新增、路径选择、profile 初始化、认证检查和能力展示。
2. 根据 P0 证据实现第一种 adapter，不猜测参数。
3. 实现第二种 adapter，复用已证明共同的 runner 合同。
4. 记录实际账号、CLI 版本、模型配置和会话 ID；不支持的数据明确为空。
5. 登录和运行共用账号锁，处理失效、限流和配置变更。
6. 从 Finder 启动 App 完成真实任务，验证 PATH 与语言运行时。

交付：两种真实适配器、接入向导、账号面板和真实验证报告。

退出条件：首种三个真实账号并行且身份正确；第二种账号能运行；账号失败不换号；任何未验证隔离有明确提示。

### P5：Git 工作区与结果保存

依赖：P3；可用 mock 验证。

步骤：

1. 项目选择和 Git preflight，固定 base commit。
2. 创建运行分支和 Worktree；仓库级管理操作串行。
3. 用 fixture 测试两个 Run 修改同一文件。
4. 建立受控文件清单、Checkpoint 幂等标记、产物索引。
5. 实现失败现场展示、Review 工作区和新 generation 恢复。
6. 验证 Git hook、签名配置、空改动、路径空格、未跟踪文件。

交付：Workspace/Checkpoint 服务、真实 Git fixture 测试、产物详情。

退出条件：源工作目录不变；不同 Run 互不污染；Checkpoint 可追溯；重复 finalization 不重复提交；旧失败现场保留。

### P6：工作流引擎与返工模板

依赖：P2、P3、P5。

步骤：

1. 实现 Codable 工作流、schema 版本和验证器。
2. 实现顺序执行、条件选择、受限 RepeatBlock 和预算。
3. 实现结构化 Review、测试结果分类和人工确认记录。
4. 按第 9 节实现标准开发模板；先用 mock 控制首轮失败和第二轮通过。
5. 绑定候选 SHA、输入摘要与审批证据；修改后重新测试和 Review。
6. 使用真实 adapter 完成同样路径。

交付：可实际执行的模板、结构化结果合同、返工与审批测试。

退出条件：测试失败和 Review 拒绝分别触发正确修复；达到轮次上限停止；无效 JSON 不放行；人工批准版本不匹配不能完成。

### P7：完整恢复与故障注入

依赖：P3、P5、P6。恢复机制从 P2/P3 已开始，此阶段完成系统性覆盖。

步骤：

1. 对 prepared、starting、running、finalizing、终态提交窗口分别注入崩溃。
2. 实现重启对账、事件幂等导入、结果补记和 Checkpoint 补记。
3. 区分停止、重试、继续观察和从旧版本新建执行。
4. 模拟 PID 复用、陈旧 token、损坏 JSON、缺失产物和数据库忙。
5. 测试强制退出、睡眠唤醒、取消期间崩溃。
6. 实现恢复中心，展示未知状态和可执行操作。

交付：故障矩阵、自动测试、人工实机验收步骤和结果。

退出条件：已确认成功步骤不重跑；结果可补记；无法确认旧进程时不双开；恢复不清除失败现场。

### P8：完整 React 桌面操作界面

依赖：P4、P6、P7。

步骤：

1. 完成任务列表、状态筛选、创建表单和 Run 时间线。
2. 完成账号状态、日志、产物、Git diff、测试和 Review 页面。
3. 接入批准、驳回、取消、恢复和重新运行真实操作。
4. 做日志大文件增量读取和 UI 更新节流。
5. 完成中文状态说明、键盘操作、基础可访问性及空/错误状态。

交付：可独立使用的原生任务工作台。

退出条件：不使用终端即可操作完整任务；显示来自真实数据；大日志下窗口仍可操作；所有错误都有可理解的原因和下一步。

### P9：React Flow 工作流编辑器

依赖：P6、P8。

步骤：

1. 使用 React Flow 实现节点绘制、连线、选择、拖动、平移和缩放。
2. 实现节点参数和角色配置、受限返工块编辑。
3. 通过 Tauri Command 接入 Rust Core 的同一验证器和版本发布，不建立第二套执行定义或在前端自行判定可执行性。
4. 加载标准模板，修改、保存、重开、执行。
5. 将运行节点状态映射到对应版本，旧 Run 查看旧版本。

交付：React Flow 画布、模板编辑、版本查看与运行高亮。

退出条件：用户能在画布构建标准流程并真实运行；非法图无法发布；模板更新不改变旧 Run。

### P10：定时任务与长期目标

依赖：P6、P7、P8。

步骤：

1. 实现三种定时规则、时区、触发唯一键和漏跑记录。
2. 对调度逻辑注入时钟，测试时不用真实等待一天。
3. 实现重叠跳过、关闭期间漏跑、唤醒重算。
4. 实现目标、里程碑、关联任务、预算与暂停。
5. 实现后续任务建议的人工确认入口。

交付：定时和目标页面及边界测试。

退出条件：重复 tick 不重复创建；漏跑不集中补跑；目标预算耗尽不新派发；目标暂停后不继续启动下一步骤。

### P11：备份、清理、打包与最终验收

依赖：P0—P10 全部所需验收。

步骤：

1. 实现静止状态一致性备份，覆盖 DB、产物及恢复所需 Git 数据。
2. 在新目录恢复，验证记录、哈希、Checkpoint 和重新认证提示。
3. 实现精确清理预览，保护运行中及保留中的失败现场。
4. 使用 Tauri `externalBin` 打包 Rust runner 到 App，校验目标 triple、路径及可执行权限。
5. 从 Finder 执行完整最终演示，记录实际版本和证据。
6. 完成本地构建和安装说明；需要分发时再做 Developer ID 签名、公证和验证。

交付：可运行 `.app`、构建说明、备份恢复说明、最终验收报告。

退出条件：第 15 节全部必需项通过。没有签名凭据时交付可本地构建运行版本，明确未公证，不伪称已完成对外分发。Apple 对 Developer ID 签名和公证的要求以官方文档为准。[Apple 分发文档](https://developer.apple.com/developer-id/)

## 15. 最终验收矩阵

| 编号 | 必须验证的行为 | 类型 |
|---|---|---|
| A01 | 从 Finder 打开独立 .app；无外部浏览器操作依赖、无 HTTP 服务依赖，生产版本不依赖前端开发服务器 | 实机 |
| A02 | 同类型三个真实账号并行，身份、配置、缓存及会话不串 | 真实接入 |
| A03 | 第二种真实 Agent 可用，同一 workflow 可分配给不同类型 | 真实接入 |
| A04 | 同账号两个任务始终串行；登录不与运行竞争 | 集成 |
| A05 | 两 Run 修改同仓库同文件互不污染，源工作目录未改 | Git 集成 |
| A06 | 测试失败 → 修复 → 重测，保留各轮历史 | 集成 |
| A07 | Review 拒绝 → 修复 → 重测 → 重审；无效输出不放行 | 集成 |
| A08 | 修改候选 commit 后旧审批无效 | 集成 |
| A09 | 达到返工上限和执行预算后停止新执行 | 集成 |
| A10 | App 崩溃后 runner 可写完结果，重启不重复启动 | 故障注入 |
| A11 | result 已写 DB 未记时可补记，重复对账无重复事件 | 故障注入 |
| A12 | Git commit 已生成 DB 未记时不重复提交 | 故障注入 |
| A13 | starting 状态未知、陈旧 token 或疑似 PID 复用时不冒进 | 故障注入 |
| A14 | 取消处理进程组，未确认退出前不释放账号 | 集成/实机 |
| A15 | 认证失效和限流不静默换号，其他账号仍可运行 | 真实接入/fixture |
| A16 | 关闭窗口继续，明确退出停止，唤醒后先核对 | 实机 |
| A17 | 画布定义等于实际执行定义，非法图拒绝，旧版本不变 | UI/集成 |
| A18 | 定时唯一键、漏跑、重叠和夏令时行为符合规范 | 注入时钟 |
| A19 | 长期目标暂停与预算阻止新步骤，建议任务需确认 | 集成 |
| A20 | stdout/stderr 大量输出不死锁，UI 增量读取，无凭据泄漏 | 集成 |
| A21 | 数据库忙、磁盘满、结果损坏时不假报成功 | 故障注入 |
| A22 | 越界产物和外部符号链接被拒绝 | 集成 |
| A23 | 完整备份在新目录恢复，可定位全部结果和 Checkpoint | 实机 |
| A24 | 清理不会删除活动任务、用户源目录或仍被引用结果 | 集成 |
| A25 | 最终端到端演示包含真实账号、返工、审批及重启恢复 | 实机 |

每项结果记录：测试日期、环境、版本、输入、操作、预期、实际、日志/截图位置。截图仅作辅助，不能代替持久化记录和测试输出。

## 16. 交接格式与推进方式

`docs/STATUS.md` 使用以下格式维护：

```text
当前阶段：Pxx
已通过阶段：...
本轮目标：...
修改文件：...
验证命令/实机操作：...
验收编号与结果：...
尚未验证：...
阻塞与依据：...
下一步最小任务：...
```

每个阶段可拆成小任务，但保持统一领域模型、状态机和文件协议。不要让不同 Agent 各自重写数据库层、runner 或工作流格式。

如果使用多个实施 Agent：主负责者维护 Core 合同和最终集成；其他 Agent 只接边界清楚的模块任务，使用独立 Git Worktree。共享协议变更先同步，UI 和引擎不能各自发明状态字段。是否实际启用多 Agent 由用户和实施环境决定，本计划本身不要求立即创建团队。

阶段评审只回答四个问题：本阶段功能是否真实运行？验收证据是否齐全？是否破坏已有约束？下一阶段的前提是否成立？未通过就修复或明确报告阻塞，不转向无关功能。

## 17. 可直接发给实施 Agent 的启动指令

> 你负责实现 macOS 桌面应用 AgentFlow。完整阅读本计划，按 P0—P11 的依赖顺序推进。先检查当前仓库和 STATUS，保留已有用户修改，不重新生成已完成内容。
>
> 固定技术路线：Tauri、React + TypeScript、React Flow、Rust Core、SQLite、独立 Rust runner、文件通信、Git Worktree。生产界面使用随 App 打包的静态资源，不依赖外部浏览器、在线网站或前端开发服务器；不得引入 HTTP 后端、云服务或团队账号系统。
>
> 首先验证实际 Mac 和真实 CLI 能力，完成账号隔离和 runner 生命周期证据。缺少真实账号时继续不依赖它的 mock 和核心任务，但不能将真实接入标记完成。任何 CLI 参数和认证行为都必须核实。
>
> 每个阶段交付可运行代码、针对风险的验证和 STATUS 更新。优先完成执行、持久化和恢复闭环，再完成 React Flow 画布。不能因为画布可展示或 App 可编译就宣布完成。
>
> 保留完整执行历史和失败现场；禁止静默换账号、盲目重试未知执行、覆盖失败工作区、通过自然语言猜测 Review 成功、自动推送或合并用户代码。发生产品级约束冲突时提交具体证据和最小替代方案，不擅自改变目标。
>
> 完成条件是第 15 节的必需验收通过，并交付可从 Finder 启动的 AgentFlow.app；如缺少 macOS、真实账号或签名条件，明确区分已实现、已验证和仍被阻塞的部分。
