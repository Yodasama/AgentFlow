import { useEffect, useState, useCallback } from "react";
import {
  getRun,
  cancelRun,
  createMockTask,
  getAttemptLogs,
  listCheckpoints,
  getCheckpointDiff,
  type RunDetail,
  type RunSummary,
  type RunState,
  type AttemptLogs,
  type CheckpointRecord,
  type DevelopmentRunSnapshot,
} from "./api";
import { DevelopmentDetails } from "./DevelopmentDetails";

interface Props {
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onApproval: (snapshot: DevelopmentRunSnapshot, decision: "approved" | "rejected", comment: string) => Promise<void>;
  busy: boolean;
  onRefresh: () => Promise<void>;
}

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待处理",
  interrupted: "已中断",
  succeeded: "已成功",
  failed: "已失败",
  cancelled: "已取消",
};

export function RunsView({ runs, selectedRunId, onSelectRun, onApproval, busy, onRefresh }: Props) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [logs, setLogs] = useState<AttemptLogs | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([]);
  const [activeLogTab, setActiveLogTab] = useState<"stdout" | "stderr">("stdout");
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [filterState, setFilterState] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // Git Diff Viewer state
  const [selectedCheckpointDiff, setSelectedCheckpointDiff] = useState<{ id: string; text: string } | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      const data = await getRun(runId);
      setDetail(data);
      setSelectedCheckpointDiff(null);

      if (data.attemptId) {
        setLoadingLogs(true);
        try {
          const logData = await getAttemptLogs(runId, data.attemptId);
          setLogs(logData);
        } catch {
          setLogs(null);
        } finally {
          setLoadingLogs(false);
        }
      } else {
        setLogs(null);
      }

      try {
        const cpData = await listCheckpoints(runId);
        setCheckpoints(cpData);
      } catch {
        setCheckpoints([]);
      }
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (selectedRunId) {
      void loadRunDetail(selectedRunId);
    } else if (runs[0]?.runId) {
      onSelectRun(runs[0].runId);
    }
  }, [selectedRunId, runs, onSelectRun, loadRunDetail]);

  const handleCancel = async () => {
    if (!detail) return;
    setError(null);
    try {
      await cancelRun(detail.runId);
      await onRefresh();
      await loadRunDetail(detail.runId);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRerun = async () => {
    if (!detail) return;
    setError(null);
    try {
      const newRun = await createMockTask({
        title: `[重新执行] ${detail.title}`,
        description: detail.description,
        acceptanceCriteria: detail.acceptanceCriteria,
        outcome: "succeeded",
      });
      await onRefresh();
      onSelectRun(newRun.runId);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleViewDiff = async (checkpoint: CheckpointRecord) => {
    if (selectedCheckpointDiff?.id === checkpoint.checkpointId) {
      setSelectedCheckpointDiff(null);
      return;
    }
    setLoadingDiff(true);
    try {
      const diff = await getCheckpointDiff(checkpoint.checkpointId);
      setSelectedCheckpointDiff({ id: checkpoint.checkpointId, text: diff });
    } catch (err) {
      setSelectedCheckpointDiff({ id: checkpoint.checkpointId, text: `读取 Diff 异常: ${String(err)}` });
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleCopyLogs = async () => {
    const text = activeLogTab === "stdout" ? logs?.stdout : logs?.stderr;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      // ignore
    }
  };

  const filteredRuns = runs.filter((r) => {
    if (filterState === "all") return true;
    return r.runState === filterState;
  });

  return (
    <div className="runs-view-container">
      <div className="runs-view-header">
        <div>
          <h2>运行记录与执行事实 (P8)</h2>
          <p className="subtitle">
            共 {runs.length} 条记录 · 展示 SQLite 不可变历史、Git Checkpoint 快照与独立 Runner 日志流
          </p>
        </div>
        <div className="filter-group">
          <label>状态筛选：</label>
          <select value={filterState} onChange={(e) => setFilterState(e.target.value)}>
            <option value="all">全部状态 ({runs.length})</option>
            <option value="running">运行中</option>
            <option value="waiting_input">等待处理</option>
            <option value="succeeded">已成功</option>
            <option value="failed">已失败</option>
            <option value="cancelled">已取消</option>
            <option value="interrupted">已中断</option>
          </select>
        </div>
      </div>

      {error && <p role="alert" className="error-banner">{error}</p>}

      <div className="workspace-grid">
        <section className="panel run-list">
          <div className="panel-heading">
            <h3>运行队列与记录</h3>
            <span className="count-badge">{filteredRuns.length} 项</span>
          </div>
          {filteredRuns.length === 0 ? (
            <p className="empty">暂无符合条件的运行记录。</p>
          ) : (
            filteredRuns.map((r) => (
              <button
                key={r.runId}
                className={selectedRunId === r.runId ? "run-row selected" : "run-row"}
                type="button"
                onClick={() => onSelectRun(r.runId)}
              >
                <span>
                  <strong>{r.title}</strong>
                  <small>{new Date(r.createdAt).toLocaleString()}</small>
                </span>
                <em className={`state ${r.runState}`}>{stateLabels[r.runState]}</em>
              </button>
            ))
          )}
        </section>

        <section className="panel run-detail">
          {detail ? (
            <>
              <div className="panel-heading">
                <div>
                  <h3>{detail.title}</h3>
                  <small>ID: <code>{detail.runId}</code></small>
                </div>
                <div className="detail-actions">
                  {["queued", "running", "waiting_input"].includes(detail.runState) && (
                    <button className="secondary" type="button" disabled={busy} onClick={() => void handleCancel()}>
                      取消执行
                    </button>
                  )}
                  {["succeeded", "failed", "cancelled", "interrupted"].includes(detail.runState) && (
                    <button className="secondary" type="button" disabled={busy} onClick={() => void handleRerun()}>
                      重新执行此任务
                    </button>
                  )}
                  <span className={`state ${detail.runState}`}>{stateLabels[detail.runState]}</span>
                </div>
              </div>

              {detail.waitingReason && <p role="status" className="error-banner">{detail.waitingReason}</p>}

              {detail.workflowKind === "development_workflow" && (
                <DevelopmentDetails run={detail} busy={busy} onApproval={onApproval} />
              )}

              {checkpoints.length > 0 && (
                <section className="checkpoints-section">
                  <div className="panel-heading" style={{ marginBottom: "8px" }}>
                    <h4>Git Checkpoint 快照与提交记录 ({checkpoints.length})</h4>
                    <small>不可变代码快照留痕</small>
                  </div>
                  <div className="checkpoints-list">
                    {checkpoints.map((cp) => {
                      const isShowingDiff = selectedCheckpointDiff?.id === cp.checkpointId;
                      return (
                        <div key={cp.checkpointId} className="checkpoint-container">
                          <div className="checkpoint-card">
                            <div>
                              <strong>Commit: <code>{cp.commitSha?.slice(0, 10) ?? "—"}</code></strong>
                              <span className="marker-tag">{cp.marker}</span>
                              {cp.noChanges && <span className="marker-tag" style={{ color: "#f59e0b" }}>无代码变更</span>}
                            </div>
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              <small>{new Date(cp.createdAt).toLocaleTimeString()}</small>
                              <button
                                className="secondary-sm"
                                type="button"
                                disabled={loadingDiff}
                                onClick={() => void handleViewDiff(cp)}
                              >
                                {isShowingDiff ? "收起 Diff" : "查看代码 Diff"}
                              </button>
                            </div>
                          </div>
                          {isShowingDiff && (
                            <div className="diff-viewer-panel">
                              <div className="diff-viewer-header">
                                <span>Git Commit Diff: <code>{cp.commitSha}</code></span>
                              </div>
                              <pre className="diff-content">
                                {selectedCheckpointDiff.text.split("\n").map((line, idx) => {
                                  let cls = "diff-line";
                                  if (line.startsWith("+") && !line.startsWith("+++")) cls += " add";
                                  else if (line.startsWith("-") && !line.startsWith("---")) cls += " del";
                                  else if (line.startsWith("@@")) cls += " meta";
                                  return <div key={idx} className={cls}>{line}</div>;
                                })}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="terminal-logs-section">
                <div className="terminal-header">
                  <div className="log-tabs">
                    <button
                      type="button"
                      className={activeLogTab === "stdout" ? "tab active" : "tab"}
                      onClick={() => setActiveLogTab("stdout")}
                    >
                      标准输出 (stdout.log)
                    </button>
                    <button
                      type="button"
                      className={activeLogTab === "stderr" ? "tab active" : "tab"}
                      onClick={() => setActiveLogTab("stderr")}
                    >
                      标准错误 (stderr.log)
                    </button>
                  </div>
                  <div className="log-meta">
                    <button className="secondary-sm" type="button" onClick={() => void handleCopyLogs()}>
                      {copySuccess ? "✓ 已复制到剪贴板" : "复制日志"}
                    </button>
                    <small>Attempt #{detail.attemptNumber ?? "无"}</small>
                    <button
                      className="secondary-sm"
                      type="button"
                      disabled={loadingLogs}
                      onClick={() => void loadRunDetail(detail.runId)}
                    >
                      {loadingLogs ? "刷新中…" : "刷新日志"}
                    </button>
                  </div>
                </div>

                <div className="terminal-body">
                  {loadingLogs && <p className="terminal-note">读取日志中…</p>}
                  {!loadingLogs && logs && (
                    <pre>
                      {activeLogTab === "stdout"
                        ? logs.stdout || "(暂无 stdout 输出)"
                        : logs.stderr || "(暂无 stderr 输出)"}
                    </pre>
                  )}
                  {!loadingLogs && !logs && (
                    <p className="terminal-note">该 Attempt 尚未产生日志文件或尚未派发 runner。</p>
                  )}
                </div>
              </section>

              <details className="technical-details">
                <summary>持久化元数据 (SQLite Row)</summary>
                <dl>
                  <div><dt>Task ID</dt><dd><code>{detail.taskId}</code></dd></div>
                  <div><dt>Step ID</dt><dd><code>{detail.stepExecutionId}</code></dd></div>
                  <div><dt>Attempt ID</dt><dd><code>{detail.attemptId ?? "尚未创建"}</code></dd></div>
                  <div><dt>Step 状态</dt><dd>{detail.stepState}</dd></div>
                  <div><dt>验收条件</dt><dd>{detail.acceptanceCriteria.join("；")}</dd></div>
                  <div><dt>最终结果</dt><dd className="wrap-value">{detail.result ? JSON.stringify(detail.result) : detail.errorCode ?? "无"}</dd></div>
                </dl>
              </details>
            </>
          ) : (
            <p className="empty">请选择左侧的运行记录以查看详细事实。</p>
          )}
        </section>
      </div>
    </div>
  );
}
