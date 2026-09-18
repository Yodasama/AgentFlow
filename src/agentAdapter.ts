import { detectLocalCliAgents, runCliAgent } from "./api";

export type ProviderType =
  | "local_ollama"
  | "local_lmstudio"
  | "local_cli"
  | "cloud_anthropic"
  | "cloud_openai"
  | "cloud_deepseek"
  | "custom_api";

export interface AgentProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
  detected: boolean; // Auto-detected status
  statusMessage?: string;
  models: string[];
}

export interface UnifiedMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface UnifiedChatRequest {
  providerId: string;
  model: string;
  messages: UnifiedMessage[];
  temperature?: number;
  reasoningEffort?: "快速" | "平衡" | "深度";
  workspacePath?: string;
}

export interface UnifiedChatResponse {
  content: string;
  model: string;
  providerName: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const PROVIDERS_STORAGE_KEY = "agentflow_agent_providers_v1";
const ACTIVE_PROVIDER_STORAGE_KEY = "agentflow_active_provider_id_v1";

export const DEFAULT_PROVIDERS: AgentProviderConfig[] = [
  {
    id: "provider-cli-agy",
    name: "Google Antigravity (agy CLI)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/agy",
    isLocal: true,
    detected: true,
    statusMessage: "本地 CLI 原生执行器 · 支持自主工具调用与工作区任务",
    models: ["agy (默认模式)", "agy (Gemini 2.0)", "agy (深度思考)"],
  },
  {
    id: "provider-cli-codex",
    name: "OpenAI Codex CLI (codex)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/codex",
    isLocal: true,
    detected: true,
    statusMessage: "本地 Codex 引擎 · 自动化代码编写与工程重构",
    models: ["codex exec (全权限模式)", "codex (默认)"],
  },
  {
    id: "provider-claude",
    name: "Anthropic Claude (官方 API)",
    type: "cloud_anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    isLocal: false,
    detected: false,
    statusMessage: "云端直连 · 擅长长上下文与架构代码",
    models: ["Claude 3.5 Sonnet", "Claude 3.5 Haiku", "Claude 3 Opus"],
  },
  {
    id: "provider-openai",
    name: "OpenAI (官方 API)",
    type: "cloud_openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    isLocal: false,
    detected: false,
    statusMessage: "云端直连 · 全能多模态与通用推理",
    models: ["GPT-4o", "GPT-4o-mini", "o1-preview", "o1-mini"],
  },
  {
    id: "provider-deepseek",
    name: "DeepSeek (官方 API)",
    type: "cloud_deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    isLocal: false,
    detected: false,
    statusMessage: "高性价比代码与长链推理",
    models: ["DeepSeek V3", "DeepSeek R1"],
  },
  {
    id: "provider-ollama",
    name: "Ollama (本地端点)",
    type: "local_ollama",
    baseUrl: "http://localhost:11434",
    isLocal: true,
    detected: false,
    statusMessage: "本地独立运行 · 免 API Key · 数据完全脱敏",
    models: ["llama3.3", "qwen2.5-coder", "deepseek-r1:8b"],
  },
  {
    id: "provider-lmstudio",
    name: "LM Studio (本地端点)",
    type: "local_lmstudio",
    baseUrl: "http://localhost:1234/v1",
    isLocal: true,
    detected: false,
    statusMessage: "本地 OpenAI 兼容服务器",
    models: ["local-model"],
  },
];

export function getStoredProviders(): AgentProviderConfig[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(DEFAULT_PROVIDERS));
      return DEFAULT_PROVIDERS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_PROVIDERS;

    // Ensure newly introduced CLI providers are merged in
    let changed = false;
    for (const def of DEFAULT_PROVIDERS) {
      if (!parsed.some((p) => p.id === def.id)) {
        parsed.unshift(def);
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return DEFAULT_PROVIDERS;
  }
}

export function saveProviders(list: AgentProviderConfig[]): void {
  localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(list));
}

export function getActiveProvider(): AgentProviderConfig {
  const list = getStoredProviders();
  const activeId = localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY);
  const found = list.find((p) => p.id === activeId);
  return found || list[0] || DEFAULT_PROVIDERS[0];
}

export function setActiveProviderId(id: string): void {
  localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, id);
}

/**
 * 自动检测本地运行环境 (Auto-Detect Local Services)
 * 检测本地 CLI Agent (agy / codex) 以及 Ollama (11434) 和 LM Studio (1234) 端点是否在线
 */
