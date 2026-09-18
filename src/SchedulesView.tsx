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

  // Modal Fields: 什么时间、什么内容、哪个节点、支持什么功能
  const [scheduleTime, setScheduleTime] = useState("每日 02:00 (0 2 * * *)");
  const [scheduleContent, setScheduleContent] = useState("");
  const [targetNode, setTargetNode] = useState("自动化测试节点");
  const [supportedFunction, setSupportedFunction] = useState("全量回归与代码安全扫描");

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
      setMessage("定时任务已从数据库移除。");
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
        title: `[定时任务触发] ${sched.name}`,
        description: `执行时间：${sched.cron} · 目标节点：${sched.targetWorkflowName}`,
        acceptanceCriteria: ["定时调度派发成功", "节点执行验证完成"],
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
      setShowModal(false);
      setScheduleContent("");
      setMessage(`定时任务 ${newItem.name} 已保存并生效。`);
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schedules-page">
      <div className="page-header-row">
        <div>
          <h1>定时任务</h1>
          <p className="page-subtitle">
            配置计划规则自动运行。支持指定执行时间、任务内容、目标节点与支持功能。
          </p>
        </div>
        <button
          className="apple-btn-primary"
          type="button"
          onClick={() => setShowModal(true)}
        >
          + 新建定时规则
        </button>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      <div className="schedules-list-container">
        {schedules.length === 0 ? (
          <div className="apple-empty-card">
            <p>暂无定时任务。点击右上角“+ 新建定时规则”添加。</p>
          </div>
        ) : (
          schedules.map((s) => (
            <div key={s.id} className="schedule-row-card">
              <div className="schedule-card-main">
                <div className="schedule-card-headline">
                  <h3>{s.name}</h3>
                  <span className="cron-badge">⏰ {s.cron}</span>
                </div>
                <div className="schedule-card-details">
                  <span>🎯 目标节点与功能：<strong>{s.targetWorkflowName}</strong></span>
                  <span>防重叠：<strong>重叠跳过 (Skip)</strong></span>
                  <span>上次执行：{s.lastRunAt ?? "尚未执行"}</span>
                </div>
              </div>

              <div className="schedule-card-controls">
                <button
                  type="button"
                  className={`apple-toggle-pill ${s.active ? "active" : "paused"}`}
                  disabled={busy}
                  onClick={() => void handleToggle(s.id)}
                >
                  {s.active ? "运行中" : "已暂停"}
                </button>
                <button
                  className="apple-btn-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleTriggerNow(s)}
                >
                  立即运行
                </button>
                <button
                  className="apple-btn-secondary"
                  type="button"
                  style={{ color: "#e03e1a" }}
                  disabled={busy}
                  onClick={() => void handleDelete(s.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal: 新建定时任务 */}
      {showModal && (
        <div
          className="apple-modal-backdrop"
          onClick={() => setShowModal(false)}
        >
          <div
            className="apple-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建定时任务</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px", marginBottom: "16px" }}>
              明确指定执行时间、任务内容、对应节点与支持功能。
            </p>

            <form onSubmit={handleAddSchedule} className="modal-body-form">
              <label>
                什么时间 (执行时间 / 周期)
                <select
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                >
                  <option value="每日 02:00 (0 2 * * *)">每日凌晨 02:00 (0 2 * * *)</option>
                  <option value="每两小时 (0 */2 * * *)">每两小时 (0 */2 * * *)</option>
                  <option value="每周一 09:00 (0 9 * * 1)">每周一上午 09:00 (0 9 * * 1)</option>
                  <option value="工作日 18:00 (0 18 * * 1-5)">工作日 18:00 (0 18 * * 1-5)</option>
                  <option value="每 30 分钟 (*/30 * * * *)">每 30 分钟 (*/30 * * * *)</option>
                </select>
              </label>

              <label>
                什么内容 (任务描述与目标)
                <textarea
                  required
                  rows={2}
                  placeholder="例如：全量运行单元测试并审查未提交的改动…"
                  value={scheduleContent}
                  onChange={(e) => setScheduleContent(e.target.value)}
                />
              </label>

              <label>
                哪个节点 (执行目标节点)
                <select
                  value={targetNode}
                  onChange={(e) => setTargetNode(e.target.value)}
                >
                  <option value="自动化测试节点">自动化测试节点 (Tests Runner)</option>
                  <option value="代码审查节点">代码审查节点 (Reviewer Agent)</option>
                  <option value="核心开发节点">核心开发节点 (Developer Agent)</option>
                  <option value="需求分析节点">需求分析节点 (Architect Agent)</option>
                </select>
              </label>

              <label>
                支持什么功能 (功能职责)
                <select
                  value={supportedFunction}
                  onChange={(e) => setSupportedFunction(e.target.value)}
                >
                  <option value="全量回归与代码安全扫描">全量回归与代码安全扫描</option>
                  <option value="系统自检与 SQLite WAL 状态对账">系统自检与 SQLite WAL 状态对账</option>
                  <option value="依赖漏洞排查与合规审查">依赖漏洞排查与合规审查</option>
                  <option value="死代码检测与模块瘦身">死代码检测与模块瘦身</option>
                </select>
              </label>

              <div className="modal-btn-row">
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  取消
                </button>
                <button
                  className="apple-btn-primary"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? "保存中…" : "确认添加"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
