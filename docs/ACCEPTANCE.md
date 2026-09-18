# 验收记录

完整验收项定义见 [`AgentFlow-macOS-Implementation-Plan.md`](../AgentFlow-macOS-Implementation-Plan.md) 第 15 节。以下“部分”不能视为最终通过。

| 日期 | 编号 | 结果 | 已有证据 | 尚缺 |
|---|---|---|---|---|
| 2026-09-17 | A01 | 部分 | Tauri debug `.app` 成功打包并通过 `open` 启动；前端为 bundle 内静态资源，无 HTTP 后端 | release 包、完整 Finder 人工操作、窗口/菜单栏生命周期 |
| 2026-09-17 | A04 | 部分 | 三个不同 mock 账号可并行，两个同账号 Run 验证为一个 running/一个 queued，并串行终结 | 真实账号与登录/运行竞争 |
| 2026-09-17 | A05 | 通过 | 真实 Git fixture 中两个 Run 从同一 base 在独立 Worktree 修改同一文件并产生不同 commit；源目录的 HEAD、受跟踪文件和未跟踪现场未变 | 无 |
| 2026-09-18 | A06 | 部分 | 自动调度 fixture 构造输入并消费独立 runner 的 mock Agent 输出，SQLite Step/Attempt 与真实 Git Checkpoint 串联测试失败返工；prepared 重启保留同一 Attempt | 通用图执行、真实项目测试和真实 adapter |
| 2026-09-18 | A07 | 部分 | 自动执行第二轮 Review 拒绝、第三轮重测/重审后等待批准；每个候选使用独立 detached Review 工作区，检查 HEAD 与报告 SHA 匹配 | React 操作界面、真实 Review adapter 和完整恢复矩阵 |
| 2026-09-17 | A08 | 部分 | 候选 SHA 变更将内存状态退回 Tests；SQLite 中旧 candidate 的 Approval 转为 invalidated，不再被 `valid_approval` 返回 | App 实际候选文件变化联动 |
| 2026-09-18 | A09 | 部分 | 动作预算耗尽时事务保存 Exhausted/Run failed，不建立下一节点；永久回归测试通过 | 真实 adapter 与完整图执行预算联动 |
| 2026-09-17 | A10 | 部分 | 调度 host 在 Attempt running 时被 `SIGKILL`，runner 继续写 result；新 host 启动后导入为 succeeded，没有重复派发 | Finder App 进程强制结束的实机复验 |
| 2026-09-17 | A12 | 通过 | fixture 先生成含稳定 Attempt 标记的 commit 但不写 DB；Checkpoint 重试核对 HEAD/父 commit 后补记，HEAD 不变且没有第二个 commit | 无 |
| 2026-09-17 | A13 | 部分 | 陈旧 token 被 runner 拒绝；starting 无有效 identity/result 时转 interrupted 并保留账号/工作区锁 | PID 复用和更完整的启动窗口故障矩阵 |
| 2026-09-18 | A14 | 部分 | 活跃执行使用 token control 取消；节点间/prepared/审批等待可事务取消，取消后不能批准；未知执行保留锁并阻止同账号重新领取 | 真实 Agent CLI 退出身份复核与完整 UI 操作 |
| 2026-09-17 | A17 | 部分 | Tauri 验证与发布命令共用 Rust 定义/验证器；非法图不可发布，合法定义按 digest 不可变存储 | React Flow 编辑、重开、旧 Run 版本显示和真实运行高亮 |
| 2026-09-17 | A20 | 部分 | mock CLI 同时输出超过 500 KB stdout/stderr，runner 完成且未死锁 | 日志脱敏、增量 UI 与磁盘限额 |
| 2026-09-17 | A22 | 通过 | 受控文件验证拒绝 `..` 越界路径和指向工作区外的符号链接；只为允许根内普通文件建立产物索引 | 无 |

A02、A03 仍等待真实账号与第二种 CLI。其他最终验收项尚未开始或尚无足够证据。
