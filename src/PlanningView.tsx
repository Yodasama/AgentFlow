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

// Preset plan templates for one-click reference
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
    description: "实现毫秒级任务调度解析、重叠执行跳过机制与异常状态自动告警与回滚。",
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

interface ChatPlanItem {
  id: string;
  title: string;
  summary: string;
  phases: { title: string; desc: string }[];
}

interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  content: string;
  plan?: ChatPlanItem;
}

export function PlanningView({ onNavigateToRun, onRefreshRuns }: Props) {
  const [plans, setPlans] = useState<GoalRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Accordion / Collapsible state: set of plan IDs that are currently expanded
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(new Set());

  // AI Planning Chat Panel Visibility
  const [showAdvisor, setShowAdvisor] = useState(true);

  // Modal State (Simplified New Plan)
  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
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

  // AI Advisor Chat Conversation State
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "msg-welcome",
      sender: "assistant",
      content:
        "您好！我是您的系统规划与架构顾问 Agent。请向我描述您近期的重构构想、大型业务目标或系统改造设想，我将为您拆解为系统化的阶段里程碑，并支持一键直接派发至任务列表执行。",
    },
  ]);

  const loadPlans = useCallback(async () => {
    try {
      const list = await listGoals();
      setPlans(list);
      // Default: expand the first plan if none expanded yet
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

  // Toggle individual card expansion
  const togglePlanExpand = (planId: string) => {
    setExpandedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) {
        next.delete(planId);
      } else {
        next.add(planId);
      }
      return next;
    });
  };

  // Expand all
  const handleExpandAll = () => {
    setExpandedPlanIds(new Set(plans.map((p) => p.id)));
  };

  // Collapse all
  const handleCollapseAll = () => {
    setExpandedPlanIds(new Set());
  };

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

  // Simplified Create Plan Modal (Only Name, Desc, Milestones)
  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const planId = `plan-${Date.now()}`;
      const validMilestones = customMilestones.filter((m) => m.trim().length > 0);
      const defaultDeadline = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);

      const newPlan: GoalRecord = {
        id: planId,
        title: newTitle.trim(),
        description: newDesc.trim() || "系统工程拆解与阶段性目标推进。",
        status: "in_progress",
        deadline: defaultDeadline,
        actionsUsed: 0,
        actionsBudget: 30,
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
      // Expand the newly created plan
      setExpandedPlanIds((prev) => new Set([...prev, planId]));
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

      // Record project link for task views
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

  // AI Planning Assistant Conversation Handler
  const handleSendToAdvisor = (queryText?: string) => {
    const text = (queryText || chatInput).trim();
    if (!text) return;

    setChatBusy(true);
    setChatInput("");

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: text,
    };

    setChatMessages((prev) => [...prev, userMsg]);

    // Simulate Agent Thinking & Structured Plan Decomposition
    setTimeout(() => {
      let generatedTitle = `实施方案：${text.slice(0, 18)}`;
      let generatedSummary = `针对需求“${text}”，规划顾问 Agent 已完成领域建模与风险隔离分析，建议按时序分为 3 个严密闭环推进。`;
      let phases = [
        {
          title: `阶段一：核心契约设计与基础接口定义`,
          desc: `梳理输入输出边界，完成数据模型与 Migration 脚本或类型声明。`,
        },
        {
          title: `阶段二：核心业务逻辑编码与本地隔离调试`,
          desc: `在独立 Git Worktree 分支进行模块编写，落地主要交互链路。`,
        },
        {
          title: `阶段三：自动化测试用例构建与代码审查准入`,
          desc: `编写高覆盖率单测与集成测试，多 Agent 联合 Review 并准备合并。`,
        },
      ];

      if (text.includes("同步") || text.includes("离线") || text.includes("多端")) {
        generatedTitle = "多端状态同步与离线数据仲裁方案";
        generatedSummary = "构建客户端本地 SQLite/IndexedDB 离线缓存、WAL 变更日志与服务端 WebSocket 双向增量同步。";
        phases = [
          {
            title: "阶段一：抽象本地持久化契约与离线事件变更队列",
            desc: "设计不可变事件日志 (Event Log) 契约，支持断网期间本地数据安全追加。",
          },
          {
            title: "阶段二：构建网络感知监听器与冲突仲裁算法 (CRDT/LWW)",
            desc: "实现网络恢复后自动心跳重试、版本向量比对与三方合并冲突处理机制。",
          },
          {
            title: "阶段三：端到端弱网模拟压测与自动化回归交付",
            desc: "注入弱网丢包与断点重连测试，确保高可用与最终一致性。",
          },
        ];
      } else if (text.includes("调度") || text.includes("定时") || text.includes("重试")) {
        generatedTitle = "分布式任务调度引擎与容灾自愈体系";
        generatedSummary = "建立确定性定时触发器、并发排队保护、孤儿任务回收与失败告警机制。";
        phases = [
          {
            title: "阶段一：重构调度引擎核心时序轮与不可变事件日志",
            desc: "支持微秒级时间轮推进与无锁并发调度，实现执行状态持久化。",
          },
          {
            title: "阶段二：实现任务重叠跳过与进程崩溃安全回收",
            desc: "增加进程心跳探活与分布式互斥锁，杜绝重复触发与死锁。",
          },
          {
            title: "阶段三：构建自动化异常模拟套件与可观测性看板",
            desc: "模拟网络断连与子进程 Panic 注入，验证自动重启与报警闭环。",
          },
        ];
      }

      const planItem: ChatPlanItem = {
        id: `cplan-${Date.now()}`,
        title: generatedTitle,
        summary: generatedSummary,
        phases,
      };

      const aiMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `已为您完成【${generatedTitle}】的工程拆解！您可以直接在下方点击派发具体阶段至任务列表，或一键沉淀为长期立项规划。`,
        plan: planItem,
      };

      setChatMessages((prev) => [...prev, aiMsg]);
      setChatBusy(false);
    }, 600);
  };

  // Convert Chat Plan into Persistent Goal Record
  const handleSaveChatPlanToBoard = async (plan: ChatPlanItem) => {
    setBusy(true);
    try {
      const planId = `plan-${Date.now()}`;
      const defaultDeadline = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);

      const newGoal: GoalRecord = {
        id: planId,
        title: plan.title,
        description: plan.summary,
        status: "in_progress",
        deadline: defaultDeadline,
        actionsUsed: 0,
        actionsBudget: 30,
        createdAt: new Date().toISOString(),
        milestones: plan.phases.map((p, idx) => ({
          id: `m-${Date.now()}-${idx}`,
          goalId: planId,
          title: p.title,
          completed: false,
          sortOrder: idx + 1,
        })),
      };

      await saveGoal(newGoal);
      await loadPlans();
      // Expand the newly saved goal card
      setExpandedPlanIds((prev) => new Set([...prev, planId]));
      setMessage(`规划【${plan.title}】已成功沉淀至项目规划看板！`);
    } catch (err) {
      setMessage(`沉淀规划失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="planning-page">
      {/* Page Header */}
      <div className="page-header-row">
        <div>
          <h1>项目规划</h1>
          <p className="page-subtitle">
            复杂与大型需求分析中心。自顶向下拆解架构阶段目标，支持与对话 Agent 实时梳理并一键派发至任务执行。
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            className={showAdvisor ? "apple-btn-secondary" : "apple-btn-secondary"}
            type="button"
            onClick={() => setShowAdvisor(!showAdvisor)}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <span>💬</span>
            <span>{showAdvisor ? "收起规划对话" : "打开规划对话"}</span>
          </button>
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

      {/* AI Planning Advisor Conversation Section */}
      {showAdvisor && (
        <div className="planning-advisor-panel">
          <div className="advisor-header">
            <div className="advisor-header-title">
              <span>🤖</span>
              <span>AI 规划对话顾问</span>
              <span className="apple-pill running" style={{ fontSize: "11px", padding: "2px 6px" }}>
                实时拆解与任务派发
              </span>
            </div>
            <span style={{ fontSize: "12px", color: "#86868b" }}>
              用自然语言描述大任务，AI 自动拆解并支持一键派发
            </span>
          </div>

          <div className="advisor-chat-stream">
            {chatMessages.map((msg) => (
              <div key={msg.id} className={`advisor-message ${msg.sender}`}>
                <div>{msg.content}</div>

                {/* Render Structured Plan Decomposition Card if present */}
                {msg.plan && (
                  <div className="advisor-plan-card">
                    <div style={{ fontWeight: 600, fontSize: "13px", color: "#1d1d1f", marginBottom: "4px" }}>
                      📋 {msg.plan.title}
                    </div>
                    <p style={{ fontSize: "12px", color: "#86868b", margin: "2px 0 8px" }}>
                      {msg.plan.summary}
                    </p>

                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {msg.plan.phases.map((ph, pIdx) => {
                        const tempMilestoneId = `chat-m-${msg.plan!.id}-${pIdx}`;
                        const isDispatched = !!dispatchedMap[tempMilestoneId];

                        return (
                          <div key={pIdx} className="advisor-phase-item">
                            <div style={{ flex: 1, paddingRight: "8px" }}>
                              <strong>第 {pIdx + 1} 阶段：{ph.title}</strong>
                              <div style={{ fontSize: "11px", color: "#86868b", marginTop: "2px" }}>
                                {ph.desc}
                              </div>
                            </div>
                            <div>
                              {isDispatched ? (
                                <button
                                  type="button"
                                  className="apple-btn-secondary"
                                  style={{ fontSize: "11px", padding: "3px 8px" }}
                                  onClick={() => onNavigateToRun(dispatchedMap[tempMilestoneId])}
                                >
                                  查看任务 →
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="apple-btn-primary"
                                  style={{ fontSize: "11px", padding: "3px 8px" }}
                                  disabled={busy}
                                  onClick={() =>
                                    void handleDispatchMilestone(
                                      msg.plan!.title,
                                      msg.plan!.summary,
                                      msg.plan!.id,
                                      ph.title,
                                      tempMilestoneId
                                    )
                                  }
                                >
                                  ⚡️ 立即派发
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "10px" }}>
                      <button
                        type="button"
                        className="apple-btn-secondary"
                        style={{ fontSize: "11px", padding: "4px 10px" }}
                        disabled={busy}
                        onClick={() => void handleSaveChatPlanToBoard(msg.plan!)}
                      >
                        📥 沉淀为立项规划并加入看板
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {chatBusy && (
              <div className="advisor-message assistant">
                <span style={{ color: "#86868b" }}>规划顾问正在思考架构拓扑与实施阶段…</span>
              </div>
            )}
          </div>

          {/* Prompt chips suggestions */}
          <div style={{ padding: "0 16px 8px", background: "#fbfbfd" }}>
            <div className="advisor-prompt-chips">
              <span style={{ fontSize: "11px", color: "#86868b", alignSelf: "center" }}>
                建议主题：
              </span>
              <button
                type="button"
                className="advisor-chip"
                onClick={() => handleSendToAdvisor("多端状态同步与离线数据冲突仲裁机制")}
              >
                多端状态同步与离线数据仲裁
              </button>
              <button
                type="button"
                className="advisor-chip"
                onClick={() => handleSendToAdvisor("分布式任务调度引擎与容灾自愈体系")}
              >
                分布式任务调度与容灾自愈
              </button>
              <button
                type="button"
                className="advisor-chip"
                onClick={() => handleSendToAdvisor("微服务架构与多租户数据库隔离重构")}
              >
                微服务架构与数据库多租户隔离
              </button>
            </div>
          </div>

          {/* Chat Input Bar */}
          <form
            className="advisor-input-bar"
            onSubmit={(e) => {
              e.preventDefault();
              handleSendToAdvisor();
            }}
          >
            <input
              className="advisor-input"
              placeholder="向规划顾问描述你想完成的系统功能、改造或重构设想…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={chatBusy}
            />
            <button
              className="apple-btn-primary"
              type="submit"
              disabled={chatBusy || !chatInput.trim()}
              style={{ whiteSpace: "nowrap" }}
            >
              {chatBusy ? "规划中…" : "拆解并规划"}
            </button>
          </form>
        </div>
      )}

      {/* Toolbar: Count + Batch Accordion Controls */}
      <div className="planning-toolbar">
        <div className="planning-toolbar-left">
          <strong>立项规划看板 ({plans.length} 项)</strong>
          <span>支持逐项下拉折叠或展开</span>
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

      {/* Plans List (Collapsible Accordion Cards) */}
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
                {/* Collapsible Card Header */}
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
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* Collapsible Body Content */}
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
                                    onClick={() =>
                                      void handleDispatchMilestone(
                                        p.title,
                                        p.description,
                                        p.id,
                                        m.title,
                                        m.id
                                      )
                                    }
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
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Modal: Streamlined Minimal Create Planning */}
      {showModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="apple-modal-card"
            style={{ width: "560px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建立项规划</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px" }}>
              输入项目名称与核心目标，并罗列阶段性实施计划。
            </p>

            {/* Presets / Templates */}
            <div className="template-chips-row">
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#86868b" }}>
                常用参考模板：
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
                项目名称
                <input
                  required
                  placeholder="例如：重构数据库持久层支持 WAL 与多租户连接池"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </label>

              <label>
                需求描述与核心目标
                <textarea
                  rows={3}
                  placeholder="描述系统现状、面临瓶颈、核心改造目标与交付标准…"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </label>

              <div className="custom-milestones-field">
                <label style={{ marginBottom: "6px" }}>阶段性实施计划 (按时序推进)：</label>
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
                  onClick={() =>
                    setCustomMilestones([
                      ...customMilestones,
                      `阶段${customMilestones.length + 1}：新增阶段目标`,
                    ])
                  }
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
                  {busy ? "立项中…" : "确定立项"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
