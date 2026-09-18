import { useEffect, useState, useCallback } from "react";
import {
  listSchedules,
  saveSchedule,
  toggleSchedule,
  deleteSchedule,
  createMockTask,
  type ScheduleRecord,
} from "./api";

interface Props {
  onTriggerRun: (runId: string) => void;
  onRefresh: () => Promise<void>;
}

interface ScheduleLogRecord {
  scheduleId: string;
  triggeredAt: string;
  runId: string;
  status: "succeeded" | "failed";
  durationSeconds: number;
  outputSummary: string;
  errorMessage?: string;
}

export function SchedulesView({ onTriggerRun, onRefresh }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // New Schedule Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("0 2 * * * (每日凌晨 02:00)");
  const [scheduleContent, setScheduleContent] = useState("");
  const [targetNode, setTargetNode] = useState("自动化测试节点");
  const [supportedFunction, setSupportedFunction] = useState("全量回归与代码安全扫描");

  // Detail / Edit Modal
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduleRecord | null>(null);
  const [detailTab, setDetailTab] = useState<"edit" | "logs">("edit");
  const [editCron, setEditCron] = useState("");
  const [editTargetNode, setEditTargetNode] = useState("");
  const [editName, setEditName] = useState("");

  // Simulated / Persisted Execution Logs
  const [executionLogs, setExecutionLogs] = useState<Record<string, ScheduleLogRecord[]>>(() => {
    try {
      const saved = localStorage.getItem("agentflow_schedule_logs_v1");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const loadSchedules = useCallback(async () => {
    try {
      const list = await listSchedules();
      setSchedules(list);
    } catch (err) {
      setMessage(`加载定时任务失败: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const saveLogsToStorage = (updated: Record<string, ScheduleLogRecord[]>) => {
    setExecutionLogs(updated);
    localStorage.setItem("agentflow_schedule_logs_v1", JSON.stringify(updated));
  };

  const handleToggle = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBusy(true);
    try {
      await toggleSchedule(id);
      await loadSchedules();
    } catch (err) {
      setMessage(`切换状态失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBusy(true);
    try {
      await deleteSchedule(id);
      await loadSchedules();
      if (selectedSchedule?.id === id) setSelectedSchedule(null);
      setMessage("定时任务已从数据库移除。");
    } catch (err) {
      setMessage(`删除失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleTriggerNow = async (sched: ScheduleRecord, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBusy(true);
    setMessage(null);
    try {
      const isSimulatedFail = sched.name.includes("压力测试");
      const run = await createMockTask({
        title: `[定时触发] ${sched.name}`,
        description: `时间规格：${sched.cron} · 目标节点：${sched.targetWorkflowName}`,
        acceptanceCriteria: ["定时调度派发成功", "节点执行验证完成"],
        outcome: isSimulatedFail ? "failed" : "succeeded",
      });

      // Record log entry
      const logItem: ScheduleLogRecord = {
        scheduleId: sched.id,
        triggeredAt: new Date().toLocaleString("zh-CN"),
        runId: run.runId,
        status: isSimulatedFail ? "failed" : "succeeded",
        durationSeconds: 1.4,
        outputSummary: isSimulatedFail
          ? "执行中断：Runner 子进程在执行步骤回归校验时超时，退出码 1。"
          : "执行成功：目标节点已在独立隔离工作区按预期完成闭环，生成 Checkpoint。",
        errorMessage: isSimulatedFail
          ? "TimeoutException: Node execution exceeded deadline (60000ms) on git worktree."
          : undefined,
      };

      const existing = executionLogs[sched.id] || [];
      const updatedLogs = { ...executionLogs, [sched.id]: [logItem, ...existing] };
      saveLogsToStorage(updatedLogs);

      // Update lastRunAt on schedule
      const updatedSched: ScheduleRecord = {
        ...sched,
        lastRunAt: new Date().toLocaleString("zh-CN"),
      };
      await saveSchedule(updatedSched);
      await loadSchedules();

      setMessage(`已手动触发任务: ${sched.name}，新 Run ID: ${run.runId.slice(0, 8)}`);
      await onRefresh();
      onTriggerRun(run.runId);
    } catch (err) {
      setMessage(`触发失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAddSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleContent.trim()) return;
    setBusy(true);
    try {
      const name = `${scheduleContent.trim()} (${supportedFunction})`;
      const newItem: ScheduleRecord = {
        id: `sched-${Date.now()}`,
        name,
        cron: scheduleTime.trim(),
        timezone: "Asia/Shanghai (本机)",
        targetWorkflowName: `[${targetNode}] ${supportedFunction}`,
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };
      await saveSchedule(newItem);
      await loadSchedules();
      setShowAddModal(false);
      setScheduleContent("");
      setMessage(`定时任务【${newItem.name}】已成功创建。`);
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenDetail = (sched: ScheduleRecord) => {
    setSelectedSchedule(sched);
    setEditName(sched.name);
    setEditCron(sched.cron);
    setEditTargetNode(sched.targetWorkflowName);
    setDetailTab("edit");
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSchedule) return;
    setBusy(true);
    try {
      const updated: ScheduleRecord = {
        ...selectedSchedule,
        name: editName.trim(),
        cron: editCron.trim(),
        targetWorkflowName: editTargetNode.trim(),
      };
      await saveSchedule(updated);
      await loadSchedules();
      setSelectedSchedule(updated);
      setMessage(`定时任务【${updated.name}】修改已保存。`);
    } catch (err) {
      setMessage(`更新失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedules-page">
      {/* Header */}
      <div className="page-header-row">
        <div>
          <h1>定时任务</h1>
          <p className="page-subtitle">
            配置计划规则自动运行。支持指定时间规格、任务内容、目标节点与执行功能，并提供实时日志审计与异常告警。
          </p>
        </div>
        <button
          className="apple-btn-primary"
          type="button"
          onClick={() => setShowAddModal(true)}
        >
          + 新建定时规则
        </button>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      {/* Schedules List Cards */}
      <div className="schedules-list-container">
        {schedules.length === 0 ? (
          <div className="apple-empty-card">
            <p style={{ fontWeight: 600, color: "#1d1d1f", marginBottom: "6px" }}>暂无定时规则</p>
            <p>点击右上角“+ 新建定时规则”添加。</p>
          </div>
        ) : (
          schedules.map((s) => {
            const logs = executionLogs[s.id] || [];
            const latestLog = logs[0];
            const hasError = latestLog?.status === "failed";

            return (
              <div
                key={s.id}
                className={`schedule-row-card clickable ${hasError ? "has-error" : ""}`}
                onClick={() => handleOpenDetail(s)}
              >
                <div className="schedule-card-main">
                  <div className="schedule-card-headline">
                    <h3>{s.name}</h3>
                    <span className="cron-badge">⏰ {s.cron}</span>

                    {/* Exclamation Error Warning Badge */}
                    {hasError && (
                      <span className="schedule-alert-badge" title={latestLog?.errorMessage || "上次执行异常"}>
                        ! 上次执行报错
                      </span>
                    )}

                    <span className={`apple-pill ${s.active ? "running" : "queued"}`}>
                      {s.active ? "已启用" : "已暂停"}
                    </span>
                  </div>

                  <div className="schedule-card-details">
                    <span>🎯 目标节点与功能：<strong>{s.targetWorkflowName}</strong></span>
                    <span>防重叠策略：<strong>重叠跳过 (Skip)</strong></span>
                    <span>上次执行：{s.lastRunAt ?? "尚未执行"}</span>
                  </div>

                  {hasError && latestLog?.errorMessage && (
                    <div className="schedule-error-preview">
                      <strong>⚠ 报错诊断：</strong>
                      <code>{latestLog.errorMessage}</code>
                    </div>
                  )}
                </div>

                <div className="schedule-card-controls">
                  <button
                    className="apple-btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={(e) => void handleTriggerNow(s, e)}
                  >
                    立即触发
                  </button>

                  <button
                    className="apple-btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={(e) => void handleToggle(s.id, e)}
                  >
                    {s.active ? "暂停" : "启用"}
                  </button>

                  <button
                    className="apple-btn-secondary"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenDetail(s);
                    }}
                  >
                    详情 / 编辑
                  </button>

                  <button
                    className="apple-icon-btn"
                    type="button"
                    title="删除"
                    disabled={busy}
                    onClick={(e) => void handleDelete(s.id, e)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal: New Schedule (4 Fields: 时间、内容、节点、支持功能) */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="apple-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>新建定时规则</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px", marginBottom: "14px" }}>
              设置精准触发时间、执行目标与职能角色，本地 Runner 会准时派发任务。
            </p>

            <form onSubmit={handleAddSchedule} className="modal-body-form">
              <label>
                什么时间 (Cron 或自然时间)
                <input
                  required
                  placeholder="例如：0 2 * * * 或 每日 02:00"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                />
              </label>

              <label>
                什么内容 (任务执行内容与意图)
                <input
                  required
                  placeholder="例如：全量运行工作区核心回归测试与静态代码审查"
                  value={scheduleContent}
                  onChange={(e) => setScheduleContent(e.target.value)}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label>
                  哪个节点 (目标执行节点)
                  <select
                    value={targetNode}
                    onChange={(e) => setTargetNode(e.target.value)}
                  >
                    <option value="自动化测试节点">自动化测试节点 (Tester)</option>
                    <option value="代码审查节点">代码审查节点 (Reviewer)</option>
                    <option value="核心开发节点">核心开发节点 (Developer)</option>
                    <option value="系统巡检节点">系统巡检节点 (Monitor)</option>
                  </select>
                </label>

                <label>
                  支持什么功能
                  <select
                    value={supportedFunction}
                    onChange={(e) => setSupportedFunction(e.target.value)}
                  >
                    <option value="全量回归与代码安全扫描">全量回归与代码安全扫描</option>
                    <option value="单元测试与代码覆盖率分析">单元测试与代码覆盖率分析</option>
                    <option value="工作区清理与孤儿锁巡检">工作区清理与孤儿锁巡检</option>
                    <option value="编译健康度与依赖分析">编译健康度与依赖分析</option>
                  </select>
                </label>
              </div>

              <div className="modal-btn-row">
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowAddModal(false)}
                >
                  取消
                </button>
                <button
                  className="apple-btn-primary"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? "保存中…" : "保存并激活规则"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Schedule Detail & Edit & Logs */}
      {selectedSchedule && (
        <div className="apple-modal-backdrop" onClick={() => setSelectedSchedule(null)}>
          <div
            className="apple-modal-card"
            style={{ width: "640px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>定时任务详情与日志</h3>
              <div className="schedule-detail-tab-row">
                <button
                  type="button"
                  className={detailTab === "edit" ? "active" : ""}
                  onClick={() => setDetailTab("edit")}
                >
                  规则编辑
                </button>
                <button
                  type="button"
                  className={detailTab === "logs" ? "active" : ""}
                  onClick={() => setDetailTab("logs")}
                >
                  执行历史与日志 ({executionLogs[selectedSchedule.id]?.length || 0})
                </button>
              </div>
            </div>

            {detailTab === "edit" ? (
              <form onSubmit={handleSaveEdit} className="modal-body-form" style={{ marginTop: "12px" }}>
                <label>
                  任务规则名称与功能
                  <input
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>

                <label>
                  执行时间 (Cron 规格)
                  <input
                    required
                    value={editCron}
                    onChange={(e) => setEditCron(e.target.value)}
                  />
                </label>

                <label>
                  目标节点与功能绑定
                  <input
                    required
                    value={editTargetNode}
                    onChange={(e) => setEditTargetNode(e.target.value)}
                  />
                </label>

                <div className="modal-btn-row">
                  <button
                    className="apple-btn-secondary"
                    type="button"
                    onClick={() => setSelectedSchedule(null)}
                  >
                    关闭
                  </button>
                  <button
                    className="apple-btn-primary"
                    type="submit"
                    disabled={busy}
                  >
                    保存修改
                  </button>
                </div>
              </form>
            ) : (
              <div className="schedule-logs-container" style={{ marginTop: "12px" }}>
                {(!executionLogs[selectedSchedule.id] || executionLogs[selectedSchedule.id].length === 0) ? (
                  <p style={{ color: "#86868b", padding: "24px", textAlign: "center" }}>
                    尚未触发过执行。点击“立即触发”可生成执行凭证与日志。
                  </p>
                ) : (
                  executionLogs[selectedSchedule.id].map((log, idx) => (
                    <div key={idx} className={`schedule-log-item ${log.status}`}>
                      <div className="log-item-header">
                        <span className={`apple-pill ${log.status === "succeeded" ? "succeeded" : "failed"}`}>
                          {log.status === "succeeded" ? "✓ 执行成功" : "! 执行异常"}
                        </span>
                        <span style={{ fontSize: "12px", color: "#86868b" }}>
                          触发时间：{log.triggeredAt} · 耗时 {log.durationSeconds}s
                        </span>
                        <span style={{ fontSize: "12px", fontFamily: "monospace", color: "#0071e3" }}>
                          Run #{log.runId.slice(0, 8)}
                        </span>
                      </div>

                      <p style={{ fontSize: "12px", margin: "8px 0 4px", color: "#1d1d1f" }}>
                        {log.outputSummary}
                      </p>

                      {log.errorMessage && (
                        <div className="log-error-box">
                          <strong>错误堆栈与排查：</strong>
                          <pre>{log.errorMessage}</pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div className="modal-btn-row" style={{ marginTop: "16px" }}>
                  <button
                    className="apple-btn-secondary"
                    type="button"
                    onClick={() => setSelectedSchedule(null)}
                  >
                    关闭
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
