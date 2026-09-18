import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  cancelRun,
  createMockTask,
  createMockDevelopmentTask,
  submitDevelopmentApproval,
  getAppStatus,
  getRun,
  listRuns,
  type AppStatus,
  type CreateMockTaskRequest,
  type DevelopmentRunSnapshot,
  type RunDetail,
  type RunState,
  type RunSummary,
} from "./api";
import { DevelopmentDetails } from "./DevelopmentDetails";
import { TasksView } from "./TasksView";
import { RunsView } from "./RunsView";
import { AccountsView } from "./AccountsView";
import { WorkflowEditor } from "./WorkflowEditor";
import { SchedulesView } from "./SchedulesView";
import { GoalsView } from "./GoalsView";

const navigation = ["总览", "任务", "运行记录", "Agent 账号", "工作流", "定时任务", "长期目标"];

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待处理",
  interrupted: "已中断",
  succeeded: "已成功",
  failed: "已失败",
  cancelled: "已取消",
};

const initialRequest: CreateMockTaskRequest = {
  title: "验证本地执行闭环",
  description: "通过独立 runner 执行 mock Agent，并在应用重启后继续显示结果。",
  acceptanceCriteria: ["runner 独立执行", "Run 和 Attempt 持久化", "终态与事件保持一致"],
  outcome: "succeeded",
};

