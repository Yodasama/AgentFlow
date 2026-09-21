import { useState } from "react";
import {
  type Workspace,
  getStoredWorkspaces,
  setActiveWorkspaceId,
  addWorkspace,
  removeWorkspace,
} from "./workspaces";
import { confirmDelete } from "./confirmDelete";
import { IconFolder, IconClose } from "./icons";

interface Props {
  activeWorkspace: Workspace;
  onSelectWorkspace: (ws: Workspace) => void;
  onClose: () => void;
}

export function WorkspaceModal({ activeWorkspace, onSelectWorkspace, onClose }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => getStoredWorkspaces());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newBranch, setNewBranch] = useState("main");
  const [newDesc, setNewDesc] = useState("");

  const handleSelect = (ws: Workspace) => {
    setActiveWorkspaceId(ws.id);
    onSelectWorkspace(ws);
    onClose();
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPath.trim()) return;
    const created = addWorkspace(newName, newPath, newBranch, newDesc);
    const updated = getStoredWorkspaces();
    setWorkspaces(updated);
    onSelectWorkspace(created);
    setShowAddForm(false);
    setNewName("");
    setNewPath("");
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const workspace = workspaces.find((item) => item.id === id);
    if (!confirmDelete(`工作区“${workspace?.name || "未命名"}”`)) return;
    const updated = removeWorkspace(id);
    setWorkspaces(updated);
    if (activeWorkspace.id === id) {
      onSelectWorkspace(updated[0]);
    }
  };

  return (
    <div className="apple-modal-backdrop" onClick={onClose}>
      <div
        className="apple-modal-card"
        style={{ width: "560px", padding: "22px 24px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 600 }}>管理与切换工作区 (Workspace)</h3>
          <button type="button" className="apple-icon-btn" onClick={onClose} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <IconClose size={14} />
          </button>
        </div>
        <p style={{ fontSize: "12px", color: "#86868b", marginBottom: "14px" }}>
          不同的任务与大项目可运行在不同的工作区中。Agent 将在对应工作区的独立 Git 分支中隔离执行。
        </p>

        {/* Workspaces List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "280px", overflowY: "auto" }}>
          {workspaces.map((ws) => {
            const isCurrent = ws.id === activeWorkspace.id;
            return (
              <div
                key={ws.id}
                className={`workspace-item-card ${isCurrent ? "active" : ""}`}
                onClick={() => handleSelect(ws)}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontWeight: 600, fontSize: "13px", color: "#1d1d1f", display: "inline-flex", alignItems: "center", gap: "5px" }}>
                      <IconFolder size={14} />
                      {ws.name}
                    </span>
                    <span className="apple-pill queued" style={{ fontSize: "10px", padding: "1px 5px" }}>
                      分支: {ws.branch}
                    </span>
                    {isCurrent && (
                      <span className="apple-pill running" style={{ fontSize: "10px", padding: "1px 5px" }}>
                        当前生效
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "11px", fontFamily: "monospace", color: "#86868b", marginTop: "3px" }}>
                    {ws.path}
                  </div>
                  {ws.description && (
                    <div style={{ fontSize: "11px", color: "#86868b", marginTop: "2px" }}>
                      {ws.description}
                    </div>
                  )}
                </div>

                {workspaces.length > 1 && (
                  <button
                    type="button"
                    className="apple-icon-btn"
                    title="移除该工作区记录"
                    onClick={(e) => handleDelete(ws.id, e)}
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <IconClose size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Add Workspace Form */}
        {showAddForm ? (
          <form onSubmit={handleCreate} style={{ marginTop: "14px", padding: "12px", background: "#fbfbfd", border: "1px solid #e5e5ea", borderRadius: "8px" }}>
            <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "8px" }}>添加本地代码工作区</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: "8px", marginBottom: "6px" }}>
              <input
                required
                className="feishu-input"
                placeholder="工作区别名 (例如：前端移动端)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className="feishu-input"
                placeholder="主分支 (main)"
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
              />
            </div>
            <input
              required
              className="feishu-input"
              style={{ width: "100%", marginBottom: "6px" }}
              placeholder="本地绝对路径 (例如：/Users/yida/项目/MyApp)"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
            />
            <input
              className="feishu-input"
              style={{ width: "100%", marginBottom: "10px" }}
              placeholder="工作区描述 (可选)"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ fontSize: "11px" }}
                onClick={() => setShowAddForm(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="apple-btn-primary"
                style={{ fontSize: "11px" }}
              >
                确认添加并切换
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ width: "100%", marginTop: "12px", fontSize: "12px" }}
            onClick={() => setShowAddForm(true)}
          >
            + 关联新的本地项目文件夹 (工作区)
          </button>
        )}
      </div>
    </div>
  );
}
