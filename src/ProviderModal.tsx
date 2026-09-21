import { useState } from "react";
import {
  type AgentProviderConfig,
  getStoredProviders,
  saveProviders,
  setActiveProviderId,
  detectLocalEndpoints,
  launchAgyLoginInTerminal,
} from "./agentAdapter";
import {
  IconZap,
  IconClose,
  IconSearch,
  IconCpu,
  IconCheck,
  IconAgent,
} from "./icons";

interface Props {
  activeProvider: AgentProviderConfig;
  onSelectProvider: (p: AgentProviderConfig) => void;
  onClose: () => void;
}

export function ProviderModal({ activeProvider, onSelectProvider, onClose }: Props) {
  const [providers, setProviders] = useState<AgentProviderConfig[]>(() => getStoredProviders());
  const [detecting, setDetecting] = useState(false);
  const [detectSummary, setDetectSummary] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Edit Provider Form
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editCustomHome, setEditCustomHome] = useState("");

  const handleRunDetect = async () => {
    setDetecting(true);
    setDetectSummary(null);
    try {
      const res = await detectLocalEndpoints();
      const updated = getStoredProviders();
      setProviders(updated);
      setDetectSummary(
        `探查就绪：检测到 agy (${res.cliAgyAvailable ? "已就绪" : "未发现"}) 与 codex (${res.cliCodexAvailable ? "已就绪" : "未发现"})。已同步各账号授权凭据。`
      );
    } catch {
      setDetectSummary("本地环境检测超时，请确认命令行工具已添加至 PATH。");
    } finally {
      setDetecting(false);
    }
  };

  const handleSelect = (p: AgentProviderConfig) => {
    setActiveProviderId(p.id);
    onSelectProvider(p);
    onClose();
  };

  const handleStartEdit = (p: AgentProviderConfig, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProviderId(p.id);
    setEditBaseUrl(p.baseUrl || "");
    setEditCustomHome(p.customHome || "");
  };

  const handleSaveEdit = (pId: string, e: React.FormEvent) => {
    e.preventDefault();
    const updated = providers.map((p) => {
      if (p.id === pId) {
        return {
          ...p,
          baseUrl: editBaseUrl.trim() || p.baseUrl,
          customHome: editCustomHome.trim() || undefined,
        };
      }
      return p;
    });
    setProviders(updated);
    saveProviders(updated);
    setEditingProviderId(null);
    if (activeProvider.id === pId) {
      const current = updated.find((p) => p.id === pId);
      if (current) onSelectProvider(current);
    }
  };

  const handleTerminalLogin = async (providerId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await launchAgyLoginInTerminal(providerId);
    setDetectSummary(`已唤起 macOS 终端执行登录。完成 Google 网页授权后，请点击上方【重新探查环境】更新凭证。`);
  };

  const handleCopyCommand = (cmd: string, pId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cmd);
    setCopiedId(pId);
    setTimeout(() => setCopiedId(null), 1800);
  };

  return (
    <div className="apple-modal-backdrop" onClick={onClose}>
      <div
        className="apple-modal-card"
        style={{ width: "660px", padding: "22px 24px", maxHeight: "88vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", color: "#0071e3" }}>
              <IconCpu size={18} />
            </span>
            <h3 style={{ fontSize: "16px", fontWeight: 600, color: "#1d1d1f" }}>可执行 Agent 引擎与账号调度</h3>
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

        <p style={{ fontSize: "12.5px", color: "#86868b", marginBottom: "14px", lineHeight: "1.4" }}>
          已清除模拟 Mock 数据，严格绑定本地真实 CLI 代理。通过隔离环境变量 <code style={{ background: "#f0f0f4", padding: "1px 4px", borderRadius: "4px" }}>HOME</code> 目录，实现 3 个 Google agy 独立账号与 OpenAI Codex 并发协同调度。
        </p>

        {/* Action Bar: Detection & Status */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px",
            background: "#fbfbfd",
            border: "1px solid #e5e5ea",
            borderRadius: "8px",
            marginBottom: "14px",
          }}
        >
          <div>
            <div style={{ fontSize: "12.5px", fontWeight: 600, color: "#1d1d1f" }}>本地 CLI 原生环境实时监控</div>
            <div style={{ fontSize: "11px", color: "#86868b" }}>
              自动化扫描 ~/.local/bin/agy 与 codex，验证各账号 OAuth 凭证
            </div>
          </div>
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ fontSize: "11.5px", padding: "4px 11px", display: "inline-flex", alignItems: "center", gap: "5px" }}
            disabled={detecting}
            onClick={handleRunDetect}
          >
            <IconSearch size={12} />
            <span>{detecting ? "探查中…" : "重新探查环境"}</span>
          </button>
        </div>

        {detectSummary && (
          <div className="apple-alert-box info" style={{ marginBottom: "12px", fontSize: "12px", padding: "8px 12px" }}>
            {detectSummary}
          </div>
        )}

        {/* Providers List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {providers.map((p) => {
            const isCurrent = p.id === activeProvider.id;
            const isEditing = editingProviderId === p.id;
            const isAgy = p.id.includes("agy");

            return (
              <div
                key={p.id}
                className={`workspace-item-card ${isCurrent ? "active" : ""}`}
                style={{
                  flexDirection: "column",
                  alignItems: "stretch",
                  padding: "14px 16px",
                  borderRadius: "10px",
                  border: isCurrent ? "1.5px solid #0071e3" : "1px solid #e5e5ea",
                  background: isCurrent ? "#f5f9ff" : "#ffffff",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.02)",
                  cursor: "pointer",
                }}
                onClick={() => !isEditing && handleSelect(p)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "6px",
                        background: isCurrent ? "#e0edff" : "#f5f5f7",
                        borderRadius: "8px",
                        color: isCurrent ? "#0071e3" : "#1d1d1f",
                      }}
                    >
                      {isAgy ? <IconZap size={15} /> : <IconAgent size={15} />}
                    </span>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <strong style={{ fontSize: "13.5px", color: "#1d1d1f" }}>{p.name}</strong>
                        {p.isAuthenticated ? (
                          <span className="apple-pill succeeded" style={{ fontSize: "10px", padding: "1px 6px" }}>
                            {p.accountEmail ? `已授权: ${p.accountEmail}` : "已就绪"}
                          </span>
                        ) : (
                          <span className="apple-pill queued" style={{ fontSize: "10px", padding: "1px 6px" }}>
                            待授权验证
                          </span>
                        )}
                        {isCurrent && (
                          <span className="apple-pill running" style={{ fontSize: "10px", padding: "1px 6px" }}>
                            当前默认引擎
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "11.5px", color: "#86868b", marginTop: "3px" }}>
                        {p.statusMessage || p.baseUrl}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="apple-btn-secondary"
                      style={{ fontSize: "11px", padding: "3px 8px" }}
                      onClick={(e) => handleStartEdit(p, e)}
                    >
                      {isEditing ? "取消" : "配置路径"}
                    </button>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="apple-btn-primary"
                        style={{ fontSize: "11px", padding: "3px 10px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelect(p);
                        }}
                      >
                        设为默认
                      </button>
                    )}
                  </div>
                </div>

                {/* Multi-Account Login Actions for agy accounts */}
                {isAgy && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginTop: "10px",
                      padding: "8px 10px",
                      background: isCurrent ? "#ffffff" : "#f9f9fb",
                      borderRadius: "6px",
                      border: "1px solid #ededf0",
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ fontSize: "11px", color: "#6e6e73", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>隔离目录:</span>
                      <code style={{ background: "#f0f0f4", padding: "1px 5px", borderRadius: "3px", color: "#1d1d1f" }}>
                        {p.customHome || "~ (系统主用户目录)"}
                      </code>
                    </div>

                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        className="apple-btn-secondary"
                        style={{ fontSize: "10.5px", padding: "2px 8px" }}
                        onClick={(e) =>
                          handleCopyCommand(
                            p.customHome ? `HOME=${p.customHome} agy` : `agy`,
                            p.id,
                            e
                          )
                        }
                      >
                        {copiedId === p.id ? "已复制命令" : "复制终端命令"}
                      </button>
                      <button
                        type="button"
                        className="apple-btn-primary"
                        style={{ fontSize: "10.5px", padding: "2px 8px" }}
                        onClick={(e) => handleTerminalLogin(p.id, e)}
                      >
                        一键唤起终端登录
                      </button>
                    </div>
                  </div>
                )}

                <div style={{ fontSize: "11px", color: "#6e6e73", marginTop: "8px" }}>
                  可用模式：{p.models.join(" · ")}
                </div>

                {/* Inline Configuration Editor */}
                {isEditing && (
                  <form
                    onSubmit={(e) => handleSaveEdit(p.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      marginTop: "10px",
                      padding: "12px",
                      background: "#f8f9fa",
                      borderRadius: "8px",
                      border: "1px solid #e5e5ea",
                    }}
                  >
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", marginBottom: "8px" }}>
                      CLI 可执行文件路径:
                      <input
                        className="feishu-input"
                        placeholder="/Users/yida/.local/bin/agy"
                        value={editBaseUrl}
                        onChange={(e) => setEditBaseUrl(e.target.value)}
                      />
                    </label>
                    {isAgy && (
                      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", marginBottom: "8px" }}>
                        自定义隔离 HOME 目录 (为空则使用系统默认):
                        <input
                          className="feishu-input"
                          placeholder="~/.agy-accounts/account2"
                          value={editCustomHome}
                          onChange={(e) => setEditCustomHome(e.target.value)}
                        />
                      </label>
                    )}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                      <button
                        type="button"
                        className="apple-btn-secondary"
                        style={{ fontSize: "11px" }}
                        onClick={() => setEditingProviderId(null)}
                      >
                        取消
                      </button>
                      <button type="submit" className="apple-btn-primary" style={{ fontSize: "11px" }}>
                        保存配置
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
          <button type="button" className="apple-btn-secondary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
