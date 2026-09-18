import { useState, useEffect, useRef } from "react";
import {
  saveGoal,
  saveSchedule,
  createMockDevelopmentTask,
  type GoalRecord,
  type ScheduleRecord,
} from "./api";
import { type Workspace, getActiveWorkspace } from "./workspaces";
import { WorkspaceModal } from "./WorkspaceModal";
import {
  type AgentProviderConfig,
  getActiveProvider,
  getStoredProviders,
  detectLocalEndpoints,
} from "./agentAdapter";
import { ProviderModal } from "./ProviderModal";

interface Props {
  onNavigateToRun: (runId: string) => void;
  onNavigateToTab: (tab: string) => void;
  onRefreshRuns: () => Promise<void>;
  initialGrillTopic?: { title: string; description: string } | null;
  onClearGrillTopic?: () => void;
}

interface PhaseItem {
  title: string;
  desc: string;
}

interface PlanCardData {
  title: string;
  summary: string;
  phases: PhaseItem[];
  workspaceName: string;
  workspacePath: string;
}

interface ScheduleCardData {
  title: string;
  timeStr: string;
  model: string;
  reasoning: string;
  workspaceName: string;
}

interface GrillMeQuestion {
  question: string;
  options: string[];
}

interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  content: string;
  plan?: PlanCardData;
  schedule?: ScheduleCardData;
  grillMe?: {
    topic: string;
    questions: GrillMeQuestion[];
  };
}

