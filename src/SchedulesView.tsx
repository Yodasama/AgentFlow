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

export interface ScheduleEnvConfig {
  envType: "local" | "remote";
  remoteHost?: string;
  remotePort?: number;
  remoteUser?: string;
  remoteDir?: string;
  authMethod?: string;
  preCommand?: string;
}

const SCHEDULE_ENV_STORAGE_KEY = "agentflow_schedule_env_configs_v1";

const agentNodeOptions = [
  { id: "agent-dev", label: "核心开发 Agent (Claude 3.5 Sonnet)" },
  { id: "agent-review", label: "严苛审查 Agent (Claude 3.5 Sonnet)" },
  { id: "agent-test", label: "自动化测试 Agent (Test Runner)" },
  { id: "agent-arch", label: "架构规划 Agent (GPT-4o)" },
  { id: "agent-ops", label: "系统运维与巡检 Agent (Local Runner)" },
];

export function SchedulesView({ onTriggerRun, onRefresh }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // New Schedule Modal
  const [showAddModal, setShowAddModal] = useState(false);

  // 1. Time Widget State (时间小组件手动点选)
  const [frequency, setFrequency] = useState<"daily" | "hourly" | "workdays" | "weekly" | "custom">("daily");
  const [timePickerValue, setTimePickerValue] = useState("02:00");
  const [weekdayValue, setWeekdayValue] = useState("1"); // 1 = Monday
  const [customCron, setCustomCron] = useState("0 2 * * *");

  // 2. Task Description & Target Agent Node
  const [taskDescription, setTaskDescription] = useState("");
  const [assignedAgent, setAssignedAgent] = useState(agentNodeOptions[2].label); // Default: 测试 Agent

  // 3. Execution Target Environment (解决服务器信息与自然语言跑偏问题)
  const [targetEnvType, setTargetEnvType] = useState<"local" | "remote">("local");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState(22);
  const [remoteUser, setRemoteUser] = useState("root");
  const [remoteDir, setRemoteDir] = useState("/var/log");
  const [authMethod, setAuthMethod] = useState("ssh_key");
  const [preCommand, setPreCommand] = useState("");

  // Detail / Edit Modal
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduleRecord | null>(null);
  const [detailTab, setDetailTab] = useState<"edit" | "logs">("edit");
  const [editName, setEditName] = useState("");
  const [editCron, setEditCron] = useState("");
  const [editAgent, setEditAgent] = useState("");

  // Persisted Execution Logs & Server Context
  const [executionLogs, setExecutionLogs] = useState<Record<string, ScheduleLogRecord[]>>(() => {
    try {
      const saved = localStorage.getItem("agentflow_schedule_logs_v1");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [envConfigs, setEnvConfigs] = useState<Record<string, ScheduleEnvConfig>>(() => {
    try {
      const saved = localStorage.getItem(SCHEDULE_ENV_STORAGE_KEY);
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

  // Compute Cron String and Human Summary from Time Widget
  const computeScheduleSpec = () => {
    const [hour, minute] = timePickerValue.split(":");
    const h = parseInt(hour || "2", 10);
    const m = parseInt(minute || "0", 10);

    if (frequency === "daily") {
      return {
        cron: `${m} ${h} * * *`,
        human: `每天 ${timePickerValue}`,
      };
    }
    if (frequency === "workdays") {
      return {
        cron: `${m} ${h} * * 1-5`,
        human: `工作日(周一至五) ${timePickerValue}`,
      };
    }
    if (frequency === "weekly") {
      const dayNames: Record<string, string> = {
        "1": "周一",
        "2": "周二",
        "3": "周三",
        "4": "周四",
        "5": "周五",
        "6": "周六",
        "0": "周日",
      };
      return {
        cron: `${m} ${h} * * ${weekdayValue}`,
        human: `每周${dayNames[weekdayValue] || "周一"} ${timePickerValue}`,
      };
    }
    if (frequency === "hourly") {
      return {
        cron: `${m} * * * *`,
        human: `每小时第 ${m} 分钟`,
      };
    }
    return {
      cron: customCron.trim(),
      human: `自定义 (${customCron.trim()})`,
    };
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
      const env = envConfigs[sched.id];
      const envSummary =
        env?.envType === "remote"
          ? `[远端主机: ${env.remoteHost}:${env.remotePort} · 目录: ${env.remoteDir}]`
          : "[本机隔离工作区]";

      const run = await createMockTask({
        title: `[定时执行] ${sched.name}`,
        description: `时间：${sched.cron} · 执行 Agent：${sched.targetWorkflowName}\n环境：${envSummary}`,
        acceptanceCriteria: ["指定 Agent 定时派发执行", "目标环境操作验证完成"],
        outcome: isSimulatedFail ? "failed" : "succeeded",
      });

      const logItem: ScheduleLogRecord = {
        scheduleId: sched.id,
        triggeredAt: new Date().toLocaleTimeString("zh-CN"),
        runId: run.runId,
        status: isSimulatedFail ? "failed" : "succeeded",
        durationSeconds: 1.2,
        outputSummary: isSimulatedFail
          ? "执行中断：Runner 子进程在执行步骤回归校验时超时。"
          : `执行成功：${sched.targetWorkflowName} 已在 ${envSummary} 按预设结构化上下文完成闭环。`,
        errorMessage: isSimulatedFail
          ? "TimeoutException: Node execution exceeded deadline (60000ms)."
          : undefined,
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

  const handleAddSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskDescription.trim()) return;
    setBusy(true);
    try {
      const spec = computeScheduleSpec();
      const schedId = `sched-${Date.now()}`;

      // Save environment configuration to localStorage
      const newEnvConfig: ScheduleEnvConfig = {
        envType: targetEnvType,
        remoteHost: targetEnvType === "remote" ? remoteHost.trim() : undefined,
        remotePort: targetEnvType === "remote" ? remotePort : undefined,
        remoteUser: targetEnvType === "remote" ? remoteUser.trim() : undefined,
        remoteDir: targetEnvType === "remote" ? remoteDir.trim() : undefined,
        authMethod: targetEnvType === "remote" ? authMethod : undefined,
        preCommand: targetEnvType === "remote" ? preCommand.trim() : undefined,
      };

      const updatedEnvs = { ...envConfigs, [schedId]: newEnvConfig };
      setEnvConfigs(updatedEnvs);
      localStorage.setItem(SCHEDULE_ENV_STORAGE_KEY, JSON.stringify(updatedEnvs));

      const newItem: ScheduleRecord = {
        id: schedId,
        name: taskDescription.trim(),
        cron: spec.human,
        timezone: "Asia/Shanghai (本机)",
        targetWorkflowName: assignedAgent,
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };

      await saveSchedule(newItem);
      await loadSchedules();
      setShowAddModal(false);
      setTaskDescription("");
      setMessage(`定时任务【${newItem.name}】已成功创建并分配至 ${assignedAgent}。`);
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
    setEditAgent(sched.targetWorkflowName);
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
        targetWorkflowName: editAgent.trim(),
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
            配置自动化定时规则。使用时间小组件设定频次，选择具体 Agent 节点执行，支持注入目标服务器与环境上下文。
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

      {/* Streamlined Clean Schedules Table: Essential Info Only */}
      <div className="apple-table-card">
        <table className="apple-tasks-table">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>时间规格</th>
              <th style={{ width: "32%" }}>任务内容 & 目标环境</th>
              <th style={{ width: "24%" }}>执行 Agent 节点</th>
              <th style={{ width: "10%" }}>状态</th>
              <th style={{ width: "12%", textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr>
                <td colSpan={5} className="apple-table-empty">
                  暂无定时任务。点击右上角“+ 新建定时规则”添加。
                </td>
              </tr>
            ) : (
              schedules.map((s) => {
                const logs = executionLogs[s.id] || [];
                const latestLog = logs[0];
                const hasError = latestLog?.status === "failed";
                const env = envConfigs[s.id];

                return (
                  <tr
                    key={s.id}
                    className="apple-task-row"
                    onClick={() => handleOpenDetail(s)}
                  >
                    <td className="col-time">
                      <span className="cron-pill">⏰ {s.cron}</span>
                    </td>

                    <td className="col-name">
                      <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                        <strong>{s.name}</strong>
                        {env?.envType === "remote" && env.remoteHost ? (
                          <span className="env-tag remote" title={`主机: ${env.remoteHost} 目录: ${env.remoteDir}`}>
                            ☁️ 远端主机：{env.remoteHost}
                          </span>
                        ) : (
                          <span className="env-tag local">
                            🖥 本机隔离工作区
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="col-desc">
                      <span className="target-node-pill">{s.targetWorkflowName}</span>
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
                        >
                          ✕
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

      {/* Modal: Add Schedule with Time Widget & Agent Selection & Server Context */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div
            className="apple-modal-card"
            style={{ width: "540px", maxHeight: "90vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建定时规则</h3>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
              使用时间小组件点选时间，分配具体 Agent 节点执行，并配置服务器环境上下文。
            </p>

            <form onSubmit={handleAddSchedule} className="modal-body-form" style={{ marginTop: "12px" }}>
              {/* 1. Time Widget (时间小组件) */}
              <div className="time-widget-box">
                <span className="field-subhead">1. 触发时间规格 (时间小组件)</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <label>
                    执行频率
                    <select
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value as typeof frequency)}
                    >
                      <option value="daily">每天 (Daily)</option>
                      <option value="workdays">工作日 (周一至周五)</option>
                      <option value="weekly">每周 (Weekly)</option>
                      <option value="hourly">每小时 (Hourly)</option>
                      <option value="custom">自定义 Cron 表达式</option>
                    </select>
                  </label>

                  {frequency !== "custom" && frequency !== "hourly" && (
                    <label>
                      时间点 (小时 : 分钟)
                      <input
                        type="time"
                        required
                        value={timePickerValue}
                        onChange={(e) => setTimePickerValue(e.target.value)}
                      />
                    </label>
                  )}

                  {frequency === "weekly" && (
                    <label>
                      每周几
                      <select
                        value={weekdayValue}
                        onChange={(e) => setWeekdayValue(e.target.value)}
                      >
                        <option value="1">周一 (Monday)</option>
                        <option value="2">周二 (Tuesday)</option>
                        <option value="3">周三 (Wednesday)</option>
                        <option value="4">周四 (Thursday)</option>
                        <option value="5">周五 (Friday)</option>
                        <option value="6">周六 (Saturday)</option>
                        <option value="0">周日 (Sunday)</option>
                      </select>
                    </label>
                  )}

                  {frequency === "custom" && (
                    <label>
                      Cron 表达式
                      <input
                        required
                        placeholder="例如：0 2 * * *"
                        value={customCron}
                        onChange={(e) => setCustomCron(e.target.value)}
                      />
                    </label>
                  )}
                </div>

                <div className="spec-preview-bar">
                  <span>设定预览：</span>
                  <strong>{computeScheduleSpec().human}</strong>
                  <code>(Cron: {computeScheduleSpec().cron})</code>
                </div>
              </div>

              {/* 2. Task Description & Agent Assignment */}
              <div style={{ marginTop: "4px" }}>
                <label>
                  任务描述 (需要定时执行的具体操作)
                  <input
                    required
                    placeholder="例如：拉取最新主干分支，执行全量单元测试与回归套件"
                    value={taskDescription}
                    onChange={(e) => setTaskDescription(e.target.value)}
                  />
                </label>
              </div>

              <div>
                <label>
                  分配执行 Agent 节点 (直接分配给具体 Agent)
                  <select
                    value={assignedAgent}
                    onChange={(e) => setAssignedAgent(e.target.value)}
                  >
                    {agentNodeOptions.map((opt) => (
                      <option key={opt.id} value={opt.label}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {/* 3. Server & Execution Environment Context (解决服务器信息与自然语言跑偏的担忧) */}
              <div className="env-context-box">
                <span className="field-subhead">2. 执行目标环境与服务器上下文 (防止执行越界)</span>
                <div style={{ display: "flex", gap: "16px", marginBottom: "8px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="envType"
                      checked={targetEnvType === "local"}
                      onChange={() => setTargetEnvType("local")}
                    />
                    <span>🖥 本机工作区 (Local Workspace)</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input
                      type="radio"
                      name="envType"
                      checked={targetEnvType === "remote"}
                      onChange={() => setTargetEnvType("remote")}
                    />
                    <span>☁️ 远端 Linux 服务器 (Remote SSH Host)</span>
                  </label>
                </div>

                {targetEnvType === "remote" ? (
                  <div className="remote-env-fields">
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 100px", gap: "8px" }}>
                      <label>
                        服务器主机/IP
                        <input
                          required
                          placeholder="例如：192.168.1.100 或 prod-server"
                          value={remoteHost}
                          onChange={(e) => setRemoteHost(e.target.value)}
                        />
                      </label>
                      <label>
                        端口
                        <input
                          type="number"
                          value={remotePort}
                          onChange={(e) => setRemotePort(Number(e.target.value))}
                        />
                      </label>
                      <label>
                        登录用户
                        <input
                          value={remoteUser}
                          onChange={(e) => setRemoteUser(e.target.value)}
                        />
                      </label>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginTop: "6px" }}>
                      <label>
                        远程执行工作目录
                        <input
                          value={remoteDir}
                          onChange={(e) => setRemoteDir(e.target.value)}
                          placeholder="/var/log 或 /opt/app"
                        />
                      </label>
                      <label>
                        认证凭证方式
                        <select
                          value={authMethod}
                          onChange={(e) => setAuthMethod(e.target.value)}
                        >
                          <option value="ssh_key">本机 SSH Key 免密 (推荐)</option>
                          <option value="ssh_agent">SSH_AUTH_SOCK 凭据代理</option>
                        </select>
                      </label>
                    </div>

                    <p className="env-assurance-note">
                      🔒 <strong>上下文保障</strong>：系统在唤醒 Agent 时会将上述服务器地址、工作目录与 SSH 访问凭证作为结构化不可变上下文注入，确保 Agent 精准操作指定主机，避免由于自然语言模糊产生跑偏或虚构。
                    </p>
                  </div>
                ) : (
                  <p style={{ fontSize: "11px", color: "#86868b", marginTop: "4px" }}>
                    默认在当前工作区运行，由本地独立 Runner 驱动，自动在独立 Git Worktree 隔离分支中执行，不干扰主干代码。
                  </p>
                )}
              </div>

              <div className="modal-btn-row" style={{ marginTop: "14px" }}>
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
            style={{ width: "600px" }}
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
                  编辑规则
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
                  任务描述内容
                  <input
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </label>

                <label>
                  执行时间规格
                  <input
                    required
                    value={editCron}
                    onChange={(e) => setEditCron(e.target.value)}
                  />
                </label>

                <label>
                  分配执行 Agent 节点
                  <select
                    value={editAgent}
                    onChange={(e) => setEditAgent(e.target.value)}
                  >
                    {agentNodeOptions.map((opt) => (
                      <option key={opt.id} value={opt.label}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>

                {envConfigs[selectedSchedule.id] && (
                  <div style={{ padding: "8px 12px", background: "#f5f5f7", borderRadius: "8px", fontSize: "11px", color: "#86868b" }}>
                    <strong>绑定的目标环境：</strong>
                    {envConfigs[selectedSchedule.id].envType === "remote" ? (
                      <span>远端主机 {envConfigs[selectedSchedule.id].remoteHost} ({envConfigs[selectedSchedule.id].remoteDir})</span>
                    ) : (
                      <span>本机隔离工作区</span>
                    )}
                  </div>
                )}

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
                    尚未触发过执行。点击任务行“触发”即可验证执行凭证。
                  </p>
                ) : (
                  executionLogs[selectedSchedule.id].map((log, idx) => (
                    <div key={idx} className={`schedule-log-item ${log.status}`}>
                      <div className="log-item-header">
                        <span className={`apple-pill ${log.status === "succeeded" ? "succeeded" : "failed"}`}>
                          {log.status === "succeeded" ? "✓ 成功" : "! 失败"}
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
