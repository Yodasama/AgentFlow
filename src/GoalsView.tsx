import { useState } from "react";

interface Milestone {
  id: string;
  title: string;
  completed: boolean;
}

interface GoalItem {
  id: string;
  title: string;
  description: string;
  status: "in_progress" | "paused" | "completed";
  deadline: string;
  actionsUsed: number;
  actionsBudget: number;
  milestones: Milestone[];
}

const initialGoals: GoalItem[] = [
  {
    id: "goal-1",
    title: "构建端到端高可靠 Agent 本地开发闭环",
    description: "实现通过本地独立 runner 驱动 Agent 完成任务分析、代码修改、真实 Git Checkpoint 生成、自动化测试与 Review 返工。",
    status: "in_progress",
    deadline: "2026-10-01",
    actionsUsed: 14,
    actionsBudget: 50,
    milestones: [
      { id: "m-1", title: "Git Worktree 隔离与 Checkpoint 幂等留痕 (P5)", completed: true },
      { id: "m-2", title: "独立 Runner 进程、双流重定向与超时控制 (P3)", completed: true },
      { id: "m-3", title: "工作流不可变版本与人工审批机制 (P6)", completed: true },
      { id: "m-4", title: "React Flow 可视化工作流设计器 (P9)", completed: true },
      { id: "m-5", title: "真实 Codex / Claude CLI 生产适配器对接 (P4)", completed: false },
    ],
  },
  {
    id: "goal-2",
    title: "本地 Agent 故障恢复矩阵与数据自愈",
    description: "模拟宿主进程 SIGKILL、睡眠唤醒、磁盘写满与断网，保证事务对账与零双开。",
    status: "in_progress",
    deadline: "2026-10-15",
    actionsUsed: 8,
    actionsBudget: 30,
    milestones: [
      { id: "m-21", title: "prepared 阶段宿主异常退出自动恢复测试", completed: true },
      { id: "m-22", title: "未知状态保留资源锁与防重复领取", completed: true },
      { id: "m-23", title: "崩溃恢复控制中心与手动强制干预", completed: false },
    ],
  },
];

export function GoalsView() {
  const [goals, setGoals] = useState<GoalItem[]>(initialGoals);
  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBudget, setNewBudget] = useState(20);

  const toggleMilestone = (goalId: string, milestoneId: string) => {
    setGoals((prev) =>
      prev.map((g) => {
        if (g.id !== goalId) return g;
        const updatedMilestones = g.milestones.map((m) =>
          m.id === milestoneId ? { ...m, completed: !m.completed } : m
        );
        const allDone = updatedMilestones.every((m) => m.completed);
        return {
          ...g,
          milestones: updatedMilestones,
          status: allDone ? "completed" : g.status,
        };
      })
    );
  };

  const handleAddGoal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const newGoal: GoalItem = {
      id: `goal-${Date.now()}`,
      title: newTitle.trim(),
      description: newDesc.trim(),
      status: "in_progress",
      deadline: "2026-11-01",
      actionsUsed: 0,
      actionsBudget: Number(newBudget) || 20,
      milestones: [
        { id: `m-${Date.now()}-1`, title: "阶段一：需求拆解与架构设计", completed: false },
        { id: `m-${Date.now()}-2`, title: "阶段二：核心功能实现与测试", completed: false },
      ],
    };
    setGoals((prev) => [newGoal, ...prev]);
    setShowModal(false);
    setNewTitle("");
    setNewDesc("");
  };

  return (
    <div className="goals-view-container">
      <div className="goals-header">
        <div>
          <h2>长期目标与里程碑 (P10)</h2>
          <p className="subtitle">
            针对需要跨多次运行、持续演进的大型任务设置宏观目标、里程碑检查点与总执行预算。
          </p>
        </div>
        <button className="primary" type="button" onClick={() => setShowModal(true)}>
          + 新建长期目标
        </button>
      </div>

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
                <span className={`state-tag ${g.status}`}>
                  {g.status === "completed" ? "已完成" : g.status === "paused" ? "已暂停" : "推进中"}
                </span>
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
                      onChange={() => toggleMilestone(g.id, m.id)}
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
              <h3>新建长期目标</h3>
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
                <button className="primary" type="submit">
                  创建目标
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
