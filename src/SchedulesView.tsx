import { useEffect, useState, useCallback } from "react";
import {
  listSchedules,
  saveSchedule,
  toggleSchedule,
  deleteSchedule,
  createMockTask,
  type ScheduleRecord,
} from "./api";
import {
  IconClose,
  IconUser,
  IconSchedule,
  IconFolder,
  IconCheck,
  IconAlertTriangle,
  IconLink,
  IconTasks,
  IconCpu,
} from "./icons";
import { DrawerSelect } from "./DrawerSelect";

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

const modelOptions = [
  { id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", desc: "长上下文与高精度代码" },
  { id: "gpt-4o", label: "GPT-4o", desc: "全能多模态与通用推理" },
  { id: "gemini-1-5-pro", label: "Gemini 1.5 Pro", desc: "复杂长链条与分析" },
  { id: "deepseek-v3", label: "DeepSeek V3", desc: "快速高性价比执行" },
];

const reasoningOptions = [
  { id: "low", label: "快速 (Low)" },
  { id: "medium", label: "平衡 (Medium)" },
  { id: "high", label: "深度 (High)" },
];

export function formatScheduleDisplay(raw: string): string {
  if (!raw) return "按需触发";
  const trimmed = raw.trim();

  // 1. If it contains parenthesis description e.g. "0 2 * * * (每日 02:00)" or "(每 2 小时)"
  const parenMatch = trimmed.match(/\(([^)]+)\)/);
  if (parenMatch && parenMatch[1].trim()) {
    return parenMatch[1].trim();
  }

  // 2. If it's already human-friendly e.g. "每天 02:00", "工作日 09:30", "每周一 10:00", "每小时整点"
  if (
    trimmed.startsWith("每天") ||
    trimmed.startsWith("每日") ||
    trimmed.startsWith("工作日") ||
    trimmed.startsWith("每周") ||
    trimmed.startsWith("每小时") ||
    trimmed.startsWith("每 2 小时") ||
    trimmed.startsWith("每") ||
    trimmed.startsWith("单次")
  ) {
    return trimmed;
  }

  // 3. Known cron patterns mapping
  if (trimmed === "0 2 * * *") return "每天 02:00";
  if (trimmed === "0 */2 * * *" || trimmed === "*/120 * * * *") return "每 2 小时";
  if (trimmed === "0 * * * *") return "每小时整点";
  if (trimmed === "*/30 * * * *") return "每 30 分钟";
  if (trimmed === "0 9 * * 1-5" || trimmed === "30 9 * * 1-5") return "工作日 09:30";
  if (trimmed === "0 10 * * 1") return "每周一 10:00";

  // 4. Strip leading 5-field cron if friendly text follows
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 6 && /^[\d*,/\\-]+$/.test(parts[0]) && /^[\d*,/\\-]+$/.test(parts[1])) {
    const trailing = parts.slice(5).join(" ");
    if (trailing.length > 0) return trailing;
  }

  return trimmed;
}