export function ChatView({
  onNavigateToRun,
  onNavigateToTab,
  onRefreshRuns,
  initialGrillTopic,
  onClearGrillTopic,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedReasoning, setSelectedReasoning] = useState("深度 (High)");
  const [notification, setNotification] = useState<string | null>(null);

  // Active Workspace
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>(() => getActiveWorkspace());
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);

  // Active Provider & Model (Local vs Cloud API via Unified Adapter)
  const [activeProvider, setActiveProvider] = useState<AgentProviderConfig>(() => getActiveProvider());
  const [selectedModel, setSelectedModel] = useState(activeProvider.models[0] || "Claude 3.5 Sonnet");
  const [showProviderModal, setShowProviderModal] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  // Run initial auto-detection of local services in background
  useEffect(() => {
    void detectLocalEndpoints().then(() => {
      const current = getActiveProvider();
      setActiveProvider(current);
      if (!current.models.includes(selectedModel) && current.models.length > 0) {
        setSelectedModel(current.models[0]);
      }
    });
  }, []);

  // Update selected model when provider changes
  const handleSelectProvider = (p: AgentProviderConfig) => {
    setActiveProvider(p);
    if (p.models.length > 0 && !p.models.includes(selectedModel)) {
      setSelectedModel(p.models[0]);
    }
  };

  // Handle Grill-Me handover from Planning View
  useEffect(() => {
    if (initialGrillTopic) {
      handleLaunchGrillMe(initialGrillTopic.title, initialGrillTopic.description);
      onClearGrillTopic?.();
    }
  }, [initialGrillTopic]);

  const handleLaunchGrillMe = (topicTitle: string, topicDesc: string) => {
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: `【发起 Grill-Me 架构推演】\n目标工程：${topicTitle}\n需求背景：${topicDesc || "待推演细化"}\n目标工作区：${activeWorkspace.name} (${activeWorkspace.path})`,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      const assistantMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `已锁定目标工作区【${activeWorkspace.name}】（接入源：${activeProvider.name} · ${selectedModel}）！针对【${topicTitle}】，在为您生成具体实施里程碑前，作为系统架构师我需要先与您确认 3 个关键技术决策：`,
        grillMe: {
          topic: topicTitle,
          questions: [
            {
              question: "1. 数据持久化与并发隔离策略",
              options: [
                "本地 SQLite WAL 模式 + 单写多读锁机制 (推荐)",
                "外部分布式 PostgreSQL/MySQL 独立租户数据库",
                "纯内存状态管理 + 定期 Checkpoint 快照持久化",
              ],
            },
            {
              question: "2. 故障恢复与异常回滚机制",
              options: [
                "原子事务自动回滚，并在异常时产生不可变告警事件",
                "乐观锁重试，超过 3 次触发人工审查介入",
                "静默跳过失败步骤，记录详细 Trace 供离线分析",
              ],
            },
            {
              question: "3. 目标交付准入门禁与验证",
              options: [
                "自动化单元回归 + Review Agent 联合门禁准入 (严苛)",
                "仅跑核心冒烟回归测试套件，快速生成 Checkpoint (敏捷)",
              ],
            },
          ],
        },
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setBusy(false);
    }, 600);
  };

  const handleApplyGrillAnswers = (topic: string, selectedChoice: string) => {
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: `已确认决策：【${selectedChoice}】。请基于该技术策略在当前工作区生成正式架构拆解方案。`,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      const plan: PlanCardData = {
        title: `${topic} · 架构实施方案`,
        summary: `基于决策【${selectedChoice}】，采用分阶段渐进式落地，各阶段保持原子隔离与独立自动化准入。`,
        workspaceName: activeWorkspace.name,
        workspacePath: activeWorkspace.path,
        phases: [
          {
            title: "阶段一：领域契约设计与数据库 Migration",
            desc: `在工作区 ${activeWorkspace.name} 完成核心数据模型、锁控制契约设计，编写基础迁移与单测试用例。`,
          },
          {
            title: "阶段二：核心业务逻辑编码与本地隔离调试",
            desc: `在独立 Git 分支完成核心逻辑实现，对接状态机与异常回滚机制。`,
          },
          {
            title: "阶段三：全量回归测试套件与代码审查准入",
            desc: "运行端到端压力测试与多模型联合代码审查，完成最终交付验证。",
          },
        ],
      };

      const aiMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `架构方案已设计完成！该方案已绑定至工作区【${activeWorkspace.name}】。您可以直接【沉淀为立项规划】至项目看板，或直接【派发具体阶段为任务】立即执行。`,
        plan,
      };

      setMessages((prev) => [...prev, aiMsg]);
      setBusy(false);
    }, 650);
  };

  const handleSendMessage = (textToSend?: string) => {
    const query = (textToSend || inputText).trim();
    if (!query) return;

    setInputText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: query,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      // 1. Scheduled Task Pattern
      if (query.includes("定时") || query.includes("每天") || query.includes("小时") || query.includes("每周")) {
        const schedCard: ScheduleCardData = {
          title: query.replace(/(帮我设置一个|设置|创建|定时任务|定时)/g, "").trim() || "周期性自动化工程巡检",
          timeStr: query.includes("每天") ? "每天 02:00" : query.includes("每周") ? "每周一 10:00" : "工作日 09:30",
          model: selectedModel,
          reasoning: selectedReasoning,
          workspaceName: activeWorkspace.name,
        };

        const aiMsg: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          sender: "assistant",
          content: `已为您配置定时任务规则，执行环境已锁定为【${activeWorkspace.name}】工作区（接入模型：${selectedModel}）：`,
          schedule: schedCard,
        };

        setMessages((prev) => [...prev, aiMsg]);
        setBusy(false);
        return;
      }

      // 2. Grill-Me Inquiries
      if (query.includes("Grill") || query.includes("grill") || query.includes("推演") || query.includes("探讨细节")) {
        handleLaunchGrillMe("新工程架构方案", query);
        return;
      }

      // 3. Default Plan Decomposition
      const plan: PlanCardData = {
        title: query.length > 22 ? query.slice(0, 22) + "…" : query,
        summary: `针对目标“${query}”，智能架构顾问已完成上下文依赖与模块边界分析，拆解为以下阶段性实施路线：`,
        workspaceName: activeWorkspace.name,
        workspacePath: activeWorkspace.path,
        phases: [
          {
            title: "阶段一：需求基准建模与边界测试用例准备",
            desc: `在工作区 ${activeWorkspace.name} 梳理输入输出接口定义，优先编写断言。`,
          },
          {
            title: "阶段二：核心功能编码与 Git 沙箱隔离调试",
            desc: `在工作区沙箱分支完成核心逻辑实现，保持主干纯净。`,
          },
          {
            title: "阶段三：集成回归、安全性审查与准入交付",
            desc: "全量测试通过后触发 Review 审查，并生成 Checkpoint 交付物。",
          },
        ],
      };

      const aiMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `已完成需求梳理与阶段设计！该方案将针对工作区【${activeWorkspace.name}】由【${selectedModel}】执行。您可以直接在下方派发任务，或沉淀为长期立项规划。`,
        plan,
      };

      setMessages((prev) => [...prev, aiMsg]);
      setBusy(false);
    }, 600);
  };

  // Convert Plan Card to Persistent Project Plan
  const handleSaveToPlanning = async (plan: PlanCardData) => {
    setBusy(true);
    try {
      const planId = `plan-${Date.now()}`;
      const defaultDeadline = new Date(Date.now() + 30 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);

      const newGoal: GoalRecord = {
        id: planId,
        title: plan.title,
        description: `【工作区：${plan.workspaceName}】${plan.summary}`,
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
      setNotification(`已成功将【${plan.title}】沉淀至项目规划看板！正在为您跳转…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToTab("项目规划");
      }, 900);
    } catch (err) {
      setNotification(`保存规划失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Dispatch a Single Phase as Executable Task
  const handleDispatchPhase = async (planTitle: string, phaseTitle: string, phaseDesc: string) => {
    setBusy(true);
    try {
      const created = await createMockDevelopmentTask(
        {
          title: `[对话派发] ${phaseTitle}`,
          description: `所属规划：${planTitle}\n工作区：${activeWorkspace.name} (${activeWorkspace.path})\n模型：${selectedModel}\n阶段目标：${phaseDesc}`,
          acceptanceCriteria: [
            `完成【${phaseTitle}】的代码落地`,
            "运行单元与集成测试确保无回归",
            "触发代码审查与 Checkpoint 交付",
          ],
        },
        activeWorkspace.path,
        "test_then_review_retry"
      );

      await onRefreshRuns();
      setNotification(`任务已派发至工作区【${activeWorkspace.name}】！Run ID: ${created.runId.slice(0, 8)}，正在跳转…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToRun(created.runId);
      }, 900);
    } catch (err) {
      setNotification(`派发任务失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // Create Scheduled Task directly from Chat
  const handleCreateScheduleFromChat = async (sched: ScheduleCardData) => {
    setBusy(true);
    try {
      const newSchedule: ScheduleRecord = {
        id: `sched-${Date.now()}`,
        name: `[${sched.workspaceName}] ${sched.title}`,
        cron: sched.timeStr,
        timezone: "Asia/Shanghai (本机)",
        targetWorkflowName: `${sched.model} (${sched.reasoning})`,
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };

      await saveSchedule(newSchedule);
      setNotification(`定时任务已创建并绑定至【${sched.workspaceName}】！正在跳转定时看板…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToTab("定时任务");
      }, 900);
    } catch (err) {
      setNotification(`创建定时任务失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gpt-chat-root">
      {/* Top Header Bar */}
      <div className="gpt-header-bar">
        <div className="gpt-header-left">
          <span className="gpt-logo-icon">✦</span>
          <span className="gpt-header-title">AgentFlow 智能中枢</span>
        </div>

        <div className="gpt-header-right">
          {/* Provider / Adapter Pill */}
          <button
            type="button"
            className="gpt-workspace-pill"
            onClick={() => setShowProviderModal(true)}
            title="管理本地与云端模型接入源"
          >
            <span>{activeProvider.isLocal ? "💻" : "☁️"}</span>
            <span className="ws-label">接入源:</span>
            <strong className="ws-name">{activeProvider.name.split(" ")[0]}</strong>
            <span className="ws-chevron">⚙️</span>
          </button>

          {/* Workspace Pill Button */}
          <button
            type="button"
            className="gpt-workspace-pill"
            onClick={() => setShowWorkspaceModal(true)}
            title="点击切换或添加工程工作区"
          >
            <span className="ws-dot">●</span>
            <span className="ws-label">工作区:</span>
            <strong className="ws-name">{activeWorkspace.name}</strong>
            <span className="ws-chevron">▾</span>
          </button>
        </div>
      </div>

      {notification && (
        <div className="gpt-notification-toast">
          {notification}
        </div>
      )}

      {/* Main Conversation Stream */}
      <div className="gpt-scroll-container">
        <div className="gpt-content-col">
          {messages.length === 0 ? (
            /* Elegant Empty State */
            <div className="gpt-empty-hero">
              <div className="gpt-hero-icon">✦</div>
              <h2 className="gpt-hero-title">今天想推演或构建什么？</h2>
              <p className="gpt-hero-desc">
                当前工作区：<strong>{activeWorkspace.name}</strong> · 接入源：<strong>{activeProvider.name}</strong>
              </p>

              <div className="gpt-prompt-grid">
                <div
                  className="gpt-prompt-card"
                  onClick={() =>
                    handleLaunchGrillMe(
                      "多端离线数据同步与版本冲突解决",
                      "设计本地缓存与网络恢复后的双向增量同步"
                    )
                  }
                >
                  <div className="card-tag">🔥 Grill-Me 需求推演</div>
                  <div className="card-text">探讨离线同步架构与版本冲突解决策略</div>
                </div>

                <div
                  className="gpt-prompt-card"
                  onClick={() => handleSendMessage("微服务多租户数据库隔离与 WAL 模式重构规划")}
                >
                  <div className="card-tag">🧭 复杂工程立项</div>
                  <div className="card-text">微服务多租户数据库隔离与 WAL 模式方案</div>
                </div>

                <div
                  className="gpt-prompt-card"
                  onClick={() => handleSendMessage("为当前项目编写自动化回归测试套件")}
                >
                  <div className="card-tag">⚡️ 快速派发任务</div>
                  <div className="card-text">在当前工作区编写自动化回归与单测套件</div>
                </div>

                <div
                  className="gpt-prompt-card"
                  onClick={() => handleSendMessage("每天 02:00 自动拉取主干执行全量回归与测试")}
                >
                  <div className="card-tag">⏰ 创建定时自动化</div>
                  <div className="card-text">每天凌晨 02:00 自动拉取主干执行代码巡检</div>
                </div>
              </div>
            </div>
          ) : (
            /* Messages Stream */
            <div className="gpt-messages-flow">
              {messages.map((m) => (
                <div key={m.id} className={`gpt-message-turn ${m.sender}`}>
                  {m.sender === "assistant" && (
                    <div className="gpt-assistant-avatar">✦</div>
                  )}

                  <div className="gpt-message-body">
                    <div className="gpt-text-bubble">
                      {m.content}
                    </div>

                    {/* Grill-Me Interactive Block */}
                    {m.grillMe && (
                      <div className="gpt-grillme-card">
                        <div className="grillme-header-row">
                          <span className="grillme-flame">🔥</span>
                          <span className="grillme-title">Grill-Me 架构深度推演与边界确认</span>
                        </div>

                        {m.grillMe.questions.map((q, qIdx) => (
                          <div key={qIdx} className="grillme-q-block">
                            <div className="grillme-q-title">{q.question}</div>
                            <div className="grillme-opts-container">
                              {q.options.map((opt, oIdx) => (
                                <button
                                  key={oIdx}
                                  type="button"
                                  className="grillme-opt-btn"
                                  onClick={() => handleApplyGrillAnswers(m.grillMe!.topic, opt)}
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Architecture Plan Card */}
                    {m.plan && (
                      <div className="gpt-card-artifact">
                        <div className="card-artifact-top">
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <strong style={{ fontSize: "14px", color: "#0d0d0d" }}>
                                📋 {m.plan.title}
                              </strong>
                              <span className="gpt-ws-tag">📁 {m.plan.workspaceName}</span>
                            </div>
                            <p style={{ fontSize: "12px", color: "#6e6e73", margin: "4px 0 0" }}>
                              {m.plan.summary}
                            </p>
                          </div>

                          <button
                            type="button"
                            className="gpt-btn-primary"
                            disabled={busy}
                            onClick={() => void handleSaveToPlanning(m.plan!)}
                          >
                            📥 沉淀为立项规划
                          </button>
                        </div>

                        <div className="card-phases-wrap">
                          {m.plan.phases.map((ph, pIdx) => (
                            <div key={pIdx} className="card-phase-row">
                              <div style={{ flex: 1, paddingRight: "10px" }}>
                                <div style={{ fontWeight: 600, fontSize: "13px", color: "#0d0d0d" }}>
                                  第 {pIdx + 1} 阶段：{ph.title}
                                </div>
                                <div style={{ fontSize: "12px", color: "#6e6e73", marginTop: "2px" }}>
                                  {ph.desc}
                                </div>
                              </div>

                              <button
                                type="button"
                                className="gpt-btn-secondary"
                                disabled={busy}
                                onClick={() => void handleDispatchPhase(m.plan!.title, ph.title, ph.desc)}
                              >
                                ⚡️ 派发此任务
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Scheduled Task Card */}
                    {m.schedule && (
                      <div className="gpt-card-artifact">
                        <div className="card-artifact-top">
                          <div>
                            <strong style={{ fontSize: "14px", color: "#0d0d0d" }}>
                              ⏰ 定时自动化规则
                            </strong>
                            <span className="gpt-ws-tag" style={{ marginLeft: "8px" }}>
                              📁 {m.schedule.workspaceName}
                            </span>
                          </div>

                          <button
                            type="button"
                            className="gpt-btn-primary"
                            disabled={busy}
                            onClick={() => void handleCreateScheduleFromChat(m.schedule!)}
                          >
                            + 建立定时规则
                          </button>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "10px", fontSize: "12.5px" }}>
                          <div>
                            <span style={{ color: "#86868b" }}>任务内容：</span>
                            <strong>{m.schedule.title}</strong>
                          </div>
                          <div>
                            <span style={{ color: "#86868b" }}>频次：</span>
                            <strong style={{ color: "#0071e3" }}>{m.schedule.timeStr}</strong>
                          </div>
                          <div>
                            <span style={{ color: "#86868b" }}>负责模型：</span>
                            <strong>{m.schedule.model}</strong>
                          </div>
                          <div>
                            <span style={{ color: "#86868b" }}>推理深度：</span>
                            <strong>{m.schedule.reasoning}</strong>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="gpt-message-turn assistant">
                  <div className="gpt-assistant-avatar">✦</div>
                  <div className="gpt-message-body">
                    <div className="gpt-thinking-shimmer">
                      <span>AgentFlow 正在深度思考…</span>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Floating Bottom Input Dock with Sleek Aesthetic Selector Bar */}
      <div className="gpt-bottom-dock-wrapper">
        <div className="gpt-floating-box">
          {/* Aesthetic Options Pill Bar */}
          <div className="gpt-dock-meta">
            {/* Workspace Pill */}
            <button
              type="button"
              className="gpt-meta-pill"
              onClick={() => setShowWorkspaceModal(true)}
              title="切换工作区目录"
            >
              <span>📁</span>
              <span style={{ fontWeight: 500 }}>{activeWorkspace.name}</span>
              <span className="pill-arrow">▾</span>
            </button>

            {/* Provider Pill */}
            <button
              type="button"
              className="gpt-meta-pill"
              onClick={() => setShowProviderModal(true)}
              title="配置模型接入源 (本地检测 / 云端 API)"
            >
              <span>{activeProvider.isLocal ? (activeProvider.detected ? "🟢" : "💻") : "☁️"}</span>
              <span>{activeProvider.name.split(" ")[0]}</span>
              <span className="pill-arrow">⚙️</span>
            </button>

            {/* Model Pill */}
            <div className="gpt-meta-select-wrapper">
              <span className="select-icon">🤖</span>
              <select
                className="gpt-meta-select-clean"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {activeProvider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            {/* Reasoning Level Pill */}
            <div className="gpt-meta-select-wrapper">
              <span className="select-icon">🧠</span>
              <select
                className="gpt-meta-select-clean"
                value={selectedReasoning}
                onChange={(e) => setSelectedReasoning(e.target.value)}
              >
                <option value="快速 (Low)">快速 (Low)</option>
                <option value="平衡 (Medium)">平衡 (Medium)</option>
                <option value="深度 (High)">深度 (High)</option>
              </select>
            </div>
          </div>

          {/* Textarea + Circular Send Button */}
          <form
            className="gpt-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
          >
            <textarea
              ref={textareaRef}
              className="gpt-textarea"
              placeholder={`给 AgentFlow 发送指令、推演需求或在【${activeWorkspace.name}】中派发任务…`}
              rows={1}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
            />

            <button
              type="submit"
              className={`gpt-send-circle-btn ${inputText.trim() && !busy ? "active" : ""}`}
              disabled={busy || !inputText.trim()}
              title="发送 (Enter)"
            >
              ↑
            </button>
          </form>
        </div>

        <div className="gpt-footer-disclaimer">
          AgentFlow 可能会产生工程建议，任务将在对应工作区的独立 Git 分支中隔离执行。
        </div>
      </div>

      {/* Workspace Management Modal */}
      {showWorkspaceModal && (
        <WorkspaceModal
          activeWorkspace={activeWorkspace}
          onSelectWorkspace={(ws) => setActiveWorkspace(ws)}
          onClose={() => setShowWorkspaceModal(false)}
        />
      )}

      {/* Provider / Adapter Settings Modal */}
      {showProviderModal && (
        <ProviderModal
          activeProvider={activeProvider}
          onSelectProvider={handleSelectProvider}
          onClose={() => setShowProviderModal(false)}
        />
      )}
    </div>
  );
}
