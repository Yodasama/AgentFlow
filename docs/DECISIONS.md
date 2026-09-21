# 工程决策

## D-001：桌面技术路线

- 日期：2026-09-17
- 状态：已确认
- 桌面框架：Tauri 2
- 前端：React 19 + TypeScript + Vite
- 工作流画布：React Flow（`@xyflow/react`）
- 本地核心与独立 runner：Rust
- 数据与工作区：SQLite、Git Worktree

生产前端编译为静态资源并嵌入 App，不依赖外部浏览器、在线网站或开发服务器。第一版不混用 SwiftUI/AppKit 主界面或 Swift 执行核心。

## D-002：界面与核心边界

React 只调用显式注册的 Tauri 业务命令。当前开放应用状态、创建 mock 任务、运行查询、取消和工作流验证，没有向 WebView 暴露任意 shell 或任意文件访问入口。

聊天 CLI 同样使用业务请求边界：界面只传 provider ID、prompt、模型、推理档位与工作区。Rust 选择已知二进制和账号 HOME，校验 canonical 工作区与模型白名单，并添加固定沙箱参数。禁止界面传入 executable、参数数组、任意终端命令或绕过权限/沙箱开关。

工作流定义由 Rust Core 持有并验证，React Flow 后续只编辑和展示同一份定义。Tauri Events 只用于刷新提示，不能代替数据库状态与事件记录。

## D-003：runner 协议

- runner 文件协议 `schemaVersion` 为 1。
- `LaunchManifest` 使用参数数组和显式环境，不接受拼接 shell 命令。
- stdout、stderr 直接写文件；identity、heartbeat 和 result 原子替换。
- 每个 Attempt 使用独占文件锁。
- 子进程在 `exec` 前通过 `setpgid` 建立独立进程组。
- 取消请求必须匹配协议版本、Attempt ID 和 execution token。
- 取消和超时先发送 `SIGTERM`，宽限期后发送 `SIGKILL`。

这些是 P0/P3 的共同协议起点；PID 启动时间核验、磁盘满处理、日志脱敏和完整恢复矩阵仍待后续阶段实现。

## D-004：真实 CLI 接入

当前只发现 Codex CLI。第二种 CLI、三套同类账号和独立 profile 尚未提供，因此先保留 adapter 边界，不选择或伪造第二供应商。真实账号验证仍是 P0/P4 和最终验收的必需项。

## D-004A：用量统计真实性边界

Codex 的账户 Token 汇总和每日分桶只读取官方 `codex app-server` 的 `account/usage/read`，额度窗口、重置时间与 Credits 只读取 `account/rateLimits/read`。不以字符数近似 Token，不从会话记录反推账户配额，不设置猜测性的总额度。供应商未提供可验证接口时显示“不可用”，不得用 0 或 100% 冒充真实余额。官方接口未提供逐次 Prompt/Completion 明细，因此界面不展示伪造的最近执行明细。

agy 通过 `--output-format json` 返回每次执行的 input、output、thinking、cache read 和 total Token。Rust 只在 `status=SUCCESS` 且 JSON schema 有效时把原始数值写入 AgentFlow SQLite；失败或格式变化不能生成统计记录。5 小时和每周剩余百分比及重置时间只读取 agy 官方只读 `/usage` 的结构化 `command.data.groups[].buckets[]`，按 Gemini 与 Claude/GPT 两个共享配额组展示，不从 Token 数反推。

## D-005：当前 macOS 构建能力

本机 Rust、Node 与 Command Line Tools 足以生成可从 LaunchServices/Finder 启动的 Tauri debug `.app`，不要求先安装完整 Xcode。当前 Rust 1.97 在 release 编译 Tauri 依赖的 proc-macro 时出现 `E0463`，而同一依赖图的 debug 编译与测试通过；release 分发包保持未验证。Developer ID 签名和公证仍需相应 Apple 工具与凭据。

## D-006：P2 SQLite 存储边界

