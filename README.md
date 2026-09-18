# AgentFlow

AgentFlow 是一个本地 macOS Agent 工作台。当前工程采用 Tauri 2、React、TypeScript 和 Rust；生产前端作为静态资源嵌入 `.app`，不依赖外部浏览器或 HTTP 后端。

## 当前结构

- `src/`：React 界面与受限 Tauri Command 客户端。
- `src-tauri/`：桌面生命周期和显式业务命令。
- `crates/agentflow-core/`：领域状态、SQLite 存储、runner 调度、Git Worktree/Checkpoint 与工作流验证器。
- `crates/agentflow-mock-cli/`：成功、失败、延迟、无效输出、子进程和大日志 fixture。
- `crates/agentflow-runner/`：独立 CLI 执行进程。
- `docs/STATUS.md`：已验证能力、阻塞与下一步。

React 不直接执行 shell、操作 Git 或写执行状态。工作流发布与执行合法性由 Rust Core 校验；runner 只通过版本化文件协议写入自己的 Attempt 目录。

## 本地构建

要求 macOS 14 或更高版本、Rust stable、Node.js、npm、Git 和 Apple Command Line Tools。

```sh
npm install
npm run typecheck
npm run build
cargo test --workspace
cargo build -p agentflow-runner -p agentflow-mock-cli
scripts/verify-runner.sh target/debug/agentflow-runner target/debug/agentflow-mock-cli
cargo run -p agentflow-core --example verify_scheduler -- \
  "$PWD/target/debug/agentflow-runner" \
  "$PWD/target/debug/agentflow-mock-cli"
cargo run -p agentflow-core --example verify_workflow -- \
  "$PWD/target/debug/agentflow-runner" \
  "$PWD/target/debug/agentflow-mock-cli"
npm run tauri build -- --debug --bundles app
open target/debug/bundle/macos/AgentFlow.app
```

`verify_workflow` 使用 mock Agent 输出、真实独立进程和 Git Checkpoint 验证多步持久化、自动测试/Review 返工、逐候选隔离 Review、人工批准和取消。自动执行目前支持标准 mock 模板；Tauri 业务命令已接通，React 操作界面与真实 Agent 接入仍在实施。

生成 release App 使用：

```sh
npm run tauri build -- --bundles app
```

当前机器的 Rust 1.97/macOS 27 组合在 release 编译 Tauri 的 proc-macro 依赖时出现 `E0463`；debug `.app` 已构建并启动成功，release 状态不能据此视为通过。详见 [`docs/STATUS.md`](docs/STATUS.md)。
