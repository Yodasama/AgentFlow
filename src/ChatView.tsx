import { useState, useEffect, useRef } from "react";
import {
  saveGoal,
  saveSchedule,
  createMockDevelopmentTask,
  type GoalRecord,
  type ScheduleRecord,
} from "./api";
import {
  type Workspace,
  type ServerConfig,
  type EnvTarget,
  getActiveWorkspace,
  getStoredWorkspaces,
  getStoredServers,
  getActiveEnv,
  setActiveEnv as persistActiveEnv,
  getActiveServerId,
  setActiveServerId as persistActiveServerId,
  getWorkspaceBranches,
  addWorkspaceBranch,
  updateWorkspaceBranch,
} from "./workspaces";
import { WorkspaceModal } from "./WorkspaceModal";
import { ServerModal } from "./ServerModal";
import {
  type AgentProviderConfig,
  getActiveProvider,
  getStoredProviders,
  detectLocalEndpoints,
} from "./agentAdapter";
import { ProviderModal } from "./ProviderModal";
import { DrawerSelect, type DrawerSelectOption } from "./DrawerSelect";
import {
  IconSparkles,
  IconFolder,
  IconTasks,
  IconPlanning,
  IconSchedule,
  IconZap,
  IconFlame,
  IconSettings,
  IconLaptop,
  IconCloud,
  IconCpu,
  IconBrain,
  IconChevronDown,
  IconSend,
  IconPlus,
  IconWaveform,
  IconMicrophone,
  IconHistory,
  IconSidebar,
  IconCheckCircle,
  IconTrash,
  IconGitBranch,
  IconServer,
} from "./icons";

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

export interface ServerActionCardData {
  title: string;
  serverName: string;
  serverHost: string;
  user: string;
  commands: string[];
  safetyLevel: "需人工确认" | "静默执行";
  summary: string;
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
  serverAction?: ServerActionCardData;
  grillMe?: {
    topic: string;
    questions: GrillMeQuestion[];
  };
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  workspaceId: string;
  model: string;
  reasoning: string;
}

const CHAT_SESSIONS_STORAGE_KEY = "agentflow_chat_sessions_v2";
const ACTIVE_SESSION_ID_KEY = "agentflow_active_chat_session_id_v2";

function getStoredChatSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [];
  } catch {
    return [];
  }
}

