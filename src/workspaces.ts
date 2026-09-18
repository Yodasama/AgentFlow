export interface Workspace {
  id: string;
  name: string;
  path: string;
  branch: string;
  description: string;
}

const STORAGE_KEY = "agentflow_workspaces_v1";
const ACTIVE_KEY = "agentflow_active_workspace_id_v1";

export const DEFAULT_WORKSPACES: Workspace[] = [
  {
    id: "ws-taskboard",
    name: "TaskBoard (主干)",
    path: "/Users/yida/项目/TaskBoard",
    branch: "Gemini",
    description: "当前工程全栈工作区 (Tauri + React + Rust)",
  },
  {
    id: "ws-backend",
    name: "Backend Service",
    path: "/Users/yida/项目/Backend-Service",
    branch: "main",
    description: "后端分布式数据持久层与微服务工程",
  },
  {
    id: "ws-infra",
    name: "Infra & DevOps",
    path: "/Users/yida/项目/Infra-Scripts",
    branch: "master",
    description: "CI/CD 流水线与服务器自动化探针工作区",
  },
];

export function getStoredWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_WORKSPACES));
      return DEFAULT_WORKSPACES;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_WORKSPACES;
  } catch {
    return DEFAULT_WORKSPACES;
  }
}

export function saveWorkspaces(list: Workspace[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function getActiveWorkspace(): Workspace {
  const list = getStoredWorkspaces();
  const activeId = localStorage.getItem(ACTIVE_KEY);
  const found = list.find((w) => w.id === activeId);
  return found || list[0] || DEFAULT_WORKSPACES[0];
}

export function setActiveWorkspaceId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function addWorkspace(name: string, path: string, branch = "main", description = ""): Workspace {
  const list = getStoredWorkspaces();
  const newWs: Workspace = {
    id: `ws-${Date.now()}`,
    name: name.trim(),
    path: path.trim(),
    branch: branch.trim() || "main",
    description: description.trim() || "本地项目代码仓库",
  };
  const updated = [...list, newWs];
  saveWorkspaces(updated);
  setActiveWorkspaceId(newWs.id);
  return newWs;
}

export function removeWorkspace(id: string): Workspace[] {
  const list = getStoredWorkspaces();
  const filtered = list.filter((w) => w.id !== id);
  const final = filtered.length > 0 ? filtered : DEFAULT_WORKSPACES;
  saveWorkspaces(final);
  setActiveWorkspaceId(final[0].id);
  return final;
}

const TASK_WORKSPACE_MAP_KEY = "agentflow_task_workspaces_v1";

export interface TaskWorkspaceBinding {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  branch: string;
}

export function getAllTaskWorkspaces(): Record<string, TaskWorkspaceBinding> {
  try {
    const raw = localStorage.getItem(TASK_WORKSPACE_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getTaskWorkspace(taskId: string): TaskWorkspaceBinding | null {
  const map = getAllTaskWorkspaces();
  return map[taskId] || null;
}

export function setTaskWorkspace(taskId: string, binding: TaskWorkspaceBinding): void {
  const map = getAllTaskWorkspaces();
  map[taskId] = binding;
  localStorage.setItem(TASK_WORKSPACE_MAP_KEY, JSON.stringify(map));
}

/* ============================================
   Server / Environment Target Management
   ============================================ */

export type EnvTarget = "local" | "server";

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: "password" | "key";
  status: "online" | "offline" | "unknown";
}

const SERVER_STORAGE_KEY = "agentflow_servers_v1";
const ACTIVE_ENV_KEY = "agentflow_active_env_v1";
const ACTIVE_SERVER_KEY = "agentflow_active_server_id_v1";

export const DEFAULT_SERVERS: ServerConfig[] = [
  {
    id: "srv-prod",
    name: "生产服务器",
    host: "192.168.1.100",
    port: 22,
    user: "deploy",
    authType: "key",
    status: "unknown",
  },
  {
    id: "srv-dev",
    name: "开发测试机",
    host: "10.0.0.50",
    port: 22,
    user: "dev",
    authType: "password",
    status: "unknown",
  },
];

export function getStoredServers(): ServerConfig[] {
  try {
    const raw = localStorage.getItem(SERVER_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(DEFAULT_SERVERS));
      return DEFAULT_SERVERS;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_SERVERS;
  } catch {
    return DEFAULT_SERVERS;
  }
}

export function saveServers(list: ServerConfig[]): void {
  localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(list));
}

export function addServer(
  name: string,
  host: string,
  port = 22,
  user = "root",
  authType: "password" | "key" = "key"
): ServerConfig {
  const list = getStoredServers();
  const srv: ServerConfig = {
    id: `srv-${Date.now()}`,
    name: name.trim(),
    host: host.trim(),
    port,
    user: user.trim(),
    authType,
    status: "unknown",
  };
  const updated = [...list, srv];
  saveServers(updated);
  return srv;
}

export function removeServer(id: string): ServerConfig[] {
  const list = getStoredServers();
  const filtered = list.filter((s) => s.id !== id);
  saveServers(filtered);
  return filtered;
}

export function getActiveEnv(): EnvTarget {
  const val = localStorage.getItem(ACTIVE_ENV_KEY);
  return val === "server" ? "server" : "local";
}

export function setActiveEnv(env: EnvTarget): void {
  localStorage.setItem(ACTIVE_ENV_KEY, env);
}

export function getActiveServerId(): string | null {
  return localStorage.getItem(ACTIVE_SERVER_KEY);
}

export function setActiveServerId(id: string | null): void {
  if (id) {
    localStorage.setItem(ACTIVE_SERVER_KEY, id);
  } else {
    localStorage.removeItem(ACTIVE_SERVER_KEY);
  }
}

export function updateServer(id: string, updates: Partial<ServerConfig>): ServerConfig[] {
  const list = getStoredServers();
  const updated = list.map((s) => (s.id === id ? { ...s, ...updates } : s));
  saveServers(updated);
  return updated;
}

/* ============================================
   Workspace Branch Management
   ============================================ */

export function getWorkspaceBranches(ws: Workspace): string[] {
  const DEFAULT_BRANCHES = ["Gemini", "main", "master", "dev", "feature/preview"];
  try {
    const raw = localStorage.getItem(`agentflow_ws_branches_${ws.id}`);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) {
        return Array.from(new Set([ws.branch, ...list].filter(Boolean)));
      }
    }
  } catch {}
  return Array.from(new Set([ws.branch, ...DEFAULT_BRANCHES].filter(Boolean)));
}

export function addWorkspaceBranch(wsId: string, newBranch: string): string[] {
  const ws = getStoredWorkspaces().find((w) => w.id === wsId);
  const current = ws ? getWorkspaceBranches(ws) : ["main"];
  const updated = Array.from(new Set([newBranch.trim(), ...current]));
  localStorage.setItem(`agentflow_ws_branches_${wsId}`, JSON.stringify(updated));
  return updated;
}

export function updateWorkspaceBranch(wsId: string, branchName: string): Workspace {
  const list = getStoredWorkspaces();
  const updated = list.map((w) =>
    w.id === wsId ? { ...w, branch: branchName.trim() } : w
  );
  saveWorkspaces(updated);
  addWorkspaceBranch(wsId, branchName);
  return updated.find((w) => w.id === wsId) || updated[0];
}



