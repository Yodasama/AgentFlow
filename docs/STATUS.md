# 实施状态

当前阶段：P6 进行中；P0/P4 真实接入仍等待账号与第二种 CLI。

已验证基础能力：P2 持久化与 mock 单步闭环、P3 独立 runner/调度/初版对账、P5 Git Worktree/Checkpoint/产物索引。现有测试仅证明各自覆盖的场景，尚不足以代表 P3/P5 全部可靠性验收完成。P1 的可启动骨架已通过，菜单栏、明确退出和 release 构建仍作为收尾项保留。

## P6 已完成的子项

- 扩展版本化工作流定义：角色绑定、必需输入、预置 Command、声明式条件、RepeatBlock 和执行预算。
- Rust 验证器拒绝无账号角色、无默认边、缺必需输入、悬空边、任意环、嵌套/超预算返工和不支持的节点版本。
- SQLite migration v3 增加不可变 `workflow_versions` 和绑定 candidate/workflow digest 的 `approvals`。Tauri 只暴露标准模板、验证和发布业务命令。
- 标准开发模板与 DevelopmentLoop 状态机实现测试失败、Review 拒绝、人工拒绝的受限返工，区分测试 infrastructure error。
- 测试、Review 和人工批准都校验当前 candidate SHA；批准额外校验 workflow digest。无效 JSON 不放行，候选变更后旧批准失效。

- 多步节点以事务领取 Attempt、账号/工作区锁，并保存完整启动合同；账号读取 Run 的角色绑定快照。调度器使用持久化合同派发独立 runner。
- 成功的节点结果先持久化，保留资源锁；编排器验证结果后，在同一事务结束 Step、推进状态、建立下一 Step 并释放锁。开发节点必须关联该 Attempt 的 Checkpoint SHA。
- `verify_workflow` fixture 通过真实 runner/进程、SQLite 和 Git 串联分析、测试失败返工、Review 拒绝返工、三轮 Checkpoint 和人工批准；调度 host 在结果落库后被 SIGKILL，重开数据库可接续节点。
- 回归测试修复多步 Run 重复列出/详情选错节点，以及动作预算耗尽后仍创建下一节点的问题。
- 新增自动 mock 编排循环：持久化执行配置后，由调度器构造节点输入、消费 runner 结果、创建 Checkpoint 并推进返工，停在人工审批。明确拒绝非 mock 账号和非标准模板，不静默替换真实适配器。
- Review 按 Checkpoint 创建独立 detached 工作区，保留旧候选现场。SQLite migration v4 保留旧工作区/Checkpoint 引用，移除“同 generation 只能一个 Review”的限制；迁移外键检查失败会回滚。
- 节点之间、prepared 阶段和等待审批时可取消；状态未知的执行不释放锁。Tauri 增加创建 mock 开发任务、读取开发状态、提交审批的业务命令，TypeScript 客户端类型同步。

P6 尚缺：自动执行当前仅支持固定标准模板，需要统一通用图定义与执行路径，接入真实 adapter，补齐候选文件变化检测和故障恢复。App 后端命令已接通，React 创建/审批界面尚未完成；当前不将 P6 标记为完成。

## P5 已实现

- Git preflight 记录 canonical 源仓库、common directory、固定 base SHA 和源目录 dirty 提示。
- 每 Run/每 generation 创建独立分支和 Worktree，仓库管理命令在 Core 内串行。
- Checkpoint 显式提交受控文件，禁用 hook/交互签名，支持空改动和 commit/DB 窗口幂等补记。
- SQLite migration v2 增加 `projects`、`workspaces`、`checkpoints`、`artifacts`，保存可追溯 SHA、受控文件、大小和 hash。
- Review 使用 detached Worktree；恢复创建新 generation，旧工作区与失败现场保留。
- 越界路径、外部符号链接、非本次 staged 内容被核心层拒绝。

## P3 已实现

- mock Run 从同步伪执行改为 `queued`，由后台调度器调用独立 `agentflow-runner`。
- Attempt 领取、账号/工作区锁和 Run/Step 状态在 SQLite `IMMEDIATE` 事务中原子提交。
- 实现 FIFO、全局并发上限 3、同账号串行、超时和 token 校验取消。
- 实现 identity/result 导入、stdout 结构校验、终态幂等和终态后事务化释放资源锁。
- 实现 App 数据目录单实例锁。启动时只重新派发 `prepared`；不确定状态转 `interrupted` 并保留锁。
- React 每 750 ms 从持久化数据刷新 Run，显示 queued/running/终态并可调用显式取消命令。
- debug App 同时打包 runner 和 mock CLI，不向 WebView 暴露 shell 或任意文件接口。

## 验证证据

- 本轮 workspace 测试通过（当时 Core 30 项、mock CLI 4 项）；后续增加取消锁与迁移回滚测试后，Core 32 项全部通过。TypeScript 类型检查通过。
- `verify_workflow` 增加自动执行场景：prepared 重启后保持同一 Attempt，自动完成测试返工/Review 返工，逐候选隔离 Review，重开数据库保留审批等待；分别验证批准成功和取消后拒绝批准。工作流 fixture 使用明确标识的 mock 输出，不代表真实模型开发或真实项目测试已验收。

以下记录包含前轮 App 打包/UI 证据，本轮没有重新打包或操作 App 窗口。

- `cargo test --workspace`：通过，Core 25 个、mock CLI 4 个测试通过。Git fixture 覆盖两 Run 同文件隔离、路径空格、未跟踪文件、失败 hook、强制签名配置、空改动、Review 和新 generation；Workflow fixture 覆盖测试失败/修复/重测、Review 返工、批准、候选变更和轮次上限。
- `cargo fmt --all -- --check`：通过。
- `npm run typecheck` 和 `npm run build`：通过。
- `scripts/verify-runner.sh target/debug/agentflow-runner target/debug/agentflow-mock-cli`：通过父进程退出、进程组取消、陈旧 token、非零退出、无效 JSON 和双流大日志。
- `cargo run -p agentflow-core --example verify_scheduler -- <runner> <mock-cli>`：通过三账号并行、同账号串行、取消、失败和调度 host `SIGKILL` 后结果补记。
- `npm run tauri build -- --debug --bundles app`：通过；`Contents/MacOS` 包含 `agentflow-app`、`agentflow-runner` 和 `agentflow-mock-cli`。
- 新 App 通过 LaunchServices `open` 启动，SQLite 和调度线程均正常存活。验证时 macOS 处于锁屏，本轮无法完成可视窗口点击；上一版 P2 已有界面点击证据。
- `cargo clippy --workspace --all-targets -- -D warnings`：未执行，当前 Rust toolchain 未安装 Clippy component。

## 尚未完成

- Codex 独立 profile、身份确认、三真实账号并行，以及第二种真实 Agent CLI。
- 菜单栏、关闭窗口继续执行、明确退出停止的完整桌面生命周期。
- release App、Developer ID 签名、公证和外部分发。
- 完整工作流/返工/审批、系统化故障恢复、完整 UI/React Flow、定时/长期目标、备份恢复。

## 阻塞

- 缺少三套同类测试账号和第二种 CLI 输入，P0/P4 真实接入退出条件未满足，但不阻塞 P5/P6 的 mock 实现。
- Rust 1.97/macOS 27 下 release 编译 Tauri 依赖时，`zerofrom` 无法载入 `zerofrom_derive` proc-macro（`E0463`）；debug workspace、runner 和 App 均可构建运行。

下一步：完成 React 中的 mock 工作流创建/进度/审批入口，并继续补齐通用图执行、候选版本变化与恢复路径；真实账号验收仍独立保留。