export function SchedulesView({ onTriggerRun, onRefresh }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // New Schedule Modal (Feishu/Apple Minimalist Style)
  const [showAddModal, setShowAddModal] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedModel, setSelectedModel] = useState(modelOptions[0].label);
  const [selectedReasoning, setSelectedReasoning] = useState(reasoningOptions[2].label);

  // Time & Repeat
  const [presetTimeTag, setPresetTimeTag] = useState("每天 02:00");
  const [isCustomTime, setIsCustomTime] = useState(false);
  const [customFrequency, setCustomFrequency] = useState<"daily" | "workdays" | "weekly" | "hourly">("daily");
  const [customTimeVal, setCustomTimeVal] = useState("02:00");
  const [customWeekday, setCustomWeekday] = useState("1");
  const [isRepeating, setIsRepeating] = useState(true);

  // Subtasks & Attachments (Optional fields as requested)
  const [showSubtasks, setShowSubtasks] = useState(false);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [showAttachment, setShowAttachment] = useState(false);
  const [attachmentPath, setAttachmentPath] = useState("");

  // Detail / Logs Modal
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduleRecord | null>(null);
  const [detailTab, setDetailTab] = useState<"edit" | "logs">("edit");
  const [editName, setEditName] = useState("");
  const [editTimeStr, setEditTimeStr] = useState("");
  const [editModel, setEditModel] = useState("");

  // Persisted Execution Logs
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

  const getEffectiveTimeString = () => {
    if (!isCustomTime) return presetTimeTag;
    if (customFrequency === "daily") return `每天 ${customTimeVal}`;
    if (customFrequency === "workdays") return `工作日 ${customTimeVal}`;
    if (customFrequency === "weekly") {
      const dayNames: Record<string, string> = { "1": "周一", "2": "周二", "3": "周三", "4": "周四", "5": "周五", "6": "周六", "0": "周日" };
      return `每周${dayNames[customWeekday] || "周一"} ${customTimeVal}`;
    }
    return "每小时整点";
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
      setMessage("定时任务已移除。");
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
        description: `频次：${sched.cron} · 模型：${sched.targetWorkflowName}\n环境：[本机工作区自动感知]`,
        acceptanceCriteria: ["指定模型按时序触发执行", "环境健康检查与回归通过"],
        outcome: isSimulatedFail ? "failed" : "succeeded",
      });

      const logItem: ScheduleLogRecord = {
        scheduleId: sched.id,
        triggeredAt: new Date().toLocaleTimeString("zh-CN"),
        runId: run.runId,
        status: isSimulatedFail ? "failed" : "succeeded",
        durationSeconds: 1.1,
        outputSummary: isSimulatedFail
          ? "执行中断：Runner 子进程在回归校验时超时。"
          : `执行成功：${sched.targetWorkflowName} 已在本地工作区完成执行闭环。`,
        errorMessage: isSimulatedFail ? "TimeoutException: Process exceeded limit." : undefined,
      };

      const existing = executionLogs[sched.id] || [];
      const updatedLogs = { ...executionLogs, [sched.id]: [logItem, ...existing] };
      setExecutionLogs(updatedLogs);
      localStorage.setItem("agentflow_schedule_logs_v1", JSON.stringify(updatedLogs));

      const updatedSched: ScheduleRecord = {
        ...sched,
        lastRunAt: new Date().toLocaleTimeString("zh-CN"),
      };
      await saveSchedule(updatedSched);
      await loadSchedules();

      setMessage(`已触发任务: ${sched.name} (Run #${run.runId.slice(0, 8)})`);
      await onRefresh();
      onTriggerRun(run.runId);
    } catch (err) {
      setMessage(`触发失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateSchedule = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!title.trim()) return;

    setBusy(true);
    try {
      const timeStr = getEffectiveTimeString();
      const schedId = `sched-${Date.now()}`;
      const finalModelLabel = `${selectedModel} (${selectedReasoning})`;

      const newItem: ScheduleRecord = {
        id: schedId,
        name: title.trim(),
        cron: timeStr,
        timezone: "Asia/Shanghai (本机)",
        targetWorkflowName: finalModelLabel,
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };

      await saveSchedule(newItem);
      await loadSchedules();

      // Reset modal state
      setShowAddModal(false);
      setTitle("");
      setDescription("");
      setSubtasks([]);
      setShowSubtasks(false);
      setShowAttachment(false);
      setAttachmentPath("");
      setMessage(`定时任务【${newItem.name}】已成功创建！`);
    } catch (err) {
      setMessage(`创建失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleOpenDetail = (sched: ScheduleRecord) => {
    setSelectedSchedule(sched);
    setEditName(sched.name);
    setEditTimeStr(formatScheduleDisplay(sched.cron));
    setEditModel(sched.targetWorkflowName);
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
        cron: editTimeStr.trim(),
        targetWorkflowName: editModel.trim(),
      };
      await saveSchedule(updated);
      await loadSchedules();
      setSelectedSchedule(updated);
      setMessage(`定时任务【${updated.name}】已更新。`);
    } catch (err) {
      setMessage(`更新失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedules-page">
      {/* Page Header */}
      <div className="page-header-row">
        <div>
          <h1>定时任务</h1>
          <p className="page-subtitle">
            配置周期性自动化规则。指定模型与推理深度，自动感知运行环境，纯净极简。
          </p>
        </div>
        <button
          className="apple-btn-primary"
          type="button"
          onClick={() => setShowAddModal(true)}
        >
          + 新建定时任务
        </button>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      {/* Streamlined Schedules Table */}
      <div className="apple-table-card">
        <table className="apple-tasks-table">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>时间频次</th>
              <th style={{ width: "34%" }}>任务内容</th>
              <th style={{ width: "24%" }}>负责模型 & 推理程度</th>
              <th style={{ width: "10%" }}>状态</th>
              <th style={{ width: "10%", textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr>
                <td colSpan={5} className="apple-table-empty">
                  暂无定时任务。点击右上角“+ 新建定时任务”开始。
                </td>
              </tr>
            ) : (
              schedules.map((s) => {
                const logs = executionLogs[s.id] || [];
                const latestLog = logs[0];
                const hasError = latestLog?.status === "failed";

                return (
                  <tr
                    key={s.id}
                    className="apple-task-row"
                    onClick={() => handleOpenDetail(s)}
                  >
                    <td className="col-time">
                      <div className="schedule-time-cell" title={s.cron !== formatScheduleDisplay(s.cron) ? s.cron : undefined}>
                        <span className="schedule-clock-icon">
                          <IconSchedule size={13} />
                        </span>
                        <span className="schedule-time-label">{formatScheduleDisplay(s.cron)}</span>
                      </div>
                    </td>

                    <td className="col-name">
                      <strong className="schedule-name-text">{s.name}</strong>
                    </td>

                    <td className="col-desc">
                      <div className="schedule-agent-cell">
                        <IconCpu size={12} className="schedule-agent-icon" />
                        <span className="schedule-agent-label">{s.targetWorkflowName}</span>
                      </div>
                    </td>

                    <td className="col-status">
                      {hasError ? (
                        <span className="apple-pill failed" title={latestLog?.errorMessage}>
                          ! 上次报错
                        </span>
                      ) : (
                        <span className={`apple-pill ${s.active ? "running" : "queued"}`}>
                          {s.active ? "已启用" : "已暂停"}
                        </span>
                      )}
                    </td>

                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                        <button
                          className="apple-btn-secondary"
                          style={{ fontSize: "11px", padding: "3px 7px" }}
                          type="button"
                          disabled={busy}
                          onClick={(e) => void handleTriggerNow(s, e)}
                        >
                          触发
                        </button>
                        <button
                          className="apple-btn-secondary"
                          style={{ fontSize: "11px", padding: "3px 7px" }}
                          type="button"
                          disabled={busy}
                          onClick={(e) => void handleToggle(s.id, e)}
                        >
                          {s.active ? "暂停" : "启用"}
                        </button>
                        <button
                          className="apple-icon-btn"
                          type="button"
                          title="删除"
                          disabled={busy}
                          onClick={(e) => void handleDelete(s.id, e)}
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                        >
                          <IconClose size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal: Feishu-style Clean Add Task Modal (参考用户截图) */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div
            className="feishu-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top: Title Input + Close Icon */}
            <div className="feishu-modal-top">
              <input
                className="feishu-title-input"
                placeholder="输入标题，回车确认"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreateSchedule();
                  }
                }}
              />
              <button
                type="button"
                className="apple-icon-btn"
                onClick={() => setShowAddModal(false)}
                title="关闭"
                style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
              >
                <IconClose size={14} />
              </button>
            </div>

            {/* Row 1: Assignee (谁负责: 模型 + 推理程度) */}
            <div className="feishu-field-row">
              <span className="feishu-field-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                <IconUser size={14} />
              </span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", flex: 1 }}>
                <DrawerSelect
                  size="sm"
                  value={selectedModel}
                  onChange={(val) => setSelectedModel(val)}
                  options={modelOptions.map((m) => ({
                    value: m.label,
                    label: m.label,
                    description: m.desc,
                  }))}
                  triggerStyle={{ minWidth: "170px" }}
                />

                <DrawerSelect
                  size="sm"
                  value={selectedReasoning}
                  onChange={(val) => setSelectedReasoning(val)}
                  options={reasoningOptions.map((r) => ({
                    value: r.label,
                    label: r.label,
                  }))}
                  triggerStyle={{ minWidth: "115px" }}
                />
              </div>
            </div>

            {/* Row 2: Date & Repeat (什么时间，是否重复) */}
            <div className="feishu-field-row" style={{ alignItems: "flex-start" }}>
              <span className="feishu-field-icon" style={{ marginTop: "4px", display: "inline-flex", alignItems: "center" }}>
                <IconSchedule size={14} />
              </span>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
                <div className="feishu-pills-row">
                  {[
                    "每天 02:00",
                    "工作日 09:30",
                    "每周一 10:00",
                    "每小时整点",
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`feishu-pill-chip ${presetTimeTag === preset && !isCustomTime ? "active" : ""}`}
                      onClick={() => {
                        setPresetTimeTag(preset);
                        setIsCustomTime(false);
                      }}
                    >
                      {preset}
                    </button>
                  ))}

                  <button
                    type="button"
                    className={`feishu-pill-chip ${isCustomTime ? "active" : ""}`}
                    onClick={() => setIsCustomTime(true)}
                  >
                    自定义时间…
                  </button>

                  <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: "var(--apple-text-secondary)", marginLeft: "4px" }}>
                    <input
                      type="checkbox"
                      checked={isRepeating}
                      onChange={(e) => setIsRepeating(e.target.checked)}
                    />
                    <span>重复执行</span>
                  </label>
                </div>

                {isCustomTime && (
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
                    <DrawerSelect
                      size="sm"
                      value={customFrequency}
                      onChange={(val) => setCustomFrequency(val as typeof customFrequency)}
                      options={[
                        { value: "daily", label: "每天" },
                        { value: "workdays", label: "工作日 (周一至周五)" },
                        { value: "weekly", label: "每周" },
                        { value: "hourly", label: "每小时" },
                      ]}
                      triggerStyle={{ minWidth: "140px" }}
                    />

                    {customFrequency !== "hourly" && (
                      <input
                        type="time"
                        className="feishu-input"
                        value={customTimeVal}
                        onChange={(e) => setCustomTimeVal(e.target.value)}
                      />
                    )}

                    {customFrequency === "weekly" && (
                      <DrawerSelect
                        size="sm"
                        value={customWeekday}
                        onChange={(val) => setCustomWeekday(val)}
                        options={[
                          { value: "1", label: "周一" },
                          { value: "2", label: "周二" },
                          { value: "3", label: "周三" },
                          { value: "4", label: "周四" },
                          { value: "5", label: "周五" },
                          { value: "6", label: "周六" },
                          { value: "0", label: "周日" },
                        ]}
                        triggerStyle={{ minWidth: "85px" }}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Row 3: List / Scope (添加至任务清单) */}
            <div className="feishu-field-row">
              <span className="feishu-field-icon" style={{ display: "inline-flex", alignItems: "center" }}>
                <IconFolder size={14} />
              </span>
              <span style={{ fontSize: "13px", color: "#1d1d1f" }}>
                默认工程工作区 (系统自动感知当前代码库与本地环境)
              </span>
            </div>

            {/* Row 4: Description (添加描述) */}
            <div className="feishu-field-row" style={{ alignItems: "flex-start" }}>
              <span className="feishu-field-icon" style={{ marginTop: "4px", display: "inline-flex", alignItems: "center" }}>
                <IconTasks size={14} />
              </span>
              <textarea
                className="feishu-desc-input"
                placeholder="添加任务描述、执行要求或巡检标准…"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {/* Optional Subtasks Section */}
            {showSubtasks && (
              <div className="feishu-subtask-section">
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#86868b", marginBottom: "6px" }}>
                  子任务清单：
                </div>
                {subtasks.map((st, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "6px", marginBottom: "4px" }}>
                    <input
                      className="feishu-input"
                      placeholder={`子任务 ${idx + 1}`}
                      value={st}
                      onChange={(e) => {
                        const updated = [...subtasks];
                        updated[idx] = e.target.value;
                        setSubtasks(updated);
                      }}
                    />
                    <button
                      type="button"
                      className="apple-icon-btn"
                      onClick={() => setSubtasks(subtasks.filter((_, i) => i !== idx))}
                      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <IconClose size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="apple-btn-secondary"
                  style={{ fontSize: "11px", marginTop: "4px" }}
                  onClick={() => setSubtasks([...subtasks, ""])}
                >
                  + 添加子任务项
                </button>
              </div>
            )}

            {/* Optional Attachment / Path Section */}
            {showAttachment && (
              <div className="feishu-subtask-section">
                <div style={{ fontSize: "12px", fontWeight: 600, color: "#86868b", marginBottom: "6px" }}>
                  关联项目路径 / 脚本附件：
                </div>
                <input
                  className="feishu-input"
                  placeholder="例如：/scripts/run_regression.sh 或当前工作区子目录"
                  value={attachmentPath}
                  onChange={(e) => setAttachmentPath(e.target.value)}
                />
              </div>
            )}

            {/* Bottom Bar: Action Icons on Left, Cancel & Create on Right */}
            <div className="feishu-modal-footer">
              <div className="feishu-footer-left">
                <button
                  type="button"
                  className={`feishu-tool-btn ${showSubtasks ? "active" : ""}`}
                  title="添加子任务"
                  onClick={() => {
                    setShowSubtasks(!showSubtasks);
                    if (!showSubtasks && subtasks.length === 0) setSubtasks([""]);
                  }}
                >
                  子任务
                </button>

                <button
                  type="button"
                  className={`feishu-tool-btn ${showAttachment ? "active" : ""}`}
                  title="添加附件或路径"
                  onClick={() => setShowAttachment(!showAttachment)}
                  style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                >
                  <IconLink size={12} />
                  <span>附件/路径</span>
                </button>
              </div>

              <div className="feishu-footer-right">
                <button
                  type="button"
                  className="apple-btn-secondary"
                  onClick={() => setShowAddModal(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="apple-btn-primary"
                  disabled={busy || !title.trim()}
                  onClick={() => void handleCreateSchedule()}
                >
                  {busy ? "创建中…" : "创建"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Schedule Detail & Logs */}
      {selectedSchedule && (
        <div className="apple-modal-backdrop" onClick={() => setSelectedSchedule(null)}>
          <div
            className="apple-modal-card"
            style={{ width: "580px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>定时任务配置与执行审计</h3>
              <div className="schedule-detail-tab-row">
                <button
                  type="button"
                  className={detailTab === "edit" ? "active" : ""}
                  onClick={() => setDetailTab("edit")}
                >
                  编辑任务
                </button>
                <button
                  type="button"
                  className={detailTab === "logs" ? "active" : ""}
                  onClick={() => setDetailTab("logs")}
                >
                  运行日志 ({executionLogs[selectedSchedule.id]?.length || 0})
                </button>
              </div>
            </div>

            {detailTab === "edit" ? (
              <form onSubmit={handleSaveEdit} className="modal-body-form" style={{ marginTop: "12px" }}>
                <label>
                  任务内容标题
                  <input
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>

                <label>
                  触发时间频次
                  <input
                    required
                    placeholder="例如：每天 02:00、工作日 09:30、每 2 小时"
                    value={editTimeStr}
                    onChange={(e) => setEditTimeStr(e.target.value)}
                  />
                  <span style={{ fontSize: "11px", color: "var(--apple-text-tertiary)", marginTop: "2px" }}>
                    支持自然时间（如：每天 02:00、工作日 09:30）或标准周期规则
                  </span>
                </label>

                <label>
                  负责模型与推理程度
                  <input
                    required
                    placeholder="例如：Claude 3.5 Sonnet (极高推理)"
                    value={editModel}
                    onChange={(e) => setEditModel(e.target.value)}
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
                  <p style={{ color: "#86868b", padding: "20px", textAlign: "center" }}>
                    尚未触发过执行。点击任务行“触发”即可立即验证。
                  </p>
                ) : (
                  executionLogs[selectedSchedule.id].map((log, idx) => (
                    <div key={idx} className={`schedule-log-item ${log.status}`}>
                      <div className="log-item-header">
                        <span className={`apple-pill ${log.status === "succeeded" ? "succeeded" : "failed"}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          {log.status === "succeeded" ? (
                            <>
                              <IconCheck size={11} />
                              <span>成功</span>
                            </>
                          ) : (
                            <>
                              <IconAlertTriangle size={11} />
                              <span>失败</span>
                            </>
                          )}
                        </span>
                        <span style={{ fontSize: "11px", color: "#86868b" }}>
                          {log.triggeredAt} · 耗时 {log.durationSeconds}s
                        </span>
                        <span style={{ fontSize: "11px", fontFamily: "monospace", color: "#0071e3" }}>
                          Run #{log.runId.slice(0, 8)}
                        </span>
                      </div>

                      <p style={{ fontSize: "12px", margin: "6px 0 2px", color: "#1d1d1f" }}>
                        {log.outputSummary}
                      </p>

                      {log.errorMessage && (
                        <div className="log-error-box">
                          <strong>错误堆栈：</strong>
                          <pre>{log.errorMessage}</pre>
                        </div>
                      )}
                    </div>
                  ))
                )}
                <div className="modal-btn-row" style={{ marginTop: "14px" }}>
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