function saveStoredChatSessions(sessions: ChatSession[]): void {
  localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function formatSessionTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

export function ChatView({
  onNavigateToRun,
  onNavigateToTab,
  onRefreshRuns,
  initialGrillTopic,
  onClearGrillTopic,
}: Props) {
  // Active Workspace
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>(() => getActiveWorkspace());
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);

  // Active Provider & Model (Local vs Cloud API via Unified Adapter)
  const [activeProvider, setActiveProvider] = useState<AgentProviderConfig>(() => getActiveProvider());
  const [selectedModel, setSelectedModel] = useState(activeProvider.models[0] || "Claude 3.5 Sonnet");
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [selectedReasoning, setSelectedReasoning] = useState("深度 (High)");

  // Multi-session history state
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const stored = getStoredChatSessions();
    if (stored.length > 0) return stored;
    const initial: ChatSession = {
      id: `session-${Date.now()}`,
      title: "新会话",
      updatedAt: Date.now(),
      messages: [],
      workspaceId: getActiveWorkspace().id,
      model: "Claude 3.5 Sonnet",
      reasoning: "深度 (High)",
    };
    saveStoredChatSessions([initial]);
    return [initial];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const saved = localStorage.getItem(ACTIVE_SESSION_ID_KEY);
    const stored = getStoredChatSessions();
    if (saved && stored.some((s) => s.id === saved)) return saved;
    return stored[0]?.id || "";
  });

  const [showHistory, setShowHistory] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);

  // Environment target: local vs remote server
  const [envTarget, setEnvTarget] = useState<EnvTarget>(() => getActiveEnv());
  const [servers, setServers] = useState<ServerConfig[]>(() => getStoredServers());
  const [selectedServerId, setSelectedServerId] = useState<string | null>(() => getActiveServerId());
  const [showServerModal, setShowServerModal] = useState(false);
  const selectedServer = servers.find((s) => s.id === selectedServerId) || null;

  // Git Branch selection
  const [currentBranch, setCurrentBranch] = useState(activeWorkspace.branch || "main");
  const [branches, setBranches] = useState<string[]>(() => getWorkspaceBranches(activeWorkspace));

  useEffect(() => {
    setCurrentBranch(activeWorkspace.branch || "main");
    setBranches(getWorkspaceBranches(activeWorkspace));
  }, [activeWorkspace]);

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const s = sessions.find((item) => item.id === activeSessionId) || sessions[0];
    return s?.messages || [];
  });
  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showToast = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  // Session switching
  useEffect(() => {
    if (!activeSessionId) return;
    localStorage.setItem(ACTIVE_SESSION_ID_KEY, activeSessionId);
    const target = sessions.find((s) => s.id === activeSessionId);
    if (target) {
      setMessages(target.messages || []);
      if (target.workspaceId) {
        const storedWs = getStoredWorkspaces();
        const foundWs = storedWs.find((w) => w.id === target.workspaceId);
        if (foundWs) setActiveWorkspace(foundWs);
      }
      if (target.model) setSelectedModel(target.model);
      if (target.reasoning) setSelectedReasoning(target.reasoning);
    }
  }, [activeSessionId]);

  // Sync messages & session metadata
  useEffect(() => {
    setSessions((prev) => {
      const updated = prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        let title = s.title;
        if ((!title || title === "新会话" || title === "新对话") && messages.length > 0) {
          const firstUser = messages.find((m) => m.sender === "user");
          if (firstUser) {
            title = firstUser.content.replace(/【.*?】/g, "").trim().slice(0, 24) || "新会话";
          }
        }
        return {
          ...s,
          title,
          messages,
          updatedAt: Date.now(),
          workspaceId: activeWorkspace.id,
          model: selectedModel,
          reasoning: selectedReasoning,
        };
      });
      saveStoredChatSessions(updated);
      return updated;
    });
  }, [messages, activeWorkspace, selectedModel, selectedReasoning]);

  const handleNewSession = () => {
    const newSession: ChatSession = {
      id: `session-${Date.now()}`,
      title: "新会话",
      updatedAt: Date.now(),
      messages: [],
      workspaceId: activeWorkspace.id,
      model: selectedModel,
      reasoning: selectedReasoning,
    };
    const updated = [newSession, ...sessions];
    setSessions(updated);
    saveStoredChatSessions(updated);
    setActiveSessionId(newSession.id);
    setMessages([]);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = sessions.filter((s) => s.id !== sessionId);
    if (filtered.length === 0) {
      const fresh: ChatSession = {
        id: `session-${Date.now()}`,
        title: "新会话",
        updatedAt: Date.now(),
        messages: [],
        workspaceId: activeWorkspace.id,
        model: selectedModel,
        reasoning: selectedReasoning,
      };
      setSessions([fresh]);
      saveStoredChatSessions([fresh]);
      setActiveSessionId(fresh.id);
      setMessages([]);
    } else {
      setSessions(filtered);
      saveStoredChatSessions(filtered);
      if (activeSessionId === sessionId) {
        setActiveSessionId(filtered[0].id);
        setMessages(filtered[0].messages || []);
      }
    }
  };

  const handleClearCurrentSession = () => {
    setMessages([]);
  };

  const currentSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];

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

      // 2. Server Operation Task Pattern
      const isServerTask =
        envTarget === "server" ||
        /服务器|docker|nginx|部署|重启|运维|宿主机|ssh|日志|集群|容器|清理/i.test(query);

      if (isServerTask && !query.includes("定时") && !query.includes("每天")) {
        const targetSrv = selectedServer || servers[0] || {
          id: "srv-prod",
          name: "生产服务器",
          host: "192.168.1.100",
          port: 22,
          user: "deploy",
          authType: "key" as const,
          status: "unknown" as const,
        };

        let commands = [
          `ssh ${targetSrv.user}@${targetSrv.host} -p ${targetSrv.port} "cd /data/apps/agentflow && git pull origin main"`,
          `ssh ${targetSrv.user}@${targetSrv.host} -p ${targetSrv.port} "docker compose pull && docker compose up -d --remove-orphans"`,
          `ssh ${targetSrv.user}@${targetSrv.host} -p ${targetSrv.port} "curl -sI http://localhost:8080/health || exit 1"`,
        ];

        if (/日志|排查|查错|错误/.test(query)) {
          commands = [
            `ssh ${targetSrv.user}@${targetSrv.host} "journalctl -u agentflow -n 80 --no-pager"`,
            `ssh ${targetSrv.user}@${targetSrv.host} "tail -n 50 /var/log/nginx/error.log"`,
            `ssh ${targetSrv.user}@${targetSrv.host} "docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'"`,
          ];
        } else if (/状态|负载|健康|容器|docker/.test(query)) {
          commands = [
            `ssh ${targetSrv.user}@${targetSrv.host} "uptime && free -h"`,
            `ssh ${targetSrv.user}@${targetSrv.host} "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'"`,
            `ssh ${targetSrv.user}@${targetSrv.host} "df -h /data"`,
          ];
        } else if (/清理|缓存|释放/.test(query)) {
          commands = [
            `ssh ${targetSrv.user}@${targetSrv.host} "docker system prune -f --filter 'until=48h'"`,
            `ssh ${targetSrv.user}@${targetSrv.host} "journalctl --vacuum-time=7d"`,
          ];
        }

        const serverAction: ServerActionCardData = {
          title: query.length > 24 ? query.slice(0, 24) + "…" : query,
          serverName: targetSrv.name,
          serverHost: `${targetSrv.user}@${targetSrv.host}:${targetSrv.port}`,
          user: targetSrv.user,
          commands,
          safetyLevel: autoApprove ? "静默执行" : "需人工确认",
          summary: `已针对远程节点【${targetSrv.name}】规划执行步骤，支持通过沙箱连接远程执行并同步采集标准输出与退出码。`,
        };

        const aiMsg: ChatMessage = {
          id: `msg-ai-${Date.now()}`,
          sender: "assistant",
          content: `已为您规划针对目标服务器【${targetSrv.name}】的操作步骤。您可以审查下方待执行指令清单，确认后一键派发至服务器执行：`,
          serverAction,
        };

        setMessages((prev) => [...prev, aiMsg]);
        setBusy(false);
        return;
      }

      // 3. Grill-Me Inquiries
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

  // Dispatch Server Task to Remote Host
  const handleDispatchServerAction = async (action: ServerActionCardData) => {
    setBusy(true);
    try {
      const created = await createMockDevelopmentTask(
        {
          title: `[服务器执行] ${action.title}`,
          description: `目标节点：${action.serverName} (${action.serverHost})\n执行用户：${action.user}\n安全策略：${action.safetyLevel}\n预编排指令清单：\n${action.commands.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
          acceptanceCriteria: [
            `验证宿主机 ${action.serverHost} 凭据连通`,
            "按序安全执行预定指令链并拦截非零退出码",
            "回传执行 stdout/stderr 审计归档",
          ],
        },
        activeWorkspace.path,
        "test_then_review_retry"
      );

      await onRefreshRuns();
      setNotification(`服务器任务已派发至【${action.serverName}】！Run ID: ${created.runId.slice(0, 8)}，正在跳转…`);
      setTimeout(() => {
        setNotification(null);
        onNavigateToRun(created.runId);
      }, 900);
    } catch (err) {
      setNotification(`派发服务器任务失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const reasoningShort = selectedReasoning.startsWith("深度") ? "深度" : "轻度";
  const modelShortName = selectedModel.replace(/Claude-|GPT-/g, "").split(" ")[0] || selectedModel;

  const combinedModelOptions: DrawerSelectOption[] = [
    {
      value: `${selectedModel}:::轻度`,
      label: `${selectedModel} (快速轻度)`,
      description: "低延迟极速响应，适合轻量单步或日常咨询",
      icon: <IconCpu size={13} stroke="#787774" />,
    },
    {
      value: `${selectedModel}:::深度`,
      label: `${selectedModel} (深度长思考)`,
      description: "全链条长思考、严苛自检与复杂工程拆解",
      icon: <IconSparkles size={13} stroke="#787774" />,
      badge: "推荐",
    },
    ...activeProvider.models
      .filter((m) => m !== selectedModel)
      .flatMap((m) => [
        {
          value: `${m}:::深度`,
          label: `${m} 深度`,
          description: "深度思考模式",
          icon: <IconCpu size={13} stroke="#787774" />,
        },
        {
          value: `${m}:::轻度`,
          label: `${m} 轻度`,
          description: "快速响应模式",
          icon: <IconCpu size={13} stroke="#787774" />,
        },
      ]),
  ];

  const envOptions: DrawerSelectOption[] = [
    {
      value: "local",
      label: "本机环境 (Localhost)",
      description: "在当前机器工作区直接执行与调试代码",
      icon: <IconLaptop size={13} stroke="#787774" />,
    },
    ...servers.map((s) => ({
      value: `server:::${s.id}`,
      label: `${s.name} (${s.host})`,
      description: `${s.user}@${s.host}:${s.port} · ${s.authType === "key" ? "SSH 密钥" : "密码"}`,
      icon: <IconServer size={13} stroke="#787774" />,
      badge: s.status === "online" ? "在线" : undefined,
    })),
    {
      value: "__manage_servers__",
      label: "+ 管理与添加服务器…",
      description: "配置远程 SSH 节点、凭证与连通性测试",
      icon: <IconPlus size={13} stroke="#787774" />,
    },
  ];

  const currentEnvValue = envTarget === "local" ? "local" : `server:::${selectedServerId || ""}`;
  const envDisplayLabel = envTarget === "local" ? "本地" : (selectedServer?.name || "服务器");

  const branchOptions: DrawerSelectOption[] = [
    ...branches.map((b) => ({
      value: b,
      label: b,
      description: b === currentBranch ? "当前工作区分支" : `切换至 ${b} 分支`,
      icon: <IconGitBranch size={13} stroke="#787774" />,
      badge: b === currentBranch ? "当前分支" : undefined,
    })),
    {
      value: "__create_branch__",
      label: "+ 新建分支…",
      description: "基于当前工作区切出新分支并切换",
      icon: <IconPlus size={13} stroke="#787774" />,
    },
  ];

  const handleSelectBranch = (val: string) => {
    if (val === "__create_branch__") {
      const name = window.prompt("请输入新分支名称 (例如: feature/workflow):");
      if (name && name.trim()) {
        const clean = name.trim();
        const updatedBranches = addWorkspaceBranch(activeWorkspace.id, clean);
        setBranches(updatedBranches);
        setCurrentBranch(clean);
        const updatedWs = updateWorkspaceBranch(activeWorkspace.id, clean);
        setActiveWorkspace(updatedWs);
        showToast(`已切出并切换至新分支【${clean}】`);
      }
      return;
    }
    setCurrentBranch(val);
    const updatedWs = updateWorkspaceBranch(activeWorkspace.id, val);
    setActiveWorkspace(updatedWs);
    showToast(`已切换至分支【${val}】`);
  };

  return (
    <div className="gpt-chat-root">
      {/* Left Collapsible History Sidebar */}
      <aside className={`chat-history-sidebar ${showHistory ? "" : "collapsed"}`}>
        <div className="history-sidebar-header">
          <div className="history-header-title">
            <IconHistory size={14} stroke="#111111" />
            <span>历史会话</span>
          </div>
          <button
            type="button"
            className="history-new-btn"
            onClick={handleNewSession}
            title="开启新对话"
          >
            <IconPlus size={12} stroke="#111111" />
            <span>新对话</span>
          </button>
        </div>

        <div className="history-sessions-list">
          {sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                className={`history-session-item ${isActive ? "active" : ""}`}
                onClick={() => setActiveSessionId(s.id)}
              >
                <div className="history-session-info">
                  <span className="history-session-title">{s.title || "新会话"}</span>
                  <span className="history-session-date">{formatSessionTime(s.updatedAt)}</span>
                </div>
                <button
                  type="button"
                  className="history-delete-btn"
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  title="删除此会话"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main Chat Column */}
      <div className="chat-main-column">
        {/* Top Minimal Bar */}
        <div className="gpt-header-bar">
          <div className="gpt-header-left">
            <button
              type="button"
              className="chat-toggle-sidebar-btn"
              onClick={() => setShowHistory(!showHistory)}
              title={showHistory ? "收起历史会话" : "展开历史会话"}
            >
              <IconSidebar size={14} />
            </button>
            <span className="gpt-header-title" style={{ marginLeft: "4px" }}>
              {currentSession?.title || "AgentFlow 智能中枢"}
            </span>
          </div>

          <div className="gpt-header-right">
            {messages.length > 0 && (
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleClearCurrentSession}
                style={{ fontSize: "12px", padding: "4px 9px" }}
              >
                清空当前对话
              </button>
            )}
            <button
              type="button"
              className="apple-btn-secondary"
              onClick={handleNewSession}
              style={{ fontSize: "12px", padding: "4px 9px", display: "inline-flex", alignItems: "center", gap: "4px" }}
            >
              <IconPlus size={12} />
              <span>新建会话</span>
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
              <div className="gpt-hero-icon" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <IconSparkles size={24} />
              </div>
              <h2 className="gpt-hero-title">今天想推演或构建什么？</h2>
              <p className="gpt-hero-desc">
                当前工作区：<strong>{activeWorkspace.name}</strong> · 执行环境：<strong>{envTarget === "local" ? "本地" : (selectedServer?.name || "服务器")}</strong> · 接入源：<strong>{activeProvider.name}</strong>
              </p>

              <div className="gpt-prompt-grid">
                {envTarget === "server" ? (
                  <>
                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("检查服务器资源利用率、负载与 Docker 容器状态")}
                    >
                      <div className="card-tag">
                        <IconServer size={12} />
                        <span>宿主机健康诊断</span>
                      </div>
                      <div className="card-text">检查远程主机 CPU/内存负载与容器存活状态</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("拉取主干最新代码并平滑重载核心服务容器")}
                    >
                      <div className="card-tag">
                        <IconZap size={12} />
                        <span>服务平滑更新</span>
                      </div>
                      <div className="card-text">拉取仓库最新构建产物并重载业务容器</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("收集并分析最近 1 小时 Nginx 访问与错误日志")}
                    >
                      <div className="card-tag">
                        <IconSparkles size={12} />
                        <span>远程日志排查</span>
                      </div>
                      <div className="card-text">提取 Nginx 访问与服务异常日志进行智能归因</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("每天 03:00 自动清理过期临时镜像与审计日志")}
                    >
                      <div className="card-tag">
                        <IconSchedule size={12} />
                        <span>服务器自动化</span>
                      </div>
                      <div className="card-text">设定周期巡检与无用 Docker 镜像自动释放</div>
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="gpt-prompt-card"
                      onClick={() =>
                        handleLaunchGrillMe(
                          "多端离线数据同步与版本冲突解决",
                          "设计本地缓存与网络恢复后的双向增量同步"
                        )
                      }
                    >
                      <div className="card-tag">
                        <IconFlame size={12} />
                        <span>Grill-Me 需求推演</span>
                      </div>
                      <div className="card-text">探讨离线同步架构与版本冲突解决策略</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("微服务多租户数据库隔离与 WAL 模式重构规划")}
                    >
                      <div className="card-tag">
                        <IconPlanning size={12} />
                        <span>复杂工程立项</span>
                      </div>
                      <div className="card-text">微服务多租户数据库隔离与 WAL 模式方案</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("为当前项目编写自动化回归测试套件")}
                    >
                      <div className="card-tag">
                        <IconZap size={12} />
                        <span>快速派发任务</span>
                      </div>
                      <div className="card-text">在当前工作区编写自动化回归与单测套件</div>
                    </div>

                    <div
                      className="gpt-prompt-card"
                      onClick={() => handleSendMessage("每天 02:00 自动拉取主干执行全量回归与测试")}
                    >
                      <div className="card-tag">
                        <IconSchedule size={12} />
                        <span>创建定时自动化</span>
                      </div>
                      <div className="card-text">每天凌晨 02:00 自动拉取主干执行代码巡检</div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            /* Messages Stream */
            <div className="gpt-messages-flow">
              {messages.map((m) => (
                <div key={m.id} className={`gpt-message-turn ${m.sender}`}>
                  {m.sender === "assistant" && (
                    <div className="gpt-assistant-avatar" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      <IconSparkles size={14} />
                    </div>
                  )}

                  <div className="gpt-message-body">
                    <div className="gpt-text-bubble">
                      {m.content}
                    </div>

                    {/* Grill-Me Interactive Block */}
                    {m.grillMe && (
                      <div className="gpt-grillme-card">
                        <div className="grillme-header-row">
                          <span className="grillme-flame" style={{ display: "inline-flex", alignItems: "center" }}>
                            <IconFlame size={14} />
                          </span>
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
                              <strong style={{ fontSize: "14px", color: "#111111", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <IconPlanning size={15} />
                                {m.plan.title}
                              </strong>
                              <span className="gpt-ws-tag" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <IconFolder size={11} />
                                {m.plan.workspaceName}
                              </span>
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
                            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                          >
                            <IconPlus size={12} />
                            <span>沉淀为立项规划</span>
                          </button>
                        </div>

                        <div className="card-phases-wrap">
                          {m.plan.phases.map((ph, pIdx) => (
                            <div key={pIdx} className="card-phase-row">
                              <div style={{ flex: 1, paddingRight: "10px" }}>
                                <div style={{ fontWeight: 600, fontSize: "13px", color: "#111111" }}>
                                  阶段 {pIdx + 1}：{ph.title}
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
                                style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                              >
                                <IconZap size={12} />
                                <span>派发此任务</span>
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
                            <strong style={{ fontSize: "14px", color: "#111111", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                              <IconSchedule size={15} />
                              定时自动化规则
                            </strong>
                            <span className="gpt-ws-tag" style={{ marginLeft: "8px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                              <IconFolder size={11} />
                              {m.schedule.workspaceName}
                            </span>
                          </div>

                          <button
                            type="button"
                            className="gpt-btn-primary"
                            disabled={busy}
                            onClick={() => void handleCreateScheduleFromChat(m.schedule!)}
                            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                          >
                            <IconPlus size={12} />
                            <span>建立定时规则</span>
                          </button>
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "10px", fontSize: "12.5px" }}>
                          <div>
                            <span style={{ color: "#86868b" }}>任务内容：</span>
                            <strong>{m.schedule.title}</strong>
                          </div>
                          <div>
                            <span style={{ color: "#86868b" }}>频次：</span>
                            <strong style={{ color: "#111111" }}>{m.schedule.timeStr}</strong>
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

                    {/* Server Action Execution Card */}
                    {m.serverAction && (
                      <div className="gpt-card-artifact server-action-card">
                        <div className="card-artifact-top">
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <strong style={{ fontSize: "14px", color: "#111111", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <IconServer size={15} />
                                {m.serverAction.title}
                              </strong>
                              <span className="server-target-tag">
                                🖥️ {m.serverAction.serverName}
                              </span>
                              <span className="server-safety-tag">
                                {m.serverAction.safetyLevel}
                              </span>
                            </div>
                            <p style={{ fontSize: "12px", color: "#6e6e73", margin: "4px 0 0" }}>
                              {m.serverAction.summary}
                            </p>
                          </div>

                          <button
                            type="button"
                            className="gpt-btn-primary"
                            disabled={busy}
                            onClick={() => void handleDispatchServerAction(m.serverAction!)}
                            style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                          >
                            <IconZap size={12} />
                            <span>在服务器派发执行</span>
                          </button>
                        </div>

                        {/* Remote Host Info & Command Preview */}
                        <div className="server-commands-box">
                          <div className="server-commands-header">
                            <span>目标宿主机: {m.serverAction.serverHost}</span>
                            <span>执行用户: {m.serverAction.user}</span>
                          </div>
                          <div className="server-commands-code">
                            {m.serverAction.commands.map((cmd, cIdx) => (
                              <div key={cIdx} className="server-cmd-line">
                                <span className="cmd-prompt">$</span>
                                <span className="cmd-text">{cmd}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {busy && (
                <div className="gpt-message-turn assistant">
                  <div className="gpt-assistant-avatar" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <IconSparkles size={14} />
                  </div>
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

      {/* Floating Bottom Input Dock with Screenshot Style Envelope */}
      <div className="gpt-bottom-dock-wrapper">
        <div className="chat-dock-envelope">
          {/* 1. Context Strip (Top grey bar: 📁 简历  💻 本地  ⑂ master) */}
          <div className="chat-attached-context-strip">
            <button
              type="button"
              className="context-strip-btn"
              onClick={() => setShowWorkspaceModal(true)}
              title="点击切换关联工程工作区"
            >
              <IconFolder size={13} stroke="#38383a" />
              <span>{activeWorkspace.name}</span>
            </button>

            <DrawerSelect
              size="sm"
              value={currentEnvValue}
              onChange={(val) => {
                if (val === "__add_server__" || val === "__manage_servers__") {
                  setShowServerModal(true);
                  return;
                }
                if (val === "local") {
                  setEnvTarget("local");
                  persistActiveEnv("local");
                  setSelectedServerId(null);
                  persistActiveServerId(null);
                  showToast("已切换执行环境至本机 (Localhost)");
                } else if (val.startsWith("server:::")) {
                  const srvId = val.split(":::")[1];
                  setEnvTarget("server");
                  persistActiveEnv("server");
                  setSelectedServerId(srvId);
                  persistActiveServerId(srvId);
                  const matched = servers.find((s) => s.id === srvId);
                  showToast(`已切换执行环境至服务器【${matched?.name || "远程服务器"}】`);
                }
              }}
              options={envOptions}
              customLabel={envDisplayLabel}
              triggerStyle={{
                border: "none",
                background: "transparent",
                padding: "2px 6px",
                fontSize: "12.5px",
                color: "#1d1d1f",
                fontWeight: 500,
                gap: "5px",
                minWidth: "auto",
              }}
            />

            <DrawerSelect
              size="sm"
              value={currentBranch}
              onChange={handleSelectBranch}
              options={branchOptions}
              customLabel={currentBranch}
              triggerStyle={{
                border: "none",
                background: "transparent",
                padding: "2px 6px",
                fontSize: "12.5px",
                color: "#1d1d1f",
                fontWeight: 500,
                gap: "5px",
                minWidth: "auto",
              }}
            />
          </div>

          {/* 2. Floating Main White Card (Screenshot Exact) */}
          <div className="chat-floating-main-card">
            <textarea
              ref={textareaRef}
              className="chat-screen-textarea"
              placeholder="随心输入"
              rows={2}
              value={inputText}
              onChange={(e) => {
                setInputText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
            />

            {/* Bottom Actions Row */}
            <div className="chat-screen-bottom-bar">
              {/* Left: + and 帮我批准 */}
              <div className="chat-bottom-left">
                <button
                  type="button"
                  className="chat-plus-btn"
                  onClick={() => handleSendMessage("请分析当前工作区架构并生成优化方案")}
                  title="附加工程上下文或快捷提示词"
                >
                  <IconPlus size={16} stroke="#1d1d1f" />
                </button>

                <button
                  type="button"
                  className={`chat-approve-pill ${autoApprove ? "active" : ""}`}
                  onClick={() => {
                    const nextState = !autoApprove;
                    setAutoApprove(nextState);
                    showToast(
                      nextState
                        ? "已开启【帮我批准】模式：AgentFlow 将自动推进合规步骤"
                        : "已关闭自动批准模式"
                    );
                  }}
                  title="自动批准模式：允许 Agent 自动推进通过测试门禁与非阻断性审查"
                >
                  <IconCheckCircle size={13} stroke={autoApprove ? "#0071e3" : "#636366"} />
                  <span>帮我批准</span>
                </button>
              </div>

              {/* Right: Model dropdown, Mic, and Waveform Circle */}
              <div className="chat-bottom-right">
                <DrawerSelect
                  size="sm"
                  value={`${selectedModel}:::${selectedReasoning.startsWith("深度") ? "深度" : "轻度"}`}
                  onChange={(val) => {
                    const [m, r] = val.split(":::");
                    if (m) setSelectedModel(m);
                    if (r) setSelectedReasoning(r === "深度" ? "深度 (High)" : "快速 (Low)");
                  }}
                  options={combinedModelOptions}
                  customLabel={`${modelShortName} ${reasoningShort}`}
                  triggerStyle={{
                    border: "none",
                    background: "transparent",
                    padding: "4px 8px",
                    fontSize: "12.5px",
                    color: "#48484a",
                    fontWeight: 500,
                  }}
                />

                <button
                  type="button"
                  className="chat-mic-btn"
                  onClick={() => showToast("语音输入麦克风已就绪")}
                  title="语音输入"
                >
                  <IconMicrophone size={16} stroke="#48484a" />
                </button>

                <button
                  type="button"
                  className="chat-waveform-btn"
                  onClick={() => handleSendMessage()}
                  disabled={busy || !inputText.trim()}
                  title="发送 (Enter)"
                >
                  <IconWaveform size={16} stroke="#ffffff" />
                </button>
              </div>
            </div>
          </div>

          <div className="gpt-footer-disclaimer">
            AgentFlow 可能会产生工程建议，任务将在对应工作区的独立 Git 分支中隔离执行。
          </div>
        </div>
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

    {/* Server Management Modal */}
    {showServerModal && (
      <ServerModal
        selectedServerId={selectedServerId}
        onSelectServer={(srv) => {
          setEnvTarget("server");
          persistActiveEnv("server");
          setSelectedServerId(srv.id);
          persistActiveServerId(srv.id);
          setServers(getStoredServers());
          showToast(`已切换执行环境至服务器【${srv.name}】`);
        }}
        onSelectLocal={() => {
          setEnvTarget("local");
          persistActiveEnv("local");
          setSelectedServerId(null);
          persistActiveServerId(null);
          showToast("已切换执行环境至本机 (Localhost)");
        }}
        onClose={() => {
          setShowServerModal(false);
          setServers(getStoredServers());
        }}
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
