import { useEffect, useState, useCallback } from "react";
import {
  listGoals,
  saveGoal,
  toggleMilestone,
  deleteGoal,
  createMockDevelopmentTask,
  type GoalRecord,
} from "./api";

interface Props {
  onNavigateToRun: (runId: string) => void;
  onRefreshRuns: () => Promise<void>;
}

// Preset plan templates for complex engineering initiatives
const planTemplates = [
  {
    title: "微服务架构与多租户数据库隔离重构",
    description: "将单体数据库改造为多租户 WAL 模式隔离，并重构核心持久层连接池与缓存策略。",
    milestones: [
      "阶段一：领域模型契约设计与数据库 Migration 脚本编写",
      "阶段二：实现多租户资源排队锁与独立 Git Worktree 隔离机制",
      "阶段三：构建自动化压力测试、回归套件并进行端到端审查交付",
    ],
  },
  {
    title: "分布式任务调度引擎与容灾重试系统",
    description: "实现毫秒级 Cron 解析、重叠执行跳过机制与异常状态自动告警与回滚。",
    milestones: [
      "阶段一：重构 Scheduler 核心状态机与不可变事件日志",
      "阶段二：实现进程组崩溃防护与孤儿任务自动回收",
      "阶段三：对接定时任务大盘监控与告警凭证收集",
    ],
  },
  {
    title: "端到端自动化审查与代码规范合规门禁",
    description: "引入多模型协作 Review 机制，自动识别阻断级缺陷与安全边界隐患。",
    milestones: [
      "阶段一：制定 AST 静态扫描规则与静态审查 Agent 预设",
      "阶段二：实现 Checkpoint Diff 自动分析与变更集打标",
      "阶段三：打通人工批准与自动化合并流程闭环",
    ],
  },
];

