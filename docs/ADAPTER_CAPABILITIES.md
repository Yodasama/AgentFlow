# Agent CLI 能力矩阵

探测日期：2026-09-17

## 环境

| 项目 | 实际值 | 验证状态 |
|---|---|---|
| macOS | 27.0（26A428） | 已探测 |
| CPU | arm64 | 已探测 |
| Rust | rustc 1.97.0，aarch64-apple-darwin | 已探测 |
| Node.js / npm | Node 24.18.0 / npm 11.16.0 | 已探测 |
| Tauri CLI | 2.11.4，版本由 `package-lock.json` 锁定 | debug App 已构建 |
| Xcode | 未安装或未被 `xcode-select` 选中 | 当前不阻塞 Tauri debug App；签名、公证待验证 |
| Git | 2.51.0 | 已探测 |

## Codex CLI

| 能力 | 证据 | 状态 |
|---|---|---|
| 可执行路径 | `/Users/yida/.local/bin/codex`，指向 standalone 安装 | 已探测 |
| 版本 | `codex-cli 0.146.0` | 已探测 |
| 当前认证 | `codex login status` 返回 `Logged in using ChatGPT` | 单账号已探测 |
| 非交互执行 | `codex exec` 子命令存在 | 仅命令接口已确认，未真实执行 |
| 结构化事件 | `codex exec --json` 声明输出 JSONL | 仅帮助文本确认，schema 未验证 |
| 结构化最终输出 | `codex exec --output-schema <FILE>` | 仅帮助文本确认 |
| profile 配置 | `-p` 从 `$CODEX_HOME/<name>.config.toml` 加载 | 仅帮助文本确认 |
| 独立认证存储 | 帮助文本表明认证使用 `CODEX_HOME` | 未验证 Keychain、socket 或 daemon 行为 |
| 身份查询 | `login status` 只返回登录方式 | 未找到可验证账号身份的证据 |
| 三账号并行隔离 | 尚无三套测试账号/profile | 未验证 |
| 取消与进程组 | 尚未进行真实运行 | 未验证 |
| 会话恢复 | CLI 提供 `exec resume` | 能力存在，隔离与行为未验证 |

探测期间出现“无法创建 PATH aliases”的权限警告，不影响 `--help` 和登录状态读取；是否影响独立 profile 需要后续验证。

## 第二种 Agent CLI

在当前非交互 PATH 中未发现 `claude`、`gemini` 或 `opencode`。尚未由用户指定第二种 CLI 名称、安装路径或测试账号，因此全部能力保持未验证。

## 后续真实验证所需输入

1. 首种 CLI 的三套可用于验证的账号，并由用户完成各 profile 的供应商登录流程。
2. 第二种 CLI 的名称、绝对安装路径和至少一套测试账号。
3. 允许执行的无破坏、低成本身份标记任务及测试工作目录。
4. 若 CLI 使用代理或额外工具链，提供需要显式传入的环境变量名称；不需要向实现过程提供明文凭据。