function App() {
  const [activeTab, setActiveTab] = useState<string>("总览");
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null);
  const [request, setRequest] = useState(initialRequest);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskMode, setTaskMode] = useState<"single" | "development">("development");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [scenario, setScenario] = useState<"pass" | "test_then_review_retry">("test_then_review_retry");
  const selectedIdRef = useRef<string | null>(null);

  const loadSelectedRun = useCallback(async (runId: string) => {
    try {
      const detail = await getRun(runId);
      if (selectedIdRef.current === runId) setSelectedRun(detail);
    } catch (err) {
      // ignore
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const [items, appStatus] = await Promise.all([listRuns(), getAppStatus()]);
      setRuns(items);
      setStatus(appStatus);
      const selectedId = selectedIdRef.current ?? items[0]?.runId;
      if (selectedId) {
        selectedIdRef.current = selectedId;
        await loadSelectedRun(selectedId);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [loadSelectedRun]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await refreshRuns();
      } catch (reason) {
        if (active) setError(String(reason));
      }
      if (active) timer = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refreshRuns]);

  const submitTask = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created =
        taskMode === "development"
          ? await createMockDevelopmentTask(request, repositoryPath.trim(), scenario)
          : await createMockTask(request);
      selectedIdRef.current = created.runId;
      await loadSelectedRun(created.runId);
      setShowCreate(false);
      await refreshRuns();
      setActiveTab("运行记录");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectRun = async (runId: string) => {
    selectedIdRef.current = runId;
    setSelectedRun(null);
    setError(null);
    try {
      await loadSelectedRun(runId);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const cancelSelectedRun = async () => {
    if (!selectedRun) return;
    setBusy(true);
    setError(null);
    try {
      await cancelRun(selectedRun.runId);
      await refreshRuns();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitApproval = async (
    snapshot: DevelopmentRunSnapshot,
    decision: "approved" | "rejected",
    comment: string
  ) => {
    if (!snapshot.flow.candidateCommit) return;
    setBusy(true);
    setError(null);
    try {
      await submitDevelopmentApproval(snapshot.runId, {
        schemaVersion: 1,
        candidateCommit: snapshot.flow.candidateCommit,
        workflowDigest: snapshot.flow.workflowDigest,
        decision,
        comment,
      });
      await refreshRuns();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const succeeded = runs.filter((run) => run.runState === "succeeded").length;
  const failed = runs.filter((run) => run.runState === "failed").length;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AF</span>
          <div>
            <strong>AgentFlow</strong>
            <small>本地 Agent 工作台</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              className={activeTab === item ? "active" : ""}
              key={item}
              type="button"
              onClick={() => setActiveTab(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <button className="settings" type="button" onClick={() => setShowSettings(true)}>
          设置与核心环境
        </button>
      </aside>

      <main>
        {activeTab === "总览" && (
          <>
            <header>
              <div>
                <p className="eyebrow">WORKSPACE OVERVIEW</p>
                <h1>执行事实，留在本机。</h1>
                <p className="subtitle">本地独立 runner 驱动、SQLite 不可变存储与 Git Worktree 隔离开发闭环。</p>
              </div>
              <button className="primary" type="button" onClick={() => setShowCreate((value) => !value)}>
                {showCreate ? "收起" : "创建 Mock 任务"}
              </button>
            </header>

            {showCreate && (
              <form className="create-panel" onSubmit={submitTask}>
                <label>
                  演示类型
                  <select
                    disabled={busy}
                    value={taskMode}
                    onChange={(event) => setTaskMode(event.target.value as typeof taskMode)}
                  >
                    <option value="development">开发工作流（分析、开发、测试、Review 与审批）</option>
                    <option value="single">单步运行</option>
                  </select>
                </label>
                <label className="wide">
                  任务名称
                  <input
                    required
                    disabled={busy}
                    value={request.title}
                    onChange={(event) => setRequest({ ...request, title: event.target.value })}
                  />
                </label>
                <label className="wide">
                  任务描述
                  <textarea
                    required
                    disabled={busy}
                    rows={3}
                    value={request.description}
                    onChange={(event) => setRequest({ ...request, description: event.target.value })}
                  />
                </label>
                <label className="wide">
                  验收条件（每行一条）
                  <textarea
                    disabled={busy}
                    rows={3}
                    value={request.acceptanceCriteria.join("\n")}
                    onChange={(event) =>
                      setRequest({ ...request, acceptanceCriteria: event.target.value.split("\n") })
                    }
                  />
                </label>
                {taskMode === "development" ? (
                  <>
                    <label className="wide">
                      本地 Git 仓库路径
                      <input
                        required
                        disabled={busy}
                        spellCheck={false}
                        placeholder="/Users/你的用户名/Projects/示例仓库"
                        value={repositoryPath}
                        onChange={(event) => setRepositoryPath(event.target.value)}
                      />
                    </label>
                    <p className="wide demo-note">
                      演示会在独立工作区修改 agentflow-fixture.txt，创建本地 Checkpoint；不会提交或合并到源工作目录。
                    </p>
                    <label className="wide">
                      演示场景
                      <select
                        disabled={busy}
                        value={scenario}
                        onChange={(event) => setScenario(event.target.value as typeof scenario)}
                      >
                        <option value="test_then_review_retry">首轮测试失败 → Review 返工 → 等待批准</option>
                        <option value="pass">测试与 Review 通过 → 等待批准</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <label>
                    模拟结果
                    <select
                      disabled={busy}
                      value={request.outcome}
                      onChange={(event) =>
                        setRequest({ ...request, outcome: event.target.value as CreateMockTaskRequest["outcome"] })
                      }
                    >
                      <option value="succeeded">成功</option>
                      <option value="failed">失败</option>
                    </select>
                  </label>
                )}
                <button className="primary" disabled={busy} type="submit">
                  {busy ? "创建中…" : "创建并排队"}
                </button>
              </form>
            )}

            <section className="metrics" aria-label="运行概览">
              <article>
                <span>运行记录</span>
                <strong>{runs.length}</strong>
                <small>SQLite 最近记录</small>
              </article>
              <article>
                <span>已成功</span>
                <strong>{succeeded}</strong>
                <small>通过状态机终结</small>
              </article>
              <article>
                <span>已失败</span>
                <strong>{failed}</strong>
                <small>失败记录不会被覆盖</small>
              </article>
              <article>
                <span>数据库</span>
                <strong>{status?.databaseReady ? "✓" : "—"}</strong>
                <small>{status?.databaseReady ? "WAL 已启用" : "核对中"}</small>
              </article>
            </section>

            {error && <p role="alert" className="error-banner">{error}</p>}

            <div className="workspace-grid">
              <section className="panel run-list">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">HISTORY</p>
                    <h2>最近运行</h2>
                  </div>
                </div>
                {runs.length === 0 ? (
                  <p className="empty">创建第一个 mock 任务以验证持久化闭环。</p>
                ) : (
                  runs.slice(0, 8).map((run) => (
                    <button
                      className={selectedRun?.runId === run.runId ? "run-row selected" : "run-row"}
                      key={run.runId}
                      onClick={() => void selectRun(run.runId)}
                      type="button"
                    >
                      <span>
                        <strong>{run.title}</strong>
                        <small>{new Date(run.createdAt).toLocaleString()}</small>
                      </span>
                      <em className={`state ${run.runState}`}>{stateLabels[run.runState]}</em>
                    </button>
                  ))
                )}
              </section>

              <section className="panel run-detail">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">RUN DETAIL</p>
                    <h2>执行证据</h2>
                  </div>
                  {selectedRun && (
                    <div className="detail-actions">
                      {["queued", "running", "waiting_input"].includes(selectedRun.runState) && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => void cancelSelectedRun()}
                          type="button"
                        >
                          取消执行
                        </button>
                      )}
                      <span className={`state ${selectedRun.runState}`}>{stateLabels[selectedRun.runState]}</span>
                    </div>
                  )}
                </div>
                {selectedRun ? (
                  <>
                    {selectedRun.waitingReason && <p role="status" className="error-banner">{selectedRun.waitingReason}</p>}
                    {selectedRun.workflowKind === "development_workflow" && (
                      <DevelopmentDetails
                        key={selectedRun.runId}
                        run={selectedRun}
                        busy={busy}
                        onApproval={submitApproval}
                      />
                    )}
                    <details
                      className="technical-details"
                      open={selectedRun.workflowKind !== "development_workflow"}
                    >
                      <summary>执行记录与原始结果</summary>
                      <dl>
                        <div>
                          <dt>Run ID</dt>
                          <dd>{selectedRun.runId}</dd>
                        </div>
                        <div>
                          <dt>Attempt</dt>
                          <dd>
                            {selectedRun.attemptNumber === null
                              ? "尚未派发"
                              : `#${selectedRun.attemptNumber} · ${selectedRun.attemptState}`}
                          </dd>
                        </div>
                        <div>
                          <dt>Step</dt>
                          <dd>{selectedRun.stepState}</dd>
                        </div>
                        <div>
                          <dt>验收条件</dt>
                          <dd>{selectedRun.acceptanceCriteria.join("；")}</dd>
                        </div>
                        <div>
                          <dt>结果</dt>
                          <dd className="wrap-value">
                            {selectedRun.result
                              ? JSON.stringify(selectedRun.result)
                              : selectedRun.errorCode ?? "无"}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </>
                ) : (
                  <p className="empty">选择一个 Run 查看持久化详情。</p>
                )}
              </section>
            </div>

            <section className="panel core-status">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">LOCAL CORE</p>
                  <h2>桌面核心状态</h2>
                </div>
                <span className={status ? "status ready" : "status"}>{status ? "已连接" : "核对中"}</span>
              </div>
              {status && (
                <dl>
                  <div>
                    <dt>协议版本</dt>
                    <dd>v{status.protocolVersion}</dd>
                  </div>
                  <div>
                    <dt>数据目录</dt>
                    <dd>{status.dataDirectory}</dd>
                  </div>
                  <div>
                    <dt>独立 runner</dt>
                    <dd>{status.runnerBundled ? "已就绪" : "未找到"}</dd>
                  </div>
                  <div>
                    <dt>调度器</dt>
                    <dd>{status.schedulerError ?? "正常"}</dd>
                  </div>
                </dl>
              )}
            </section>
          </>
        )}

        {activeTab === "任务" && (
          <TasksView
            runs={runs}
            onSelectRun={(id) => {
              void selectRun(id);
              setActiveTab("运行记录");
            }}
            onRefresh={refreshRuns}
            busy={busy}
          />
        )}

        {activeTab === "运行记录" && (
          <RunsView
            runs={runs}
            selectedRunId={selectedRun?.runId ?? null}
            onSelectRun={selectRun}
            onApproval={submitApproval}
            busy={busy}
            onRefresh={refreshRuns}
          />
        )}

        {activeTab === "Agent 账号" && <AccountsView />}

        {activeTab === "工作流" && (
          <WorkflowEditor
            onLaunchTask={(id) => {
              void selectRun(id);
              setActiveTab("运行记录");
            }}
          />
        )}

        {activeTab === "定时任务" && (
          <SchedulesView
            onTriggerRun={(id) => {
              void selectRun(id);
              setActiveTab("运行记录");
            }}
            onRefresh={refreshRuns}
          />
        )}

        {activeTab === "长期目标" && <GoalsView />}
      </main>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>AgentFlow 设置与诊断</h3>
              <button className="close-btn" type="button" onClick={() => setShowSettings(false)}>
                ✕
              </button>
            </div>
            <dl>
              <div>
                <dt>应用名称</dt>
                <dd>{status?.appName ?? "AgentFlow"}</dd>
              </div>
              <div>
                <dt>通信协议版本</dt>
                <dd>Runner Protocol v{status?.protocolVersion ?? 1}</dd>
              </div>
              <div>
                <dt>数据存储目录</dt>
                <dd className="wrap-value">{status?.dataDirectory ?? "加载中…"}</dd>
              </div>
              <div>
                <dt>独立 Runner 二进制</dt>
                <dd>{status?.runnerBundled ? "已就绪 (独立进程组驱动)" : "未找到"}</dd>
              </div>
              <div>
                <dt>调度器状态</dt>
                <dd>{status?.schedulerError ? `异常: ${status.schedulerError}` : "正常调度运行中"}</dd>
              </div>
              <div>
                <dt>数据库连接</dt>
                <dd>{status?.databaseReady ? "SQLite 3 WAL 模式已就绪" : "连接中…"}</dd>
              </div>
            </dl>
            <div className="modal-actions" style={{ marginTop: "20px" }}>
              <button className="primary" type="button" onClick={() => setShowSettings(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