- 使用 `rusqlite` 0.40.2，链接系统 SQLite，不引入 ORM 或 bundled SQLite。
- Tauri 和调度线程共享一个 `Arc<Mutex<Storage>>`，所有写入通过单连接串行执行。
- 连接启用 foreign keys、WAL、`synchronous=NORMAL` 和 5 秒 busy timeout。
- migration 使用 `schema_migrations`，在 `IMMEDIATE` 事务内应用。
- 状态更新使用旧状态条件更新；状态变化和结构化事件在同一事务内提交。
- StepExecution、Attempt 与账号/工作区资源锁在同一事务内创建。
- React 只使用显式业务命令，不直接访问 SQLite。

## D-007：P3 调度与恢复边界

- Run 先持久化为 `queued`，调度器在 `IMMEDIATE` 事务内创建 Attempt、获取账号/工作区锁并转为 `running`。
- 候选按 `created_at, id` FIFO 选取；全局默认最多 3 个活动 Attempt，同账号由持久锁串行。
- App 在派发前原子写 `launch.json`，再将 Attempt 记为 `starting`，最后启动独立 runner。
- runner result 与 stdout 结构化结果同时校验；退出码 0 但输出无效也不能记为成功。
- 终态、Step/Run 结果、结果事件和锁释放在同一事务中；重复导入终态结果为幂等无操作。
- 启动对账只重新派发可证明未启动的 `prepared`。无有效 identity/result 的未知执行记为 `interrupted` 且保留资源锁，不自动重跑。
- 数据目录使用独占文件锁防止两个 App Core 同时调度。

## D-008：P5 Git 工作区与 Checkpoint

- 项目路径在 Rust Core 中 canonicalize，通过 `git rev-parse` 记录源仓库根目录、common directory 和固定 base SHA。源仓库存在未提交修改只记录提示，不 stash、不提交、不混入 Worktree。
- 每个 Run 使用 `agentflow/<run-id>` 分支和 `workspaces/<run-id>/generation-1`；恢复 generation 使用新分支/目录，旧工作区保留。
- Checkpoint 仅对通过路径和符号链接检查的显式受控文件执行 `git add -- <paths>`，不使用 `git add -A`。已有非本次 staged 内容时拒绝继续。
- 内部 commit 仅在当次 Git 命令中设置 `core.hooksPath=/dev/null`、`commit.gpgSign=false` 和专用身份，不修改用户仓库/全局配置。
- commit message 包含稳定 `AgentFlow-Attempt` 标记。重试先查数据库，再核对 HEAD 标记；支持“commit 已生成、DB 未记录”的补记，不重复 commit。
- 无受控文件变化时记录 no-change Checkpoint 并复用 HEAD，不制造空 commit。Review 使用候选 commit 的 detached Worktree。
- 产物索引保存相对路径、大小和 Git blob hash；越界路径与外部符号链接在核心层拒绝。

## D-009：P6 工作流定义与完成契约

- 工作流 schema 版本为 1，节点版本为 1。执行语义包含节点/边、角色账号绑定、必需输入、声明式条件、预置 Command、RepeatBlock 和预算；不包含画布坐标。
- Condition/HumanApproval 只比较结构化字段，不执行用户 JavaScript。非默认边必须有 predicate，分支必须且只能有一条默认边。
- 任意环被拒绝。合法环必须属于不重叠的 RepeatBlock，声明唯一入口、唯一出口、唯一回边和预算内最大轮次。
- 发布前只使用 Rust 同一验证器。通过验证的定义以 SHA-256 digest 写入不可变 `workflow_versions`；相同定义重复发布复用同一版本。
- 测试结果显式区分 `passed / failed / infrastructure_error`。Review 只接受严格结构化合同；解析失败、SHA 不匹配、approved 却含 blocking finding 均不放行。
- 人工批准同时绑定 candidate commit 和 workflow digest。候选 SHA 变化时持久化批准标记失效，新候选必须重新测试、Review 和批准。
