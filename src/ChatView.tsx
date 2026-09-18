import { useState, useEffect, useRef } from "react";
import {
  saveGoal,
  saveSchedule,
  createMockDevelopmentTask,
  type GoalRecord,
  type ScheduleRecord,
} from "./api";

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
}

interface ScheduleCardData {
  title: string;
  timeStr: string;
  model: string;
  reasoning: string;
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
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "msg-welcome",
      sender: "assistant",
      content:
        "您好！我是 AgentFlow 系统智能中枢与架构顾问。我负责全项目的需求挖掘 (Grill-Me)、工程立项拆解、任务直接派发以及环境探查。请直接告诉我您的想法，或点击下方建议快速启动。",
    },
  ]);

  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedModel, setSelectedModel] = useState("Claude 3.5 Sonnet");
  const [selectedReasoning, setSelectedReasoning] = useState("深度 (High)");
  const [notification, setNotification] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

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
      content: `【立项发起 Grill-Me 需求推演】\n项目名称：${topicTitle}\n需求描述：${topicDesc || "待推演细化"}`,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      const assistantMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `收到立项诉求【${topicTitle}】！在为您正式设计架构与编写阶段计划前，我作为架构师需要与您推演 3 个关键边界决策：`,
        grillMe: {
          topic: topicTitle,
          questions: [
            {
              question: "1. 数据持久化与并发隔离策略",
              options: [
                "本地 SQLite WAL 模式 + 单写多读锁机制 (推荐)",
                "外部分布式 PostgreSQL/MySQL 独立租户数据库",
                "纯内存缓存 + 定期 Checkpoint 快照持久化",
              ],
            },
            {
              question: "2. 故障恢复与异常回滚机制",
              options: [
                "原子事务自动回滚，并在异常时产生不可变告警事件",
                "乐观锁重试，超过 3 次触发人工审查介入",
                "静默跳过失败步，记录详细 Trace 供离线分析",
              ],
            },
            {
              question: "3. 目标交付方式与准入门禁",
              options: [
                "自动化单元测试 + Review Agent 联合门禁准入 (严苛)",
                "仅跑核心回归测试套件，直接生成交付 Checkpoint (敏捷)",
              ],
            },
          ],
        },
      };

      setMessages((prev) => [...prev, assistantMsg]);
      setBusy(false);
    }, 650);
  };

  const handleApplyGrillAnswers = (topic: string, selectedChoice: string) => {
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: `已确认决策倾向：【${selectedChoice}】。请基于此生成正式架构拆解方案。`,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      const plan: PlanCardData = {
        title: `${topic} · 架构落地方案`,
        summary: `基于决策【${selectedChoice}】，采用分阶段渐进式落地，各阶段保持原子隔离与独立自动化准入。`,
        phases: [
          {
            title: "阶段一：领域契约设计与基础数据库 Migration",
            desc: "完成核心数据模型、锁控制结构设计，编写基础迁移与单元测试用例。",
          },
          {
            title: "阶段二：核心业务逻辑编码与本地隔离调试",
            desc: "在独立 Git Worktree 分支实现业务逻辑，对接状态机与异常回滚机制。",
          },
          {
            title: "阶段三：全量回归测试套件与代码审查准入",
            desc: "运行端到端压力测试，多模型联合代码审查，完成最终交付验证。",
          },
        ],
      };

      const aiMsg: ChatMessage = {
        id: `msg-ai-${Date.now()}`,
        sender: "assistant",
        content: `架构方案已设计完成！您可以直接一键将其【沉淀为立项规划】至项目看板，或直接【派发具体阶段为任务】立即执行。`,
        plan,
      };

      setMessages((prev) => [...prev, aiMsg]);
      setBusy(false);
    }, 700);
  };

  const handleSendMessage = (textToSend?: string) => {
    const query = (textToSend || inputText).trim();
    if (!query) return;

    setInputText("");
    const userMsg: ChatMessage = {
      id: `msg-user-${Date.now()}`,
      sender: "user",
      content: query,
    };

    setMessages((prev) => [...prev, userMsg]);
    setBusy(true);

    setTimeout(() => {
      // 1. Check if user wants a scheduled task
      if (query.includes("定时") || query.includes("每天") || query.includes("小时") || query.includes("每周")) {
        const schedCard: ScheduleCardData = {
          title: query.replace(/(帮我设置一个|设置|创建|定时任务|定时)/g, "").trim() || "周期性自动化工程巡检",
          timeStr: query.includes("每天") ? "每天 02:00" : query.includes("每周") ? "每周一 10:00" : "工作日 09:30",
          model: selectedModel,
          reasoning: selectedReasoning,
        };

        const aiMsg: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          sender: "assistant",
          content: `已为您识别定时自动化诉求！已配置为由【${selectedModel}】以【${selectedReasoning}】推理深度执行：`,
          schedule: schedCard,
        };

        setMessages((prev) => [...prev, aiMsg]);
        setBusy(false);
        return;
      }

      // 2. Check if user requests Grill-Me
      if (query.includes("Grill") || query.includes("grill") || query.includes("推演") || query.includes("探讨细节")) {
        handleLaunchGrillMe("新工程方案设计", query);
        return;
      }

      // 3. Default: Architecture Decomposition Plan
      const plan: PlanCardData = {
        title: query.length > 20 ? query.slice(0, 20) + "…" : query,
        summary: `针对目标“${query}”，智能架构顾问已完成依赖拓扑分析与风险解耦，拆解为以下阶段性实施路线：`,
        phases: [
          {
            title: "阶段一：需求基准建模与边界测试用例准备",
            desc: "梳理模块输入输出、上下文接口定义，优先编写验证断言。",
          },
          {
            title: "阶段二：核心功能编码与 Git Worktree 本地调试",
            desc: "在隔离沙箱分支完成核心逻辑实现，保持主干纯净。",
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
        content: `已完成需求梳理与阶段设计！您可以直接在下方派发任务，或沉淀为长期立项规划。`,
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
      setNotification(`已成功将【${plan.title}】沉淀至项目规划看板！正在为您跳转…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToTab("项目规划");
      }, 1000);
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
          description: `所属宏观规划：${planTitle}\n阶段目标：${phaseDesc}`,
          acceptanceCriteria: [
            `完成【${phaseTitle}】的代码落地`,
            "运行单元与集成测试确保无回归",
            "触发代码审查与 Checkpoint 交付",
          ],
        },
        "/Users/yida/项目/TaskBoard",
        "test_then_review_retry"
      );

      await onRefreshRuns();
      setNotification(`任务已派发！Run ID: ${created.runId.slice(0, 8)}，正在跳转任务详情…`);
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
        name: sched.title,
        cron: sched.timeStr,
        timezone: "Asia/Shanghai (本机)",
        targetWorkflowName: `${sched.model} (${sched.reasoning})`,
        active: true,
        overlapPolicy: "skip",
        lastRunAt: null,
        createdAt: new Date().toISOString(),
      };

      await saveSchedule(newSchedule);
      setNotification(`定时任务【${sched.title}】已创建！正在为您跳转定时任务看板…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToTab("定时任务");
      }, 1000);
    } catch (err) {
      setNotification(`创建定时任务失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-page-container">
      {/* Page Header */}
      <div className="page-header-row" style={{ marginBottom: "12px" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h1>智能对话中枢</h1>
            <span className="apple-pill running" style={{ fontSize: "11px" }}>
              总控 Copilot
            </span>
          </div>
          <p className="page-subtitle">
            系统级全能架构顾问。支持 Grill-Me 需求推演、立项方案设计、即时任务派发及周期规则生成。
          </p>
        </div>
      </div>

      {notification && (
        <div className="apple-alert-box info" style={{ marginBottom: "12px" }}>
          {notification}
        </div>
      )}

      {/* Main Chat Stream Box */}
      <div className="chat-stream-card">
        <div className="chat-messages-area">
          {messages.map((m) => (
            <div key={m.id} className={`chat-bubble-row ${m.sender}`}>
              <div className="bubble-avatar">
                {m.sender === "user" ? "👤" : "🤖"}
              </div>

              <div className="bubble-content-wrap">
                <div className={`chat-bubble ${m.sender}`}>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>

                  {/* Grill-Me Interactive Questions */}
                  {m.grillMe && (
                    <div className="chat-grillme-box">
                      <div className="grillme-badge">🔥 Grill-Me 架构推演与边界确认</div>
                      {m.grillMe.questions.map((q, qIdx) => (
                        <div key={qIdx} className="grillme-question-block">
                          <strong style={{ fontSize: "12px", color: "#1d1d1f" }}>{q.question}</strong>
                          <div className="grillme-options-row">
                            {q.options.map((opt, oIdx) => (
                              <button
                                key={oIdx}
                                type="button"
                                className="grillme-option-chip"
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

                  {/* Structured Plan Card */}
                  {m.plan && (
                    <div className="chat-action-card">
                      <div className="action-card-header">
                        <strong>📋 {m.plan.title}</strong>
                        <button
                          type="button"
                          className="apple-btn-primary"
                          style={{ fontSize: "11px", padding: "4px 10px" }}
                          disabled={busy}
                          onClick={() => void handleSaveToPlanning(m.plan!)}
                        >
                          📥 沉淀为立项规划并跳转
                        </button>
                      </div>
                      <p style={{ fontSize: "12px", color: "#86868b", margin: "4px 0 10px" }}>
                        {m.plan.summary}
                      </p>

                      <div className="chat-phases-list">
                        {m.plan.phases.map((ph, pIdx) => (
                          <div key={pIdx} className="chat-phase-row">
                            <div style={{ flex: 1 }}>
                              <strong style={{ fontSize: "12px", color: "#1d1d1f" }}>
                                第 {pIdx + 1} 阶段：{ph.title}
                              </strong>
                              <div style={{ fontSize: "11px", color: "#86868b", marginTop: "2px" }}>
                                {ph.desc}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="apple-btn-secondary"
                              style={{ fontSize: "11px", padding: "3px 8px" }}
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
                    <div className="chat-action-card">
                      <div className="action-card-header">
                        <strong>⏰ 识别到定时任务规格</strong>
                        <button
                          type="button"
                          className="apple-btn-primary"
                          style={{ fontSize: "11px", padding: "4px 10px" }}
                          disabled={busy}
                          onClick={() => void handleCreateScheduleFromChat(m.schedule!)}
                        >
                          + 确认建立定时规则
                        </button>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", margin: "8px 0", fontSize: "12px" }}>
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
            </div>
          ))}

          {busy && (
            <div className="chat-bubble-row assistant">
              <div className="bubble-avatar">🤖</div>
              <div className="chat-bubble assistant thinking">
                <span>正在探查上下文并推理方案…</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick Suggestion Chips */}
        <div className="chat-preset-bar">
          <span style={{ fontSize: "11px", color: "#86868b", alignSelf: "center" }}>
            快捷操作：
          </span>
          <button
            type="button"
            className="advisor-chip"
            onClick={() => handleLaunchGrillMe("多端离线数据同步与版本冲突解决", "针对弱网与离线环境设计同步机制")}
          >
            🔥 Grill-Me 离线同步方案推演
          </button>
          <button
            type="button"
            className="advisor-chip"
            onClick={() => handleSendMessage("微服务多租户数据库隔离与 WAL 模式重构规划")}
          >
            🧭 规划微服务多租户架构
          </button>
          <button
            type="button"
            className="advisor-chip"
            onClick={() => handleSendMessage("在当前项目编写并注册一个健康检查探针接口")}
          >
            ⚡️ 派发健康检查探针任务
          </button>
          <button
            type="button"
            className="advisor-chip"
            onClick={() => handleSendMessage("每天 02:00 自动拉取主干执行全量回归与测试")}
          >
            ⏰ 建立每天自动化巡检
          </button>
        </div>

        {/* Input Bar with Model & Reasoning Pickers */}
        <div className="chat-bottom-dock">
          <div className="dock-selectors-row">
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: "#86868b" }}>执行模型:</span>
              <select
                className="chat-select-compact"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet (架构与代码)</option>
                <option value="GPT-4o">GPT-4o (通用多模态)</option>
                <option value="Gemini 1.5 Pro">Gemini 1.5 Pro (超长上下文)</option>
                <option value="DeepSeek V3">DeepSeek V3 (高效代码)</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "11px", color: "#86868b" }}>推理强度:</span>
              <select
                className="chat-select-compact"
                value={selectedReasoning}
                onChange={(e) => setSelectedReasoning(e.target.value)}
              >
                <option value="快速 (Low)">快速响应 (Low)</option>
                <option value="平衡 (Medium)">标准思考 (Medium)</option>
                <option value="深度 (High)">深度推演 (High)</option>
              </select>
            </div>

            <div style={{ marginLeft: "auto", fontSize: "11px", color: "#86868b" }}>
              💡 自动感知当前项目工作区与环境
            </div>
          </div>

          <form
            className="chat-input-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleSendMessage();
            }}
          >
            <textarea
              className="chat-textarea"
              rows={2}
              placeholder="输入需求设想、Grill-Me 诉求，或输入“每天 02:00 运行测试”快速生成定时任务…"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
            />
            <button
              className="apple-btn-primary chat-send-btn"
              type="submit"
              disabled={busy || !inputText.trim()}
            >
              发送
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
