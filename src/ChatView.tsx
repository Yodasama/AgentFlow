import { useState, useEffect, useRef, useMemo } from "react";
import {
  saveGoal,
  saveSchedule,
  createMockDevelopmentTask,
  pickDirectory,
  getGitWorkspaceInfo,
  checkoutGitBranch,
  type GoalRecord,
  type ScheduleRecord,
  type GitWorkspaceInfo,
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
  addWorkspace,
  setActiveWorkspaceId,
} from "./workspaces";
import { WorkspaceModal } from "./WorkspaceModal";
import { ServerModal } from "./ServerModal";
import {
  type AgentProviderConfig,
  type UnifiedMessage,
  getActiveProvider,
  getStoredProviders,
  setActiveProviderId,
  detectLocalEndpoints,
  UnifiedAgentAdapter,
} from "./agentAdapter";
import { ProviderModal } from "./ProviderModal";
import { DrawerSelect, type DrawerSelectOption } from "./DrawerSelect";
import { CodexModelPopover } from "./CodexModelPopover";
import { TokenUsageModal } from "./TokenUsageModal";
import { loadAgentRoles, type AgentRoleConfig, RoleIcon } from "./AgentManagerView";
import {
  IconSparkles,
  IconChat,
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
  IconSearch,
  IconClose,
  IconCheck,
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

export interface CliExecutionCardData {
  agentName: string;
  command: string;
  workspacePath: string;
  exitCode: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
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
  cliExecution?: CliExecutionCardData;
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

interface SessionTimeGroup {
  label: string;
  items: ChatSession[];
}

function groupSessionsByTime(sessions: ChatSession[]): SessionTimeGroup[] {
  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const last7DaysStart = todayStart - 6 * 86400000;

  const today: ChatSession[] = [];
  const yesterday: ChatSession[] = [];
  const last7Days: ChatSession[] = [];
  const earlier: ChatSession[] = [];

  for (const s of sorted) {
    const t = s.updatedAt || 0;
    if (t >= todayStart) {
      today.push(s);
    } else if (t >= yesterdayStart) {
      yesterday.push(s);
    } else if (t >= last7DaysStart) {
      last7Days.push(s);
    } else {
      earlier.push(s);
    }
  }

  const groups: SessionTimeGroup[] = [];
  if (today.length > 0) groups.push({ label: "今天", items: today });
  if (yesterday.length > 0) groups.push({ label: "昨天", items: yesterday });
  if (last7Days.length > 0) groups.push({ label: "最近 7 天", items: last7Days });
  if (earlier.length > 0) groups.push({ label: "更早", items: earlier });

  return groups.length > 0 ? groups : [{ label: "全部会话", items: sorted }];
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
  const [selectedModel, setSelectedModel] = useState(activeProvider.models[0] || "agy (默认模式)");
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [selectedReasoning, setSelectedReasoning] = useState("轻度");

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
      model: "agy (默认模式)",
      reasoning: "深度 (High)",
    };
    saveStoredChatSessions([initial]);
    return [initial];
  });
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);

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

  // Workspaces & Codex Popovers state
  const [allWorkspaces, setAllWorkspaces] = useState<Workspace[]>(() => getStoredWorkspaces());
  const [activeContextPopup, setActiveContextPopup] = useState<"project" | "env" | "branch" | null>(null);
  const [projectSearchText, setProjectSearchText] = useState("");
  const [branchSearchText, setBranchSearchText] = useState("");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [newBranchInput, setNewBranchInput] = useState("");
  const [gitInfo, setGitInfo] = useState<GitWorkspaceInfo | null>(null);
  const contextStripRef = useRef<HTMLDivElement>(null);

  // Decoupled Role selection
  const [selectedRoleId, setSelectedRoleId] = useState<string>("role-general");
  const availableRoles = useMemo(() => {
    const custom = loadAgentRoles();
    const generalRole: AgentRoleConfig = {
      id: "role-general",
      roleName: "通用编程助手",
      icon: "zap",
      description: "全能开发与工程协作，无特定角色约束",
      systemPrompt: "你是一名资深全栈工程师与全能开发助手。严谨、高效地解答问题、编写生产级代码并协助调试重构。",
      isBuiltin: true,
    };
    return [generalRole, ...custom.filter((r) => r.id !== "role-general")];
  }, []);

  const refreshGitInfo = async (wsPath?: string) => {
    const targetPath = wsPath !== undefined ? wsPath : activeWorkspace?.path;
    if (!targetPath || !targetPath.trim()) {
      setGitInfo(null);
      return;
    }
    try {
      const info = await getGitWorkspaceInfo(targetPath);
      setGitInfo(info);
      if (info.currentBranch) {
        setCurrentBranch(info.currentBranch);
      }
      if (info.branches && info.branches.length > 0) {
        setBranches(info.branches);
      }
    } catch (err) {
      console.warn("getGitWorkspaceInfo failed:", err);
    }
  };

  useEffect(() => {
    void refreshGitInfo(activeWorkspace.path);
  }, [activeWorkspace.path]);

  // Click outside to close context popovers
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        contextStripRef.current &&
        !contextStripRef.current.contains(e.target as Node)
      ) {
        setActiveContextPopup(null);
      }
    };
    if (activeContextPopup) {
      document.addEventListener("mousedown", handleOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutside);
    };
  }, [activeContextPopup]);

  const handleOpenFinder = async () => {
    setActiveContextPopup(null);
    try {
      const picked = await pickDirectory();
      if (picked) {
        const folderName = picked.split("/").filter(Boolean).pop() || "新项目";
        const newWs = addWorkspace(folderName, picked);
        setAllWorkspaces(getStoredWorkspaces());
        setActiveWorkspace(newWs);
        showToast(`已从 Mac Finder 关联工作区【${folderName}】`);
        void refreshGitInfo(picked);
      }
    } catch (err) {
      showToast(`调用 Mac Finder 失败: ${String(err)}`);
    }
  };

  const handleCheckoutBranch = async (bName: string, create: boolean = false) => {
    if (!activeWorkspace?.path) return;
    try {
      await checkoutGitBranch(activeWorkspace.path, bName, create);
      showToast(create ? `已创建并检出新分支【${bName}】` : `已切换至分支【${bName}】`);
      void refreshGitInfo(activeWorkspace.path);
    } catch (err) {
      showToast(`分支操作失败: ${String(err)}`);
    }
  };

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
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, busy]);

  // Global hotkey: Cmd+N / Ctrl+N to create a new session
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewSession();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sessions, activeWorkspace, selectedModel, selectedReasoning]);

  // Track session loading to prevent timestamp update on mere view/click
  const lastLoadedSessionRef = useRef<{ id: string; messages: ChatMessage[] } | null>(null);

  // Session switching
  useEffect(() => {
    if (!activeSessionId) return;
    localStorage.setItem(ACTIVE_SESSION_ID_KEY, activeSessionId);
    const target = sessions.find((s) => s.id === activeSessionId);
    if (target) {
      const msgs = target.messages || [];
      lastLoadedSessionRef.current = { id: target.id, messages: msgs };
      setMessages(msgs);
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
      const currentSession = prev.find((s) => s.id === activeSessionId);
      if (!currentSession) return prev;

      // Check if messages were just loaded from session switch
      const wasJustLoaded = lastLoadedSessionRef.current?.id === activeSessionId
        && lastLoadedSessionRef.current.messages === messages;

      // Only update timestamp when actual new messages are added or changed
      const hasNewOrChangedMessages = !wasJustLoaded && messages !== currentSession.messages && (
        messages.length !== (currentSession.messages?.length || 0) ||
        (messages.length > 0 && messages[messages.length - 1]?.content !== currentSession.messages?.[currentSession.messages.length - 1]?.content)
      );

      const nextUpdatedAt = hasNewOrChangedMessages ? Date.now() : currentSession.updatedAt;

      let title = currentSession.title;
      if ((!title || title === "新会话" || title === "新对话") && messages.length > 0) {
        const firstUser = messages.find((m) => m.sender === "user");
        if (firstUser) {
          title = firstUser.content.replace(/【.*?】/g, "").trim().slice(0, 24) || "新会话";
        }
      }

      // Avoid unnecessary state update if nothing changed
      if (
        currentSession.title === title &&
        currentSession.messages === messages &&
        currentSession.updatedAt === nextUpdatedAt &&
        currentSession.workspaceId === activeWorkspace.id &&
        currentSession.model === selectedModel &&
        currentSession.reasoning === selectedReasoning
      ) {
        return prev;
      }

      return prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          title,
          messages,
          updatedAt: nextUpdatedAt,
          workspaceId: activeWorkspace.id,
          model: selectedModel,
          reasoning: selectedReasoning,
        };
      });
    });
  }, [messages, activeWorkspace, selectedModel, selectedReasoning, activeSessionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => saveStoredChatSessions(sessions), 200);
    return () => window.clearTimeout(timer);
  }, [sessions]);

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

  const handleDeleteSession = (sessionId: string) => {
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
      // 0. CLI Agent Direct Execution Pattern (agy / codex)
      const isCliAgent =
        activeProvider.type === "local_cli" ||
        selectedModel.toLowerCase().includes("agy") ||
        selectedModel.toLowerCase().includes("codex");

      if (isCliAgent && !query.includes("定时") && !query.includes("每天")) {
        const isAgy = activeProvider.id.includes("agy") || selectedModel.toLowerCase().includes("agy");
        const agentName = isAgy ? "Google Antigravity (agy)" : "OpenAI Codex CLI (codex)";
        const startTime = Date.now();
        const activeRole = availableRoles.find((r) => r.id === selectedRoleId);
        const rolePrefix =
          activeRole && selectedRoleId !== "role-general"
            ? `担任【${activeRole.roleName}】`
            : "";

        const statusMsgId = `msg-ai-${Date.now()}`;
        const statusMsg: ChatMessage = {
          id: statusMsgId,
          sender: "assistant",
          content: `正在调用本地 CLI Agent【${agentName}】${rolePrefix}在工作区【${activeWorkspace.name}】（分支: ${currentBranch}）中执行任务，请稍候…`,
        };
        setMessages((prev) => [...prev, statusMsg]);

        void (async () => {
          try {
            const promptMessages: UnifiedMessage[] = [];
            if (activeRole && selectedRoleId !== "role-general" && activeRole.systemPrompt) {
              promptMessages.push({ role: "system", content: activeRole.systemPrompt });
            }
            promptMessages.push({ role: "user", content: query });

            const res = await UnifiedAgentAdapter.execute({
              providerId: activeProvider.id,
              model: selectedModel,
              messages: promptMessages,
              workspacePath: activeWorkspace.path,
              reasoningEffort:
                selectedReasoning.includes("深度") ||
                selectedReasoning.includes("强劲") ||
                selectedReasoning.includes("极致")
                  ? "深度"
                  : "快速",
            });

            const durationMs = Date.now() - startTime;
            const fullCmd = `${agentName} · 受限业务命令 · workspace=${activeWorkspace.path}`;

            const hasErr = res.content.startsWith("[CLI 执行错误]") || res.content.includes("CLI 退出码异常");

            const executionCard: CliExecutionCardData = {
              agentName,
              command: fullCmd,
              workspacePath: activeWorkspace.path,
              exitCode: hasErr ? 1 : 0,
              success: !hasErr,
              stdout: res.content,
              stderr: "",
              durationMs,
            };

            const aiMsg: ChatMessage = {
              id: `msg-ai-${Date.now()}`,
              sender: "assistant",
              content: `本地 CLI Agent【${agentName}】已在工作区【${activeWorkspace.name}】完成执行：`,
              cliExecution: executionCard,
            };

            setMessages((prev) => [...prev.filter((m) => m.id !== statusMsgId), aiMsg]);
          } catch (err) {
            const errMsg: ChatMessage = {
              id: `msg-ai-${Date.now()}`,
              sender: "assistant",
              content: `调用本地 CLI Agent 失败: ${String(err)}`,
            };
            setMessages((prev) => [...prev.filter((m) => m.id !== statusMsgId), errMsg]);
          } finally {
            setBusy(false);
          }
        })();
        return;
      }

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

  const groupedSessions = groupSessionsByTime(sessions);

  return (
    <div className="gpt-chat-root">
      {/* Left Collapsible History Sidebar */}
      <aside className={`chat-history-sidebar ${showHistory ? "" : "collapsed"}`}>
        {/* History heading and primary action */}
        <div className="history-top-actions">
          <span className="history-sidebar-title">对话</span>
        <button
            type="button"
            className="history-new-chat-btn"
            onClick={handleNewSession}
            title="开启新对话 (⌘N)"
          >
            <IconPlus size={13} stroke="currentColor" />
            <span>新建</span>
          </button>
        </div>

        {/* Chronological History List Grouped by Time */}
        <div className="history-sessions-list">
          {sessions.length === 0 ? (
            <div className="history-empty-state">
              <IconChat size={20} stroke="currentColor" />
              <span>暂无历史对话</span>
            </div>
          ) : (
            groupedSessions.map((group) => (
              <div key={group.label} className="history-group-section">
                <div className="history-group-label">{group.label}</div>
                <div className="history-group-items">
                  {group.items.map((s) => {
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
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteSessionId(s.id);
                          }}
                          title="删除此会话"
                        >
                          <IconTrash size={12} stroke="currentColor" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
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
            {!showHistory && (
              <button
                type="button"
                className="apple-btn-secondary"
                onClick={handleNewSession}
                style={{ fontSize: "12px", padding: "4px 9px", display: "inline-flex", alignItems: "center", gap: "4px" }}
              >
                <IconPlus size={12} stroke="currentColor" />
                <span>新建会话</span>
              </button>
            )}
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

                    {/* Local CLI Agent Execution Terminal Card */}
                    {m.cliExecution && (
                      <div className="gpt-card-artifact cli-execution-card">
                        <div className="card-artifact-top">
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <strong style={{ fontSize: "14px", color: "#111111", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                                <IconCpu size={15} />
                                {m.cliExecution.agentName}
                              </strong>
                              <span className={`apple-pill ${m.cliExecution.success ? "succeeded" : "failed"}`} style={{ fontSize: "10.5px" }}>
                                {m.cliExecution.success ? "执行成功" : `退出码 ${m.cliExecution.exitCode}`}
                              </span>
                              <span className="server-target-tag">
                                ⏱️ {(m.cliExecution.durationMs / 1000).toFixed(1)}s
                              </span>
                            </div>
                            <p style={{ fontSize: "12px", color: "#6e6e73", margin: "4px 0 0" }}>
                              工作区路径：{m.cliExecution.workspacePath}
                            </p>
                          </div>
                        </div>

                        {/* Terminal Box */}
                        <div className="cli-terminal-box">
                          <div className="cli-terminal-header">
                            <span className="cli-cmd-display">$ {m.cliExecution.command}</span>
                          </div>
                          <pre className="cli-terminal-output">
                            {m.cliExecution.stdout || "(无标准输出)"}
                          </pre>
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
          <div className="chat-attached-context-strip" ref={contextStripRef}>
            {/* Pill 1: 📁 Project Name (Click opens Upward Codex Popover) */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className={`context-strip-btn ${activeContextPopup === "project" ? "active" : ""}`}
                onClick={() =>
                  setActiveContextPopup(activeContextPopup === "project" ? null : "project")
                }
              >
                <IconFolder size={13} stroke="#38383a" />
                <span>{activeWorkspace?.name || "选择项目"}</span>
              </button>

              {activeContextPopup === "project" && (
                <div className="codex-context-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="codex-popover-search-box">
                    <IconSearch size={13} stroke="#8e8e93" />
                    <input
                      className="codex-popover-search-input"
                      placeholder="搜索项目"
                      value={projectSearchText}
                      onChange={(e) => setProjectSearchText(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="codex-popover-list">
                    {allWorkspaces
                      .filter(
                        (w) =>
                          w.name.toLowerCase().includes(projectSearchText.toLowerCase()) ||
                          w.path.toLowerCase().includes(projectSearchText.toLowerCase())
                      )
                      .map((ws) => {
                        const isSelected = ws.id === activeWorkspace.id;
                        return (
                          <div
                            key={ws.id}
                            className={`codex-popover-item ${isSelected ? "active" : ""}`}
                            onClick={() => {
                              setActiveWorkspace(ws);
                              setActiveWorkspaceId(ws.id);
                              setActiveContextPopup(null);
                              void refreshGitInfo(ws.path);
                              showToast(`已切换至项目【${ws.name}】`);
                            }}
                          >
                            <div className="codex-popover-item-left">
                              <IconFolder size={14} stroke={isSelected ? "#0071e3" : "#48484a"} />
                              <span className="codex-popover-item-text">{ws.name}</span>
                            </div>
                            {isSelected && <IconCheck size={13} stroke="#0071e3" />}
                          </div>
                        );
                      })}
                  </div>

                  <div className="codex-popover-divider" />

                  {/* Finder Integration */}
                  <button
                    type="button"
                    className="codex-popover-action-btn"
                    onClick={handleOpenFinder}
                  >
                    <IconPlus size={14} stroke="#48484a" />
                    <span>打开本地目录 (调用 Mac Finder)…</span>
                  </button>

                  <button
                    type="button"
                    className="codex-popover-action-btn"
                    onClick={() => {
                      const globalWs: Workspace = {
                        id: "ws-global",
                        name: "全局工作区",
                        path: "",
                        branch: "",
                        description: "不绑定特定项目目录",
                      };
                      setActiveWorkspace(globalWs);
                      setActiveWorkspaceId(globalWs.id);
                      setActiveContextPopup(null);
                      setGitInfo(null);
                      showToast("已切换至全局模式（不在特定项目中工作）");
                    }}
                  >
                    <IconClose size={13} stroke="#8e8e93" />
                    <span>不在项目中工作</span>
                  </button>
                </div>
              )}
            </div>

            {/* Pill 2: 💻 Local / Server (Click opens Upward Codex Popover) */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className={`context-strip-btn ${activeContextPopup === "env" ? "active" : ""}`}
                onClick={() =>
                  setActiveContextPopup(activeContextPopup === "env" ? null : "env")
                }
              >
                {envTarget === "local" ? (
                  <IconLaptop size={13} stroke="#38383a" />
                ) : (
                  <IconServer size={13} stroke="#38383a" />
                )}
                <span>{envDisplayLabel}</span>
              </button>

              {activeContextPopup === "env" && (
                <div className="codex-context-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="codex-popover-header">工作位置</div>

                  <div className="codex-popover-list">
                    <div
                      className={`codex-popover-item ${envTarget === "local" ? "active" : ""}`}
                      onClick={() => {
                        setEnvTarget("local");
                        persistActiveEnv("local");
                        setSelectedServerId(null);
                        persistActiveServerId(null);
                        setActiveContextPopup(null);
                        showToast("已切换执行环境至本机 (Localhost)");
                      }}
                    >
                      <div className="codex-popover-item-left">
                        <IconLaptop size={14} stroke={envTarget === "local" ? "#0071e3" : "#48484a"} />
                        <span className="codex-popover-item-text">本地</span>
                      </div>
                      {envTarget === "local" && <IconCheck size={13} stroke="#0071e3" />}
                    </div>

                    {servers.map((srv) => {
                      const isSelected = envTarget === "server" && selectedServerId === srv.id;
                      return (
                        <div
                          key={srv.id}
                          className={`codex-popover-item ${isSelected ? "active" : ""}`}
                          onClick={() => {
                            setEnvTarget("server");
                            persistActiveEnv("server");
                            setSelectedServerId(srv.id);
                            persistActiveServerId(srv.id);
                            setActiveContextPopup(null);
                            showToast(`已切换执行环境至服务器【${srv.name}】`);
                          }}
                        >
                          <div className="codex-popover-item-left">
                            <IconServer size={14} stroke={isSelected ? "#0071e3" : "#48484a"} />
                            <div>
                              <div className="codex-popover-item-text">{srv.name}</div>
                              <div className="codex-popover-item-sub">{srv.host}</div>
                            </div>
                          </div>
                          {isSelected && <IconCheck size={13} stroke="#0071e3" />}
                        </div>
                      );
                    })}
                  </div>

                  <div className="codex-popover-divider" />

                  <button
                    type="button"
                    className="codex-popover-action-btn"
                    onClick={() => {
                      setActiveContextPopup(null);
                      setShowServerModal(true);
                    }}
                  >
                    <IconSettings size={14} stroke="#48484a" />
                    <span>配置 / 新增服务器…</span>
                  </button>
                </div>
              )}
            </div>

            {/* Pill 3: ᛘ Git Branch (Click opens Upward Codex Popover) */}
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className={`context-strip-btn ${activeContextPopup === "branch" ? "active" : ""}`}
                onClick={() =>
                  setActiveContextPopup(activeContextPopup === "branch" ? null : "branch")
                }
              >
                <IconGitBranch size={13} stroke="#38383a" />
                <span>{currentBranch || "main"}</span>
              </button>

              {activeContextPopup === "branch" && (
                <div className="codex-context-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="codex-popover-search-box">
                    <IconSearch size={13} stroke="#8e8e93" />
                    <input
                      className="codex-popover-search-input"
                      placeholder={`搜索 ${activeWorkspace?.name || ""} 分支`}
                      value={branchSearchText}
                      onChange={(e) => setBranchSearchText(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="codex-popover-header">分支</div>

                  <div className="codex-popover-list">
                    {branches
                      .filter((b) => b.toLowerCase().includes(branchSearchText.toLowerCase()))
                      .map((b) => {
                        const isCurrent = b === currentBranch;
                        return (
                          <div
                            key={b}
                            className={`codex-popover-item ${isCurrent ? "active" : ""}`}
                            onClick={() => {
                              void handleCheckoutBranch(b, false);
                              setActiveContextPopup(null);
                            }}
                          >
                            <div className="codex-popover-item-left">
                              <IconGitBranch size={14} stroke={isCurrent ? "#0071e3" : "#48484a"} />
                              <div>
                                <div className="codex-popover-item-text">{b}</div>
                                {isCurrent && (
                                  <div className="codex-popover-item-sub">
                                    {gitInfo && gitInfo.uncommittedCount > 0
                                      ? `未提交：${gitInfo.uncommittedCount} 个文件`
                                      : "工作区干净"}
                                  </div>
                                )}
                              </div>
                            </div>
                            {isCurrent && <IconCheck size={13} stroke="#0071e3" />}
                          </div>
                        );
                      })}
                  </div>

                  <div className="codex-popover-divider" />

                  {isCreatingBranch ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (newBranchInput.trim()) {
                          void handleCheckoutBranch(newBranchInput.trim(), true);
                          setNewBranchInput("");
                          setIsCreatingBranch(false);
                          setActiveContextPopup(null);
                        }
                      }}
                      style={{ padding: "4px" }}
                    >
                      <input
                        className="feishu-input"
                        style={{ fontSize: "12px", padding: "4px 8px" }}
                        placeholder="输入新分支名称，按回车创建…"
                        value={newBranchInput}
                        onChange={(e) => setNewBranchInput(e.target.value)}
                        autoFocus
                      />
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="codex-popover-action-btn"
                      onClick={() => setIsCreatingBranch(true)}
                    >
                      <IconPlus size={14} stroke="#48484a" />
                      <span>创建并检出新分支…</span>
                    </button>
                  )}
                </div>
              )}
            </div>
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

              {/* Right: Decoupled Role dropdown, Model dropdown (both direction="up"), Mic, and Waveform */}
              <div className="chat-bottom-right">
                {/* 1. Decoupled Role Selector (Pops UPWARDS) */}
                <DrawerSelect
                  size="sm"
                  direction="up"
                  value={selectedRoleId}
                  onChange={(val) => {
                    setSelectedRoleId(val);
                    const role = availableRoles.find((r) => r.id === val);
                    showToast(`已切换角色设定至【${role?.roleName || "通用助手"}】`);
                  }}
                  options={availableRoles.map((r) => ({
                    value: r.id,
                    label: r.roleName,
                    description: r.description,
                    icon: <RoleIcon icon={r.icon} size={13} />,
                  }))}
                  customLabel={
                    selectedRoleId === "role-general"
                      ? "角色: 通用助手"
                      : `角色: ${availableRoles.find((r) => r.id === selectedRoleId)?.roleName || "助手"}`
                  }
                  triggerStyle={{
                    border: "1px solid #e5e5ea",
                    background: "#fbfbfd",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    color: "#3a3a3c",
                    fontWeight: 500,
                  }}
                />

                {/* 2. Decoupled Model Engine & Reasoning Selector (Codex 2-stage Slider + Picker) */}
                <CodexModelPopover
                  selectedModel={selectedModel}
                  selectedReasoning={selectedReasoning}
                  activeProvider={activeProvider}
                  onSelectModel={(model, providerId) => {
                    setSelectedModel(model);
                    if (providerId) {
                      const p = getStoredProviders().find((item) => item.id === providerId);
                      if (p) {
                        setActiveProvider(p);
                        setActiveProviderId(p.id);
                        showToast(`已切换执行引擎与账号至【${p.name}】`);
                      }
                    } else {
                      showToast(`已选择模型【${model}】`);
                    }
                  }}
                  onSelectReasoning={(level) => {
                    setSelectedReasoning(level);
                  }}
                  onOpenProviderModal={() => setShowProviderModal(true)}
                  onOpenTokenModal={() => setShowTokenModal(true)}
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

    {pendingDeleteSessionId && (
      <div className="apple-modal-backdrop" onClick={() => setPendingDeleteSessionId(null)}>
        <div className="apple-modal-card delete-confirm-card" onClick={(event) => event.stopPropagation()}>
          <h3>删除对话</h3>
          <p>
            确定删除“{sessions.find((session) => session.id === pendingDeleteSessionId)?.title || "新会话"}”吗？此操作无法撤销。
          </p>
          <div className="modal-btn-row">
            <button className="apple-btn-secondary" type="button" onClick={() => setPendingDeleteSessionId(null)}>
              取消
            </button>
            <button
              className="apple-btn-danger"
              type="button"
              onClick={() => {
                handleDeleteSession(pendingDeleteSessionId);
                setPendingDeleteSessionId(null);
              }}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    )}

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

    {/* Token Activity & Account Balance Modal */}
    {showTokenModal && (
      <TokenUsageModal
        onClose={() => setShowTokenModal(false)}
        onOpenProviderModal={() => {
          setShowTokenModal(false);
          setShowProviderModal(true);
        }}
      />
    )}
  </div>
  );
}
