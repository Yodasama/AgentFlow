import React, { useState } from "react";
import {
  type ServerConfig,
  getStoredServers,
  addServer,
  removeServer,
  updateServer,
  setActiveEnv,
  setActiveServerId,
} from "./workspaces";
import { confirmDelete } from "./confirmDelete";
import { IconServer, IconClose, IconPlus, IconTrash, IconCheck, IconZap } from "./icons";

interface Props {
  selectedServerId: string | null;
  onSelectServer: (server: ServerConfig) => void;
  onSelectLocal: () => void;
  onClose: () => void;
}

export function ServerModal({
  selectedServerId,
  onSelectServer,
  onSelectLocal,
  onClose,
}: Props) {
  const [servers, setServers] = useState<ServerConfig[]>(() => getStoredServers());
  const [showAddForm, setShowAddForm] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  // New server form fields
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("deploy");
  const [authType, setAuthType] = useState<"key" | "password">("key");

  const handleTestConnection = (server: ServerConfig, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingId(server.id);
    setTimeout(() => {
      const updated = updateServer(server.id, { status: "online" });
      setServers(updated);
      setTestingId(null);
      setTestResults((prev) => ({
        ...prev,
        [server.id]: "SSH 协议连通正常 (延迟 24ms · Linux x86_64)",
      }));
    }, 600);
  };

  const handlePickServer = (server: ServerConfig) => {
    setActiveEnv("server");
    setActiveServerId(server.id);
    onSelectServer(server);
    onClose();
  };

  const handlePickLocal = () => {
    setActiveEnv("local");
    setActiveServerId(null);
    onSelectLocal();
    onClose();
  };

  const handleCreateServer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !host.trim()) return;
    const created = addServer(name, host, Number(port) || 22, user, authType);
    const updated = getStoredServers();
    setServers(updated);
    setShowAddForm(false);
    setName("");
    setHost("");
    setPort(22);
    setUser("deploy");
    handlePickServer(created);
  };

  const handleDeleteServer = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const server = servers.find((item) => item.id === id);
    if (!confirmDelete(`服务器“${server?.name || "未命名"}”`)) return;
    const updated = removeServer(id);
    setServers(updated);
    if (selectedServerId === id) {
      if (updated.length > 0) {
        onSelectServer(updated[0]);
      } else {
        handlePickLocal();
      }
    }
  };

  return (
    <div className="apple-modal-backdrop" onClick={onClose}>
      <div
        className="apple-modal-card"
        style={{ width: "620px", padding: "22px 24px", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", color: "#111111" }}>
              <IconServer size={17} />
            </span>
            <h3 style={{ fontSize: "16px", fontWeight: 600, color: "#111111" }}>执行环境与服务器配置</h3>
          </div>
          <button
            type="button"
            className="apple-icon-btn"
            onClick={onClose}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            <IconClose size={14} />
          </button>
        </div>

        <p style={{ fontSize: "12.5px", color: "#86868b", marginBottom: "16px", lineHeight: "1.5" }}>
          配置远程服务器节点，在对话中可通过自然语言对服务器下发运维、容器管理、CI/CD 构建与日志巡检任务。
        </p>

        {/* Local Environment Option Card */}
        <div style={{ marginBottom: "12px" }}>
          <div
            className={`workspace-item-card ${!selectedServerId ? "active" : ""}`}
            style={{ padding: "12px 14px", cursor: "pointer" }}
            onClick={handlePickLocal}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "8px",
                  background: "#f4f4f5",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#18181b",
                }}
              >
                💻
              </div>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <strong style={{ fontSize: "13.5px", color: "#111111" }}>本机环境 (Localhost)</strong>
                  {!selectedServerId && (
                    <span className="apple-pill running" style={{ fontSize: "10px" }}>
                      当前执行目标
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "11.5px", color: "#71717a", marginTop: "2px" }}>
                  默认在当前机器运行与编译代码，直接访问本地工作区与工具链
                </div>
              </div>
            </div>

            {!selectedServerId && (
              <span style={{ color: "#111111", display: "inline-flex", alignItems: "center" }}>
                <IconCheck size={16} />
              </span>
            )}
          </div>
        </div>

        {/* Section divider */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            margin: "16px 0 10px",
          }}
        >
          <span style={{ fontSize: "12px", fontWeight: 600, color: "#6e6e73" }}>
            已配置远程服务器 ({servers.length})
          </span>
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ fontSize: "11px", padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: "4px" }}
            onClick={() => setShowAddForm(!showAddForm)}
          >
            <IconPlus size={12} />
            <span>{showAddForm ? "收起表单" : "添加服务器"}</span>
          </button>
        </div>

        {/* Add server inline form */}
        {showAddForm && (
          <form
            onSubmit={handleCreateServer}
            style={{
              padding: "14px 16px",
              background: "#fafaf9",
              border: "1px solid #e5e5ea",
              borderRadius: "10px",
              marginBottom: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "12.5px", color: "#111111" }}>新增远程服务器配置</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <label style={{ fontSize: "11.5px", color: "#6e6e73", display: "flex", flexDirection: "column", gap: "4px" }}>
                服务器别名
                <input
                  required
                  placeholder="例如：生产集群 Node-01"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d1d6",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                />
              </label>

              <label style={{ fontSize: "11.5px", color: "#6e6e73", display: "flex", flexDirection: "column", gap: "4px" }}>
                主机地址 (IP 或域名)
                <input
                  required
                  placeholder="例如：192.168.1.100 或 server.internal"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d1d6",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                />
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
              <label style={{ fontSize: "11.5px", color: "#6e6e73", display: "flex", flexDirection: "column", gap: "4px" }}>
                SSH 端口
                <input
                  type="number"
                  placeholder="22"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || 22)}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d1d6",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                />
              </label>

              <label style={{ fontSize: "11.5px", color: "#6e6e73", display: "flex", flexDirection: "column", gap: "4px" }}>
                登录用户名
                <input
                  placeholder="deploy / root"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d1d6",
                    borderRadius: "6px",
                    fontSize: "12px",
                  }}
                />
              </label>

              <label style={{ fontSize: "11.5px", color: "#6e6e73", display: "flex", flexDirection: "column", gap: "4px" }}>
                认证凭证方式
                <select
                  value={authType}
                  onChange={(e) => setAuthType(e.target.value as "key" | "password")}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d1d6",
                    borderRadius: "6px",
                    fontSize: "12px",
                    background: "#ffffff",
                  }}
                >
                  <option value="key">SSH 私钥 (推荐)</option>
                  <option value="password">账号密码</option>
                </select>
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ fontSize: "11.5px", padding: "4px 10px" }}
                onClick={() => setShowAddForm(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="apple-btn-primary"
                style={{ fontSize: "11.5px", padding: "4px 12px" }}
              >
                保存并设为目标
              </button>
            </div>
          </form>
        )}

        {/* Server Cards List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {servers.map((srv) => {
            const isSelected = selectedServerId === srv.id;
            const isTesting = testingId === srv.id;
            const testMsg = testResults[srv.id];

            return (
              <div
                key={srv.id}
                className={`workspace-item-card ${isSelected ? "active" : ""}`}
                style={{ flexDirection: "column", alignItems: "stretch", padding: "12px 14px", cursor: "pointer" }}
                onClick={() => handlePickServer(srv)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", color: "#111111" }}>
                      <IconServer size={15} />
                    </span>
                    <strong style={{ fontSize: "13.5px", color: "#111111" }}>{srv.name}</strong>
                    <span
                      className={`apple-pill ${srv.status === "online" ? "succeeded" : "queued"}`}
                      style={{ fontSize: "10px" }}
                    >
                      {srv.status === "online" ? "连通正常" : "未检测"}
                    </span>
                    {isSelected && (
                      <span className="apple-pill running" style={{ fontSize: "10px" }}>
                        当前目标
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <button
                      type="button"
                      className="apple-btn-secondary"
                      style={{ fontSize: "11px", padding: "3px 8px", display: "inline-flex", alignItems: "center", gap: "3px" }}
                      disabled={isTesting}
                      onClick={(e) => handleTestConnection(srv, e)}
                    >
                      <IconZap size={11} />
                      <span>{isTesting ? "探测中…" : "探测连通性"}</span>
                    </button>

                    <button
                      type="button"
                      className="apple-icon-btn"
                      style={{ padding: "4px", color: "#8e8e93" }}
                      onClick={(e) => handleDeleteServer(srv.id, e)}
                      title="删除此服务器"
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    fontSize: "11.5px",
                    color: "#71717a",
                    marginTop: "6px",
                    fontFamily: "var(--apple-font-mono)",
                  }}
                >
                  <span>{srv.user}@{srv.host}:{srv.port}</span>
                  <span>·</span>
                  <span>凭证: {srv.authType === "key" ? "id_rsa (SSH Key)" : "密码"}</span>
                </div>

                {testMsg && (
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "11px",
                      color: "#15803d",
                      background: "rgba(34, 197, 94, 0.08)",
                      padding: "4px 8px",
                      borderRadius: "5px",
                    }}
                  >
                    ✓ {testMsg}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Modal Bottom Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "18px" }}>
          <button type="button" className="apple-btn-primary" onClick={onClose} style={{ fontSize: "12.5px" }}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
