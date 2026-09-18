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
  const [newBudget, setNewBudget] = useState(30);

  const loadGoals = useCallback(async () => {
    try {
      const list = await listGoals();
      setGoals(list);
    } catch (err) {
      setMessage(`加载目标失败: ${String(err)}`);
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
        actionsBudget: Number(newBudget) || 25,
        createdAt: new Date().toISOString(),
        milestones: [
          { id: `m-${Date.now()}-1`, goalId, title: "需求拆解与架构设计", completed: false, sortOrder: 1 },
          { id: `m-${Date.now()}-2`, goalId, title: "核心模块实现与测试", completed: false, sortOrder: 2 },
          { id: `m-${Date.now()}-3`, goalId, title: "端到端闭环与成果验收", completed: false, sortOrder: 3 },
        ],
      };
      await saveGoal(newGoal);
      await loadGoals();
      setShowModal(false);
      setNewTitle("");
      setNewDesc("");
      setMessage(`长期目标 ${newGoal.title} 已创建。`);
    } catch (err) {
      setMessage(`创建目标失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="goals-page">
      <div className="page-header-row">
        <div>
          <h1>长期目标</h1>
          <p className="page-subtitle">
            跨多个任务与 Attempt 的宏观业务目标，追踪里程碑进度与动作执行预算。
          </p>
        </div>
        <button
          className="apple-btn-primary"
          type="button"
          onClick={() => setShowModal(true)}
        >
          + 新建长期目标
        </button>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      <div className="goals-cards-grid">
        {goals.map((g) => {
          const completedCount = g.milestones.filter((m) => m.completed).length;
          const totalCount = g.milestones.length;
          const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

          return (
            <div key={g.id} className="goal-apple-card">
              <div className="goal-card-top">
                <div>
                  <h3>{g.title}</h3>
                  <p className="goal-card-desc">{g.description}</p>
                </div>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                  <span className={`apple-pill ${g.status}`}>
                    {g.status === "completed" ? "已完成" : g.status === "paused" ? "已暂停" : "推进中"}
                  </span>
                  <button
                    className="apple-icon-btn"
                    type="button"
                    title="删除"
                    disabled={busy}
                    onClick={() => void handleDeleteGoal(g.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="goal-progress-bar-container">
                <div className="goal-progress-meta">
                  <span>里程碑完成度: {completedCount} / {totalCount} ({percent}%)</span>
                  <span>预算消耗: {g.actionsUsed} / {g.actionsBudget} 步</span>
                </div>
                <div className="goal-track">
                  <div className="goal-fill" style={{ width: `${percent}%` }} />
                </div>
              </div>

              <div className="goal-milestones-box">
                {g.milestones.map((m) => (
                  <label key={m.id} className="apple-checkbox-item">
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

              <div className="goal-card-bottom">
                <small>预期交付期限: {g.deadline}</small>
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <div
          className="apple-modal-backdrop"
          onClick={() => setShowModal(false)}
        >
          <div
            className="apple-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建长期目标</h3>
            <form onSubmit={handleAddGoal} className="modal-body-form">
              <label>
                目标名称
                <input
                  required
                  placeholder="例如：重构系统日志流与增量展示引擎"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </label>

              <label>
                目标描述
                <textarea
                  required
                  rows={3}
                  placeholder="描述该宏观目标的业务价值与最终交付条件…"
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
                动作预算上限 (步)
                <input
                  type="number"
                  min={5}
                  max={200}
                  value={newBudget}
                  onChange={(e) => setNewBudget(Number(e.target.value))}
                />
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
                  {busy ? "保存中…" : "确认创建"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
