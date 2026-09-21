import { useEffect, useState, useCallback } from "react";
import {
  listGoals,
  saveGoal,
  toggleMilestone,
  deleteGoal,
  createMockDevelopmentTask,
  type GoalRecord,
} from "./api";
import { confirmDelete } from "./confirmDelete";
import {
  IconChat,
  IconClose,
  IconLink,
  IconZap,
  IconCheck,
  IconFlame,
} from "./icons";

interface Props {
  onNavigateToRun: (runId: string) => void;
  onRefreshRuns: () => Promise<void>;
  onStartGrillMe?: (title: string, description: string) => void;
  onNavigateToTab?: (tab: string) => void;
}

export function PlanningView({
  onNavigateToRun,
  onRefreshRuns,
  onStartGrillMe,
  onNavigateToTab,
}: Props) {
  const [plans, setPlans] = useState<GoalRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Accordion state: set of plan IDs that are expanded
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());

  // Simplified Modal State: Only Title and Description
  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");

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
      // Default: expand only the first plan for a tidy screen
      setExpandedPlanIds((prev) => {
        if (prev.size === 0 && list.length > 0) {
          return new Set([list[0].id]);
        }
        return prev;
      });
    } catch (err) {
      setMessage(`加载项目规划失败: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  const togglePlanExpand = (planId: string) => {
    setExpandedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedPlanIds(new Set(plans.map((p) => p.id)));
  };

  const handleCollapseAll = () => {
    setExpandedPlanIds(new Set());
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
    const plan = plans.find((item) => item.id === id);
    if (!confirmDelete(`规划项目“${plan?.title || "未命名"}”`)) return;
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

  // Direct quick create without Grill-Me
  const handleDirectCreate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newTitle.trim()) return;

    setBusy(true);
    try {
      const planId = `plan-${Date.now()}`;
      const defaultDeadline = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);

      const newPlan: GoalRecord = {
        id: planId,
        title: newTitle.trim(),
        description: newDesc.trim() || "系统工程立项与阶段性目标推进。",
        status: "in_progress",
        deadline: defaultDeadline,
        actionsUsed: 0,
        actionsBudget: 30,
        createdAt: new Date().toISOString(),
        milestones: [
          {
            id: `m-${Date.now()}-0`,
            goalId: planId,
            title: "阶段一：需求基准建模与契约设计",
            completed: false,
            sortOrder: 1,
          },
          {
            id: `m-${Date.now()}-1`,
            goalId: planId,
            title: "阶段二：核心业务逻辑编码与本地隔离调试",
            completed: false,
            sortOrder: 2,
          },
          {
            id: `m-${Date.now()}-2`,
            goalId: planId,
            title: "阶段三：全量回归测试套件与代码审查准入",
            completed: false,
            sortOrder: 3,
          },
        ],
      };

      await saveGoal(newPlan);
      await loadPlans();
      setExpandedPlanIds((prev) => new Set([...prev, planId]));
      setShowModal(false);
      setNewTitle("");
      setNewDesc("");
      setMessage(`项目规划【${newPlan.title}】已创建。`);
    } catch (err) {
      setMessage(`创建规划失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Start Grill-Me in the dedicated Chat Tab
  const handleLaunchGrillMe = () => {
    if (!newTitle.trim()) return;
    const titleVal = newTitle.trim();
    const descVal = newDesc.trim();
    setShowModal(false);
    setNewTitle("");
    setNewDesc("");
    onStartGrillMe?.(titleVal, descVal);
  };

  const handleDispatchMilestone = async (
    planTitle: string,
    planDescription: string,
    planId: string,
    milestoneTitle: string,
    milestoneId: string
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      const created = await createMockDevelopmentTask(
        {
          title: `[规划派发] ${milestoneTitle}`,
          description: `所属宏观规划：${planTitle}\n规划背景：${planDescription}`,
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

      try {
        const linkKey = "agentflow_task_project_links_v1";
        const existingLinks = JSON.parse(localStorage.getItem(linkKey) || "{}");
        existingLinks[created.runId] = {
          planId,
          planTitle,
          milestoneTitle,
        };
        localStorage.setItem(linkKey, JSON.stringify(existingLinks));
      } catch {
        // ignore
      }

      await onRefreshRuns();
      setMessage(`阶段【${milestoneTitle}】已成功派发为任务！Run ID: ${created.runId.slice(0, 8)}`);
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
          <p className="page-subtitle">拆解项目目标，跟踪阶段进度。</p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {onNavigateToTab && (
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={() => onNavigateToTab("对话")}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
            >
              <IconChat size={14} />
              <span>进入智能对话中枢</span>
            </button>
          )}
          <button
            className="apple-btn-primary"
            type="button"
            onClick={() => setShowModal(true)}
          >
            + 新建立项规划
          </button>
        </div>
      </div>

      {message && (
        <div className="apple-alert-box info" style={{ marginBottom: "16px" }}>
          {message}
        </div>
      )}

      {/* Toolbar: Count + Batch Accordion Controls */}
      <div className="planning-toolbar">
        <div className="planning-toolbar-left">
          <strong>立项规划看板 ({plans.length} 项)</strong>
          <span>卡片支持独立展开与收起</span>
        </div>
        <div className="planning-toolbar-right">
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ fontSize: "11px", padding: "3px 8px" }}
            onClick={handleExpandAll}
          >
            全部展开
          </button>
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ fontSize: "11px", padding: "3px 8px" }}
            onClick={handleCollapseAll}
          >
            全部收回
          </button>
        </div>
      </div>

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
            const isExpanded = expandedPlanIds.has(p.id);
            const completedCount = p.milestones.filter((m) => m.completed).length;
            const totalCount = p.milestones.length;
            const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

            return (
              <div key={p.id} className={`planning-card ${!isExpanded ? "collapsed" : ""}`}>
                {/* Header */}
                <div
                  className="planning-card-top"
                  onClick={() => togglePlanExpand(p.id)}
                  title={isExpanded ? "点击收起" : "点击展开"}
                >
                  <div className="planning-header-content">
                    <button
                      type="button"
                      className={`collapse-toggle-btn ${isExpanded ? "expanded" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePlanExpand(p.id);
                      }}
                      title={isExpanded ? "收起" : "展开"}
                    >
                      ▶
                    </button>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 600 }}>{p.title}</h3>
                      <span className={`apple-pill ${p.status}`}>
                        {percent === 100 ? "已全部交付" : `${percent}% 完成`}
                      </span>
                      <span style={{ fontSize: "12px", color: "#86868b" }}>
                        (阶段进度：{completedCount}/{totalCount})
                      </span>
                    </div>
                  </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }} onClick={(e) => e.stopPropagation()}>
                    <span style={{ fontSize: "11px", color: "#86868b" }}>
                      交付期：{p.deadline}
                    </span>
                    <button
                      className="apple-icon-btn"
                      type="button"
                      title="移除规划"
                      disabled={busy}
                      onClick={() => void handleDeletePlan(p.id)}
                      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <IconClose size={13} />
                    </button>
                  </div>
                </div>

                {/* Collapsible Body */}
                {isExpanded && (
                  <div className="planning-card-body">
                    <p className="planning-card-desc">{p.description}</p>

                    {/* Progress Bar */}
                    <div className="planning-progress-section">
                      <div className="planning-progress-info">
                        <span>阶段达成率 ({completedCount}/{totalCount})</span>
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
                                      <IconLink size={12} />
                                      <span>已派发执行：</span>
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
                                    onClick={() =>
                                      void handleDispatchMilestone(
                                        p.title,
                                        p.description,
                                        p.id,
                                        m.title,
                                        m.id
                                      )
                                    }
                                    style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                                  >
                                    <IconZap size={12} />
                                    <span>派发为任务</span>
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
                                  <span className="completed-badge" style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                                    <IconCheck size={11} />
                                    <span>已达标</span>
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Modal: Streamlined Minimal Create Planning with Grill-Me Entry */}
      {showModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="apple-modal-card"
            style={{ width: "520px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建立项规划</h3>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
              输入项目名称与描述。可直接由 AI 进行 Grill-Me 深度推演细节并自动设计方案，或快速立项。
            </p>

            <form onSubmit={(e) => void handleDirectCreate(e)} className="modal-body-form" style={{ marginTop: "14px" }}>
              <label>
                项目名称
                <input
                  required
                  placeholder="例如：重构多租户数据库隔离与本地离线同步"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </label>

              <label>
                需求背景与核心目标
                <textarea
                  rows={3}
                  placeholder="描述当前面临的工程挑战、预期目标与验收标准…"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </label>

              <div className="modal-btn-row" style={{ marginTop: "14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowModal(false)}
                >
                  取消
                </button>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    className="apple-btn-secondary"
                    type="submit"
                    disabled={busy || !newTitle.trim()}
                  >
                    直接立项
                  </button>

                  <button
                    className="apple-btn-primary"
                    type="button"
                    disabled={!newTitle.trim()}
                    onClick={handleLaunchGrillMe}
                    style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                  >
                    <IconFlame size={14} />
                    <span>Grill-Me 探讨细节并设计方案</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
