import { useEffect, useState, useCallback } from "react";
import {
  listGoals,
  saveGoal,
  toggleMilestone,
  deleteGoal,
  type GoalRecord,
} from "./api";

export function GoalsView() {
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDeadline, setNewDeadline] = useState("2026-10-30");
  const [newBudget, setNewBudget] = useState(25);

  const loadGoals = useCallback(async () => {
    try {
      const list = await listGoals();
      setGoals(list);
    } catch (err) {
      setMessage(`加载长期目标失败: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void loadGoals();
  }, [loadGoals]);

  const handleToggleMilestone = async (milestoneId: string) => {
    setBusy(true);
    try {
      await toggleMilestone(milestoneId);
      await loadGoals();
    } catch (err) {
      setMessage(`更新里程碑失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteGoal = async (id: string) => {
    setBusy(true);
    try {
      await deleteGoal(id);
      await loadGoals();
      setMessage("长期目标已从数据库移除。");
    } catch (err) {
      setMessage(`删除目标失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleAddGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const goalId = `goal-${Date.now()}`;
      const newGoal: GoalRecord = {
        id: goalId,
        title: newTitle.trim(),
        description: newDesc.trim(),
        status: "in_progress",
        deadline: newDeadline.trim() || "2026-11-01",
        actionsUsed: 0,
        actionsBudget: Number(newBudget) || 20,
        createdAt: new Date().toISOString(),
        milestones: [
          { id: `m-${Date.now()}-1`, goalId, title: "阶段一：需求拆解与架构设计", completed: false, sortOrder: 1 },
          { id: `m-${Date.now()}-2`, goalId, title: "阶段二：核心功能实现与单元验证", completed: false, sortOrder: 2 },
          { id: `m-${Date.now()}-3`, goalId, title: "阶段三：端到端闭环与成果验收", completed: false, sortOrder: 3 },
        ],
      };
      await saveGoal(newGoal);
      await loadGoals();
      setShowModal(false);
      setNewTitle("");
      setNewDesc("");
      setMessage(`长期目标 ${newGoal.title} 已持久化到 SQLite。`);
    } catch (err) {
      setMessage(`创建目标失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="goals-view-container">
      <div className="goals-header">
        <div>
          <h2>长期目标与里程碑 (P10)</h2>
          <p className="subtitle">
            跨多个任务与 Attempt 的宏观业务目标。通过 SQLite 持久化管理里程碑检查点与动作预算（Action Budget）。
          </p>
        </div>
        <button className="primary" type="button" onClick={() => setShowModal(true)}>
          + 新建长期目标
        </button>
      </div>

      {message && (
        <p role="status" className="info-banner">
          {message}
        </p>
      )}

      <div className="goals-grid">
        {goals.map((g) => {
          const completedCount = g.milestones.filter((m) => m.completed).length;
          const totalCount = g.milestones.length;
          const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

          return (
            <article key={g.id} className="goal-card">
              <div className="goal-card-top">
                <div>
                  <h3>{g.title}</h3>
                  <p className="goal-desc">{g.description}</p>
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span className={`state-tag ${g.status}`}>
                    {g.status === "completed" ? "已完成" : g.status === "paused" ? "已暂停" : "推进中"}
                  </span>
                  <button
                    className="close-btn"
                    type="button"
                    title="删除目标"
                    disabled={busy}
                    onClick={() => void handleDeleteGoal(g.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="progress-section">
                <div className="progress-label">
                  <span>里程碑完成度: {completedCount} / {totalCount} ({percent}%)</span>
                  <span>
                    动作预算: {g.actionsUsed} / {g.actionsBudget} 步
                  </span>
                </div>
                <div className="progress-bar-track">
                  <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
                </div>
              </div>

              <div className="milestones-list">
                <h4>关键里程碑</h4>
                {g.milestones.map((m) => (
                  <label key={m.id} className="milestone-item">
                    <input
                      type="checkbox"
                      checked={m.completed}
                      disabled={busy}
                      onChange={() => void handleToggleMilestone(m.id)}
                    />
                    <span className={m.completed ? "done" : ""}>{m.title}</span>
                  </label>
                ))}
              </div>

              <div className="goal-card-footer">
                <small>预期交付期限: {g.deadline}</small>
              </div>
            </article>
          );
        })}
      </div>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>新建长期目标 (SQLite 持久化)</h3>
              <button className="close-btn" type="button" onClick={() => setShowModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleAddGoal} className="create-form">
              <label>
                目标名称
                <input
                  required
                  placeholder="例如：重构系统日志增量流与脱敏系统"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </label>
              <label>
                目标描述
                <textarea
                  required
                  rows={3}
                  placeholder="描述该宏观目标的业务价值与最终验收条件…"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </label>
              <label>
                预期交付期限
                <input
                  type="date"
                  value={newDeadline}
                  onChange={(e) => setNewDeadline(e.target.value)}
                />
              </label>
              <label>
                动作预算上限 (Action Budget)
                <input
                  type="number"
                  min={5}
                  max={200}
                  value={newBudget}
                  onChange={(e) => setNewBudget(Number(e.target.value))}
                />
              </label>
              <div className="modal-actions">
                <button className="secondary" type="button" onClick={() => setShowModal(false)}>
                  取消
                </button>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? "保存中…" : "创建并写入 SQLite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
