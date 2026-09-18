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
