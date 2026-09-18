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

export function SchedulesView({ onTriggerRun, onRefresh }: Props) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCron, setNewCron] = useState("0 3 * * *");
  const [newWorkflow, setNewWorkflow] = useState("标准开发闭环工作流");

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

  const handleToggle = async (id: string) => {
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

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await deleteSchedule(id);
      await loadSchedules();
      setMessage("定时任务已从数据库删除。");
    } catch (err) {
      setMessage(`删除失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleTriggerNow = async (sched: ScheduleRecord) => {
    setBusy(true);
    setMessage(null);
    try {
      const run = await createMockTask({
        title: `[计划调度] ${sched.name}`,
        description: `按 Cron 规则 ${sched.cron} 触发派发。`,
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

  const handleAddSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const newItem: ScheduleRecord = {
        id: `sched-${Date.now()}`,
        name: newName.trim(),
        cron: newCron.trim(),
        timezone: "Asia/Shanghai (本机时区)",
        targetWorkflowName: newWorkflow.trim(),
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };
      await saveSchedule(newItem);
      await loadSchedules();
      setShowModal(false);
      setNewName("");
      setMessage(`定时任务 ${newItem.name} 已保存到 SQLite。`);
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedules-view-container">
      <div className="schedules-header">
        <div>
          <h2>定时任务管理 (P10)</h2>
          <p className="subtitle">
            基于 SQLite 持久化存储与 Cron 调度规则。支持重叠跳过策略（上一次未完成时不重复派发）与时区绑定。
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
                disabled={busy}
                onClick={() => void handleToggle(s.id)}
              >
                {s.active ? "运行中" : "已暂停"}
              </button>
            </div>
            <dl className="schedule-meta">
              <div>
                <dt>目标工作流</dt>
                <dd>{s.targetWorkflowName}</dd>
              </div>
              <div>
                <dt>绑定时区</dt>
                <dd>{s.timezone}</dd>
              </div>
              <div>
                <dt>重叠策略</dt>
                <dd>{s.overlapPolicy === "skip" ? "重叠跳过 (Skip overlap)" : "排队等待"}</dd>
              </div>
              <div>
                <dt>上次执行</dt>
                <dd>{s.lastRunAt ?? "尚未执行"}</dd>
              </div>
            </dl>
            <div className="schedule-card-actions" style={{ gap: "8px" }}>
              <button
                className="secondary"
                type="button"
                style={{ color: "#f87171" }}
                disabled={busy}
                onClick={() => void handleDelete(s.id)}
              >
                删除
              </button>
              <button
                className="primary"
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
              <h3>新建定时调度规则 (SQLite 持久化)</h3>
              <button className="close-btn" type="button" onClick={() => setShowModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleAddSchedule} className="create-form">
              <label>
                规则名称
                <input
                  required
                  placeholder="例如：每日午夜全量分支代码巡检"
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
              <label>
                目标工作流名称
                <input
                  required
                  value={newWorkflow}
                  onChange={(e) => setNewWorkflow(e.target.value)}
                />
              </label>
              <p className="form-hint">格式：分 时 日 月 周。支持标准 5 段式 Unix Cron 规则。</p>
              <div className="modal-actions">
                <button className="secondary" type="button" onClick={() => setShowModal(false)}>
                  取消
                </button>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? "保存中…" : "保存并写入 SQLite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
