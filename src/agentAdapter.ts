import { detectLocalCliAgents, runCliAgent, openCliLogin } from "./api";
import { getActiveSkillsPrompt } from "./skills";

export type ProviderType = "local_cli" | "custom_api";

export interface AgentProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
  detected: boolean;
  statusMessage?: string;
  models: string[];
  customHome?: string;
  accountEmail?: string;
  isAuthenticated?: boolean;
  loginCommand?: string;
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
  reasoningEffort?: "快速" | "平衡" | "深度" | "轻度" | "标准" | "强劲" | "极致";
  workspacePath?: string;
}

export interface UnifiedChatResponse {
  content: string;
  model: string;
  providerName: string;
  exitCode?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    thinkingTokens?: number;
    cacheReadTokens?: number;
  };
}


const PROVIDERS_STORAGE_KEY = "agentflow_agent_providers_v4_pure_cli";
const ACTIVE_PROVIDER_STORAGE_KEY = "agentflow_active_provider_id_v4";

export const AGY_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

export const CODEX_MODELS = [
  "GPT-6 Astra",
  "GPT-5.6 Sol",
  "GPT-5.6 Terra",
  "GPT-5.6 Luna",
  "GPT-5.5",
];

export const DEFAULT_PROVIDERS: AgentProviderConfig[] = [
  {
    id: "provider-cli-agy-1",
    name: "Google agy (账号 1 - 主账号)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/agy",
    isLocal: true,
    detected: true,
    statusMessage: "本地主账号环境 · maureentyler18@gmail.com",
    models: AGY_MODELS,
    customHome: undefined,
    isAuthenticated: true,
  },
  {
    id: "provider-cli-agy-2",
    name: "Google agy (账号 2)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/agy",
    isLocal: true,
    detected: true,
    statusMessage: "独立隔离环境 · ~/.agy-accounts/account2",
    models: AGY_MODELS,
    customHome: "~/.agy-accounts/account2",
    loginCommand: "HOME=~/.agy-accounts/account2 agy",
    isAuthenticated: false,
  },
  {
    id: "provider-cli-agy-3",
    name: "Google agy (账号 3)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/agy",
    isLocal: true,
    detected: true,
    statusMessage: "独立隔离环境 · ~/.agy-accounts/account3",
    models: AGY_MODELS,
    customHome: "~/.agy-accounts/account3",
    loginCommand: "HOME=~/.agy-accounts/account3 agy",
    isAuthenticated: false,
  },
  {
    id: "provider-cli-codex",
    name: "OpenAI Codex CLI (codex)",
    type: "local_cli",
    baseUrl: "/Users/yida/.local/bin/codex",
    isLocal: true,
    detected: true,
    statusMessage: "本地 Codex 引擎 · 自动化代码编写与工程重构",
    models: CODEX_MODELS,
    customHome: undefined,
    isAuthenticated: true,
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

    // Filter out any legacy non-CLI providers and make sure all default CLI providers are present
    const validCliProviders = parsed.filter((p) => p.type === "local_cli");
    let changed = false;

    for (const def of DEFAULT_PROVIDERS) {
      const existing = validCliProviders.find((p) => p.id === def.id);
      if (!existing) {
        validCliProviders.push(def);
        changed = true;
      } else if (JSON.stringify(existing.models) !== JSON.stringify(def.models)) {
        existing.models = def.models;
        changed = true;
      }
    }

    if (changed || validCliProviders.length !== parsed.length) {
      localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(validCliProviders));
    }
    return validCliProviders;
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
 * 自动检测本地运行环境 (Auto-Detect Local CLI Agents & Accounts)
 * 扫描本地 3 个 Google agy 账号环境与 OpenAI Codex CLI 状态
 */
export async function detectLocalEndpoints(): Promise<{
  cliAgyAvailable: boolean;
  cliCodexAvailable: boolean;
  accounts: { id: string; name: string; authenticated: boolean; email?: string }[];
}> {
  let cliAgyAvailable = false;
  let cliCodexAvailable = false;
  const accounts: { id: string; name: string; authenticated: boolean; email?: string }[] = [];

  try {
    const detectedClis = await detectLocalCliAgents();
    const currentList = getStoredProviders();
    let changed = false;

    const updated = currentList.map((p) => {
      if (p.id === "provider-cli-agy-1") {
        const found = detectedClis.find((c) => c.id === "agy-1");
        if (found) {
          cliAgyAvailable = found.available;
          changed = true;
          accounts.push({
            id: p.id,
            name: p.name,
            authenticated: found.isAuthenticated,
            email: found.accountEmail || undefined,
          });
          return {
            ...p,
            detected: found.available,
            baseUrl: found.executablePath || p.baseUrl,
            accountEmail: found.accountEmail || undefined,
            isAuthenticated: found.isAuthenticated,
            statusMessage: found.accountEmail
              ? `已授权: ${found.accountEmail}`
              : found.isAuthenticated
              ? "已授权（本地文件凭据）"
              : found.available
              ? "已就绪 (系统默认主账号)"
              : "未检测到本地 agy 命令",
          };
        }
      }
      if (p.id === "provider-cli-agy-2") {
        const found = detectedClis.find((c) => c.id === "agy-2");
        if (found) {
          changed = true;
          accounts.push({
            id: p.id,
            name: p.name,
            authenticated: found.isAuthenticated,
            email: found.accountEmail || undefined,
          });
          return {
            ...p,
            detected: found.available,
            baseUrl: found.executablePath || p.baseUrl,
            accountEmail: found.accountEmail || undefined,
            isAuthenticated: found.isAuthenticated,
            statusMessage: found.accountEmail
              ? `已授权: ${found.accountEmail}`
              : found.isAuthenticated
              ? "已授权（隔离文件凭据）"
              : "未登录 · 需在终端登录验证",
          };
        }
      }
      if (p.id === "provider-cli-agy-3") {
        const found = detectedClis.find((c) => c.id === "agy-3");
        if (found) {
          changed = true;
          accounts.push({
            id: p.id,
            name: p.name,
            authenticated: found.isAuthenticated,
            email: found.accountEmail || undefined,
          });
          return {
            ...p,
            detected: found.available,
            baseUrl: found.executablePath || p.baseUrl,
            accountEmail: found.accountEmail || undefined,
            isAuthenticated: found.isAuthenticated,
            statusMessage: found.accountEmail
              ? `已授权: ${found.accountEmail}`
              : found.isAuthenticated
              ? "已授权（隔离文件凭据）"
              : "未登录 · 需在终端登录验证",
          };
        }
      }
      if (p.id === "provider-cli-codex") {
        const found = detectedClis.find((c) => c.id === "codex");
        if (found) {
          cliCodexAvailable = found.available;
          changed = true;
          accounts.push({
            id: p.id,
            name: p.name,
            authenticated: found.available,
          });
          return {
            ...p,
            detected: found.available,
            baseUrl: found.executablePath || p.baseUrl,
            isAuthenticated: found.available,
            statusMessage: found.version
              ? `已就绪 (${found.version}) · 使用工作区沙箱执行`
              : "未检测到本地 codex 命令",
          };
        }
      }
      return p;
    });

    if (changed) {
      saveProviders(updated);
    }
  } catch (err) {
    console.warn("detectLocalEndpoints failed:", err);
  }

  return { cliAgyAvailable, cliCodexAvailable, accounts };
}

/**
 * 唤起系统终端执行指定 agy 账号登录
 */
export async function launchAgyLoginInTerminal(providerId: string) {
  await openCliLogin(providerId);
}

/**
 * 统一 Adapter 核心适配类
 * 仅执行真实可执行的 CLI Agent (agy / codex)
 */
export class UnifiedAgentAdapter {
  static async execute(req: UnifiedChatRequest): Promise<UnifiedChatResponse> {
    const providers = getStoredProviders();
    const provider = providers.find((p) => p.id === req.providerId) || providers[0];

    // Handle Local CLI Agent execution (agy or codex)
    if (provider.type === "local_cli") {
      const userPrompt = req.messages.filter((m) => m.role === "user").pop()?.content || "";
      if (provider.id.includes("agy") || req.model.toLowerCase().includes("gemini") || req.model.toLowerCase().includes("claude") || req.model.toLowerCase().includes("agy")) {
        // The Rust core selects the executable, account HOME, sandbox and allowed arguments.
      } else if (provider.id.includes("codex") || req.model.toLowerCase().includes("gpt") || req.model.toLowerCase().includes("codex")) {
      } else {
        return { content: `[CLI 执行错误] 不支持的 provider：${provider.id}`, model: req.model, providerName: provider.name };
      }

      try {
        if (!req.workspacePath) throw new Error("CLI 执行必须绑定工作区");
        const skillsPrompt = getActiveSkillsPrompt();
        const finalPrompt = skillsPrompt ? `${userPrompt}\n${skillsPrompt}` : userPrompt;
        const result = await runCliAgent({
          providerId: provider.id,
          prompt: finalPrompt,
          model: req.model,
          reasoningEffort: req.reasoningEffort || "平衡",
          workingDirectory: req.workspacePath,
        });
        const output =
          result.stdout.trim() ||
          result.stderr.trim() ||
          (result.success ? "CLI 任务已成功执行完成。" : `CLI 退出码异常: ${result.exitCode}`);

        return {
          content: output,
          model: req.model,
          providerName: provider.name,
          usage: result.usage
            ? {
                promptTokens: result.usage.inputTokens,
                completionTokens: result.usage.outputTokens,
                thinkingTokens: result.usage.thinkingTokens,
                cacheReadTokens: result.usage.cacheReadTokens,
                totalTokens: result.usage.totalTokens,
              }
            : undefined,
        };
      } catch (err) {
        return {
          content: `[CLI 执行错误] 无法启动受限 provider：${String(err)}`,
          model: req.model,
          providerName: provider.name,
        };
      }
    }

    return {
      content: `[CLI 原生模式] 未知的本地 CLI 执行器：${provider.name}`,
      model: req.model,
      providerName: provider.name,
    };
  }
}
