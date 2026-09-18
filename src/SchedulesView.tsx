import { useState } from "react";
import { createMockTask } from "./api";

interface ScheduleItem {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  targetWorkflow: string;
  active: boolean;
  overlapPolicy: "skip" | "wait";
  lastRunAt: string | null;
  nextRunAt: string;
}

const initialSchedules: ScheduleItem[] = [
  {
    id: "sched-1",
    name: "每日全量代码架构与安全性巡检",
    cron: "0 2 * * * (每日 02:00)",
    timezone: "Asia/Shanghai (本机时区)",
    targetWorkflow: "标准开发闭环工作流",
    active: true,
    overlapPolicy: "skip",
    lastRunAt: "2026-09-17 02:00:00",
    nextRunAt: "2026-09-19 02:00:00",
  },
  {
    id: "sched-2",
    name: "每两小时系统自检与 SQLite WAL 对账",
    cron: "0 */2 * * * (每 2 小时)",
    timezone: "Asia/Shanghai (本机时区)",
    targetWorkflow: "健康自检与资源锁验证",
    active: true,
    overlapPolicy: "skip",
    lastRunAt: "2026-09-18 08:00:00",
    nextRunAt: "2026-09-18 10:00:00",
  },
  {
    id: "sched-3",
    name: "每周五依赖合规与漏洞扫描",
    cron: "0 10 * * 5 (每周五 10:00)",
    timezone: "Asia/Shanghai (本机时区)",
    targetWorkflow: "依赖审计流水线",
    active: false,
    overlapPolicy: "skip",
    lastRunAt: null,
    nextRunAt: "2026-09-19 10:00:00",
  },
];

interface Props {
  onTriggerRun: (runId: string) => void;
  onRefresh: () => Promise<void>;
}

export function SchedulesView({ onTriggerRun, onRefresh }: Props) {
  const [schedules, setSchedules] = useState<ScheduleItem[]>(initialSchedules);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCron, setNewCron] = useState("0 3 * * *");

  const toggleActive = (id: string) => {
    setSchedules((prev) =>
      prev.map((s) => (s.id === id ? { ...s, active: !s.active } : s))
    );
  };

  const handleTriggerNow = async (sched: ScheduleItem) => {
    setBusy(true);
    setMessage(null);
    try {
      const run = await createMockTask({
        title: `[定时任务触发] ${sched.name}`,
        description: `按计划规则 ${sched.cron} 触发执行。`,
        acceptanceCriteria: ["定时调度派发成功", "资源锁释放正常"],
        outcome: "succeeded",
      });
      setMessage(`已手动触发任务: ${sched.name}，新 Run ID: ${run.runId}`);
      await onRefresh();
      onTriggerRun(run.runId);
    } catch (err) {
      setMessage(`触发失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAddSchedule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const newItem: ScheduleItem = {
      id: `sched-${Date.now()}`,
      name: newName.trim(),
      cron: newCron.trim(),
      timezone: "Asia/Shanghai (本机时区)",
      targetWorkflow: "标准开发闭环工作流",
      active: true,
      overlapPolicy: "skip",
      lastRunAt: null,
      nextRunAt: "即将计算下次运行时间",
    };
    setSchedules((prev) => [newItem, ...prev]);
    setShowModal(false);
    setNewName("");
  };

  return (
    <div className="schedules-view-container">
      <div className="schedules-header">
        <div>
          <h2>定时任务管理 (P10)</h2>
          <p className="subtitle">
            支持基于 Cron 规则的定时自动触发。具备时区绑定、重叠跳过策略（上一次未完成时不重复派发）与漏跑补偿。
          </p>
        </div>
        <button className="primary" type="button" onClick={() => setShowModal(true)}>
          + 新建定时规则
        </button>
      </div>

      {message && (
        <p role="status" className="info-banner">
          {message}
        </p>
      )}

      <div className="schedules-grid">
        {schedules.map((s) => (
          <article key={s.id} className="schedule-card">
            <div className="schedule-card-top">
              <div>
                <h3>{s.name}</h3>
                <code className="cron-tag">{s.cron}</code>
              </div>
              <button
                type="button"
                className={`toggle-btn ${s.active ? "active" : "paused"}`}
                onClick={() => toggleActive(s.id)}
              >
                {s.active ? "运行中" : "已暂停"}
              </button>
            </div>
            <dl className="schedule-meta">
              <div>
                <dt>绑定目标工作流</dt>
                <dd>{s.targetWorkflow}</dd>
              </div>
              <div>
                <dt>时区配置</dt>
                <dd>{s.timezone}</dd>
              </div>
              <div>
                <dt>重叠防范策略</dt>
                <dd>{s.overlapPolicy === "skip" ? "重叠跳过 (Skip overlap)" : "排队等待"}</dd>
              </div>
              <div>
                <dt>下次预期执行</dt>
                <dd className="highlight-time">{s.active ? s.nextRunAt : "暂停中"}</dd>
              </div>
              <div>
                <dt>上次执行完成</dt>
                <dd>{s.lastRunAt ?? "尚未执行"}</dd>
              </div>
            </dl>
            <div className="schedule-card-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void handleTriggerNow(s)}
              >
                立即手动触发一次
              </button>
            </div>
          </article>
        ))}
      </div>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建定时调度规则</h3>
              <button className="close-btn" type="button" onClick={() => setShowModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleAddSchedule} className="create-form">
              <label>
                规则名称
                <input
                  required
                  placeholder="例如：每日午夜全量分支安全审计"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <label>
                Cron 表达式
                <input
                  required
                  placeholder="0 3 * * *"
                  value={newCron}
                  onChange={(e) => setNewCron(e.target.value)}
                />
              </label>
              <p className="form-hint">格式：分 时 日 月 周。支持标准 5 段式 Unix Cron 规则。</p>
              <div className="modal-actions">
                <button className="secondary" type="button" onClick={() => setShowModal(false)}>
                  取消
                </button>
                <button className="primary" type="submit">
                  保存并启用
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