export async function detectLocalEndpoints(): Promise<{
  ollamaOnline: boolean;
  lmStudioOnline: boolean;
  ollamaModels: string[];
  cliAgyAvailable: boolean;
  cliCodexAvailable: boolean;
}> {
  let ollamaOnline = false;
  let lmStudioOnline = false;
  const ollamaModels: string[] = [];
  let cliAgyAvailable = false;
  let cliCodexAvailable = false;
  let agyPath: string | null = null;
  let codexPath: string | null = null;
  let agyVersion: string | null = null;
  let codexVersion: string | null = null;

  // 1. Detect Local CLI agents via Tauri invoke
  try {
    const detectedClis = await detectLocalCliAgents();
    const agy = detectedClis.find((c) => c.id === "agy");
    if (agy && agy.available) {
      cliAgyAvailable = true;
      agyPath = agy.executablePath;
      agyVersion = agy.version;
    }
    const codex = detectedClis.find((c) => c.id === "codex");
    if (codex && codex.available) {
      cliCodexAvailable = true;
      codexPath = codex.executablePath;
      codexVersion = codex.version;
    }
  } catch (err) {
    console.warn("detectLocalCliAgents failed:", err);
  }

  // 2. Ping Ollama tags
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: controller.signal,
      method: "GET",
    });
    clearTimeout(timer);
    if (res.ok) {
      ollamaOnline = true;
      const data = await res.json();
      if (Array.isArray(data.models)) {
        ollamaModels.push(...data.models.map((m: { name: string }) => m.name));
      }
    }
  } catch {
    ollamaOnline = false;
  }

  // 3. Ping LM Studio v1/models
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 600);
    const res = await fetch("http://localhost:1234/v1/models", {
      signal: controller.signal,
      method: "GET",
    });
    clearTimeout(timer);
    if (res.ok) {
      lmStudioOnline = true;
    }
  } catch {
    lmStudioOnline = false;
  }

  // Update stored providers with detected status
  const currentList = getStoredProviders();
  let changed = false;
  const updated = currentList.map((p) => {
    if (p.id === "provider-cli-agy") {
      changed = true;
      return {
        ...p,
        detected: cliAgyAvailable,
        baseUrl: agyPath || p.baseUrl,
        statusMessage: cliAgyAvailable
          ? `已就绪 (${agyPath || "/Users/yida/.local/bin/agy"}) · 支持 -p 无交互执行`
          : "未检测到本地 agy 命令 (检查 PATH 或安装路径)",
      };
    }
    if (p.id === "provider-cli-codex") {
      changed = true;
      return {
        ...p,
        detected: cliCodexAvailable,
        baseUrl: codexPath || p.baseUrl,
        statusMessage: cliCodexAvailable
          ? `已就绪 (${codexVersion || "codex-cli"}) · 支持 exec 自动化运行`
          : "未检测到本地 codex 命令 (检查 PATH 或安装路径)",
      };
    }
    if (p.type === "local_ollama") {
      changed = true;
      return {
        ...p,
        detected: ollamaOnline,
        models: ollamaModels.length > 0 ? ollamaModels : p.models,
        statusMessage: ollamaOnline
          ? `已自动检测到在线 (模型数: ${ollamaModels.length || 3})`
          : "未检测到运行进程 (可启动 ollama serve)",
      };
    }
    if (p.type === "local_lmstudio") {
      changed = true;
      return {
        ...p,
        detected: lmStudioOnline,
        statusMessage: lmStudioOnline
          ? "已自动检测到在线 (端口 1234)"
          : "未检测到运行进程 (可在 LM Studio 开启本地服务)",
      };
    }
    return p;
  });

  if (changed) {
    saveProviders(updated);
  }

  return { ollamaOnline, lmStudioOnline, ollamaModels, cliAgyAvailable, cliCodexAvailable };
}

/**
 * 统一 Adapter 核心适配类
 * 负责标准化输出与转发请求
 */
export class UnifiedAgentAdapter {
  static formatMessagesForOpenAI(messages: UnifiedMessage[]) {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  static formatMessagesForAnthropic(messages: UnifiedMessage[]) {
    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));
    return { system: systemMsg, messages: conversation };
  }

  /**
   * 统一执行调用抽象方法
   */
  static async execute(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const providers = getStoredProviders();
    const provider = providers.find((p) => p.id === req.providerId) || providers[0];

    // Handle Local CLI Agent execution (agy or codex)
    if (provider.type === "local_cli") {
      const userPrompt = req.messages.filter((m) => m.role === "user").pop()?.content || "";
      let program = provider.baseUrl || "agy";
      let args: string[] = [];

      if (provider.id.includes("agy") || req.model.toLowerCase().includes("agy")) {
        program = provider.baseUrl || "/Users/yida/.local/bin/agy";
        args = ["-p", userPrompt, "--dangerously-skip-permissions"];
        if (req.reasoningEffort === "深度") {
          args.push("--effort", "high");
        }
      } else if (provider.id.includes("codex") || req.model.toLowerCase().includes("codex")) {
        program = provider.baseUrl || "/Users/yida/.local/bin/codex";
        args = ["exec", userPrompt, "--dangerously-bypass-approvals-and-sandbox"];
        if (req.workspacePath) {
          args.push("-C", req.workspacePath);
        }
      } else {
        args = [userPrompt];
      }

      try {
        const result = await runCliAgent(program, args, req.workspacePath);
        const output =
          result.stdout.trim() ||
          result.stderr.trim() ||
          (result.success ? "CLI 任务已成功执行完成。" : `CLI 退出码异常: ${result.exitCode}`);

        return {
          content: output,
          model: req.model,
          providerName: provider.name,
          usage: {
            promptTokens: userPrompt.length,
            completionTokens: output.length,
            totalTokens: userPrompt.length + output.length,
          },
        };
      } catch (err) {
        return {
          content: `[CLI 执行错误] 无法拉起命令 ${program}: ${String(err)}`,
          model: req.model,
          providerName: provider.name,
        };
      }
    }

    // Standard simulated response for cloud or other endpoints without keys
    return {
      content: `[Unified Adapter: ${provider.name}] 已接收消息，执行模型：${req.model} (${req.reasoningEffort || "标准"})`,
      model: req.model,
      providerName: provider.name,
      usage: {
        promptTokens: 128,
        completionTokens: 356,
        totalTokens: 484,
      },
    };
  }
}