export function PlanningView({ onNavigateToRun, onRefreshRuns }: Props) {
  const [plans, setPlans] = useState<GoalRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Modal State
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBudget, setNewBudget] = useState(30);
  const [newDeadline, setNewDeadline] = useState("2026-11-15");
  const [customMilestones, setCustomMilestones] = useState<string[]>([
    "阶段一：需求深度分析与系统架构设计",
    "阶段二：核心模块编码与本地 Checkpoint 提交",
    "阶段三：回归测试、代码审查与人工准入确认",
  ]);

  // Track dispatched runs locally: milestoneId -> runId
  const [dispatchedMap, setDispatchedMap] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem("agentflow_dispatched_milestones_v1");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const loadPlans = useCallback(async () => {
    try {
      const list = await listGoals();
      setPlans(list);
    } catch (err) {
      setMessage(`加载项目规划失败: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const handleApplyTemplate = (tmpl: (typeof planTemplates)[0]) => {
    setNewTitle(tmpl.title);
    setNewDesc(tmpl.description);
    setCustomMilestones(tmpl.milestones);
  };

  const handleToggleMilestone = async (milestoneId: string) => {
    setBusy(true);
    try {
      await toggleMilestone(milestoneId);
      await loadPlans();
    } catch (err) {
      setMessage(`更新阶段目标失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDeletePlan = async (id: string) => {
    setBusy(true);
    try {
      await deleteGoal(id);
      await loadPlans();
      setMessage("规划项目已移除。");
    } catch (err) {
      setMessage(`删除失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const planId = `plan-${Date.now()}`;
      const validMilestones = customMilestones.filter((m) => m.trim().length > 0);
      const newPlan: GoalRecord = {
        id: planId,
        title: newTitle.trim(),
        description: newDesc.trim() || "复杂工程规划与阶段性目标推进。",
        status: "in_progress",
        deadline: newDeadline.trim() || "2026-12-01",
        actionsUsed: 0,
        actionsBudget: Number(newBudget) || 30,
        createdAt: new Date().toISOString(),
        milestones: validMilestones.map((title, idx) => ({
          id: `m-${Date.now()}-${idx}`,
          goalId: planId,
          title: title.trim(),
          completed: false,
          sortOrder: idx + 1,
        })),
      };
      await saveGoal(newPlan);
      await loadPlans();
      setShowModal(false);
      setNewTitle("");
      setNewDesc("");
      setMessage(`项目规划【${newPlan.title}】已创建，可开始按阶段派发任务。`);
    } catch (err) {
      setMessage(`创建规划失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Dispatch a single milestone into the Task List as an executable run
  const handleDispatchMilestone = async (plan: GoalRecord, milestoneTitle: string, milestoneId: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await createMockDevelopmentTask(
        {
          title: `[规划派发] ${milestoneTitle}`,
          description: `所属宏观规划：${plan.title}\n规划背景：${plan.description}`,
          acceptanceCriteria: [
            `完成阶段目标【${milestoneTitle}】的代码落地`,
            "通过单元回归测试与 Review 审查",
            "提交 Checkpoint 交付验证",
          ],
        },
        "/Users/yida/项目/TaskBoard",
        "test_then_review_retry"
      );

      const updated = { ...dispatchedMap, [milestoneId]: created.runId };
      setDispatchedMap(updated);
      localStorage.setItem("agentflow_dispatched_milestones_v1", JSON.stringify(updated));

      await onRefreshRuns();
      setMessage(`阶段【${milestoneTitle}】已成功派发为任务！Run ID: ${created.runId.slice(0, 8)}`);
      // Navigate to task detail directly
      onNavigateToRun(created.runId);
    } catch (err) {
      setMessage(`派发任务失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="planning-page">
      {/* Header */}
      <div className="page-header-row">
        <div>
          <h1>项目规划</h1>
          <p className="page-subtitle">
            复杂与大型需求分析中心。自顶向下拆解架构阶段目标，并按需一键派发至任务列表独立闭环执行。
          </p>
        </div>
        <button
          className="apple-btn-primary"
          type="button"
          onClick={() => setShowModal(true)}
        >
          + 新建立项规划
        </button>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      {/* Plans List */}
      <div className="planning-grid">
        {plans.length === 0 ? (
          <div className="apple-empty-card" style={{ gridColumn: "1 / -1" }}>
            <p style={{ fontWeight: 600, color: "#1d1d1f", marginBottom: "6px" }}>暂无立项规划</p>
            <p>
              面对大型功能或复杂系统演进，可在此立项并拆解阶段目标。点击右上角“+ 新建立项规划”开始。
            </p>
          </div>
        ) : (
          plans.map((p) => {
            const completedCount = p.milestones.filter((m) => m.completed).length;
            const totalCount = p.milestones.length;
            const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

            return (
              <div key={p.id} className="planning-card">
                <div className="planning-card-top">
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <h3>{p.title}</h3>
                      <span className={`apple-pill ${p.status}`}>
                        {percent === 100 ? "已全部交付" : `${percent}% 完成`}
                      </span>
                    </div>
                    <p className="planning-card-desc">{p.description}</p>
                  </div>
                  <button
                    className="apple-icon-btn"
                    type="button"
                    title="移除规划"
                    disabled={busy}
                    onClick={() => void handleDeletePlan(p.id)}
                  >
                    ✕
                  </button>
                </div>

                {/* Progress Bar */}
                <div className="planning-progress-section">
                  <div className="planning-progress-info">
                    <span>阶段进度 ({completedCount}/{totalCount})</span>
                    <span>目标交付期：{p.deadline}</span>
                  </div>
                  <div className="planning-progress-bar">
                    <div
                      className="planning-progress-fill"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>

                {/* Milestones / Phased Tasks Breakdown */}
                <div className="milestones-container">
                  <div className="milestones-heading">
                    <span>阶段性拆解目标 (按时序推进)</span>
                    <small>可直接派发到任务列表并发执行</small>
                  </div>

                  <div className="milestones-list">
                    {p.milestones.map((m, idx) => {
                      const dispatchedRunId = dispatchedMap[m.id];

                      return (
                        <div
                          key={m.id}
                          className={`milestone-row ${m.completed ? "completed" : ""}`}
                        >
                          <div className="milestone-left">
                            <input
                              type="checkbox"
                              checked={m.completed}
                              onChange={() => void handleToggleMilestone(m.id)}
                            />
                            <div className="milestone-text-block">
                              <span className="milestone-title">
                                <strong>第 {idx + 1} 阶段：</strong> {m.title}
                              </span>
                              {dispatchedRunId && (
                                <span className="dispatched-tag">
                                  🔗 已派发执行：
                                  <button
                                    type="button"
                                    className="link-btn"
                                    onClick={() => onNavigateToRun(dispatchedRunId)}
                                  >
                                    Run #{dispatchedRunId.slice(0, 8)}
                                  </button>
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="milestone-actions">
                            {!m.completed && !dispatchedRunId && (
                              <button
                                className="apple-btn-secondary milestone-dispatch-btn"
                                type="button"
                                disabled={busy}
                                onClick={() => void handleDispatchMilestone(p, m.title, m.id)}
                              >
                                ⚡️ 派发为任务
                              </button>
                            )}
                            {dispatchedRunId && (
                              <button
                                className="apple-btn-secondary milestone-dispatch-btn"
                                type="button"
                                onClick={() => onNavigateToRun(dispatchedRunId)}
                              >
                                查看执行进度 →
                              </button>
                            )}
                            {m.completed && (
                              <span className="completed-badge">✓ 已达标</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal: Create Planning & Spec Breakdown */}
      {showModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="apple-modal-card"
            style={{ width: "620px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建复杂需求立项与阶段拆解</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px" }}>
              输入大需求概览，系统将按工程生命周期拆解为各阶段里程碑，后续可独立派发至任务执行。
            </p>

            {/* Presets / Templates */}
            <div className="template-chips-row">
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#86868b" }}>
                推荐架构模板：
              </span>
              {planTemplates.map((t, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="template-chip"
                  onClick={() => handleApplyTemplate(t)}
                >
                  {t.title.slice(0, 10)}…
                </button>
              ))}
            </div>

            <form onSubmit={handleCreatePlan} className="modal-body-form">
              <label>
                规划项目名称
                <input
                  required
                  placeholder="例如：重构数据库持久层支持 WAL 与多租户连接池"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </label>

              <label>
                需求背景与技术方案概述
                <textarea
                  rows={3}
                  placeholder="描述系统现状、面临瓶颈、核心改造目标与交付标准…"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label>
                  计划交付日期
                  <input
                    type="date"
                    value={newDeadline}
                    onChange={(e) => setNewDeadline(e.target.value)}
                  />
                </label>
                <label>
                  预估动作步骤预算 (Step Budget)
                  <input
                    type="number"
                    min={10}
                    max={100}
                    value={newBudget}
                    onChange={(e) => setNewBudget(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="custom-milestones-field">
                <label style={{ marginBottom: "6px" }}>阶段性拆解目标 (按执行时序)：</label>
                {customMilestones.map((m, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "8px", marginBottom: "6px" }}>
                    <input
                      value={m}
                      onChange={(e) => {
                        const updated = [...customMilestones];
                        updated[idx] = e.target.value;
                        setCustomMilestones(updated);
                      }}
                    />
                    {customMilestones.length > 1 && (
                      <button
                        type="button"
                        className="apple-icon-btn"
                        onClick={() => {
                          setCustomMilestones(customMilestones.filter((_, i) => i !== idx));
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="apple-btn-secondary"
                  style={{ fontSize: "12px", marginTop: "4px" }}
                  onClick={() => setCustomMilestones([...customMilestones, `阶段${customMilestones.length + 1}：新增阶段目标`])}
                >
                  + 添加阶段
                </button>
              </div>

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
                  {busy ? "创建中…" : "立项并生成阶段目标"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
