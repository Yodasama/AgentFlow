import { useState } from "react";
import {
  type AgentProviderConfig,
  getStoredProviders,
  saveProviders,
  setActiveProviderId,
  detectLocalEndpoints,
} from "./agentAdapter";
import {
  IconZap,
  IconClose,
  IconSearch,
  IconLaptop,
  IconCloud,
  IconCheck,
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

  // Edit Provider Form
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editApiKey, setEditApiKey] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");

  const handleRunDetect = async () => {
    setDetecting(true);
    setDetectSummary(null);
    try {
      const res = await detectLocalEndpoints();
      const updated = getStoredProviders();
      setProviders(updated);
      const onlineCount = (res.ollamaOnline ? 1 : 0) + (res.lmStudioOnline ? 1 : 0);
      setDetectSummary(`检测完成：发现 ${onlineCount} 个本地端点在线（Ollama: ${res.ollamaOnline ? "在线" : "离线"}，LM Studio: ${res.lmStudioOnline ? "在线" : "离线"}）`);
    } catch {
      setDetectSummary("本地端点检测超时或未运行。");
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
    setEditApiKey(p.apiKey || "");
    setEditBaseUrl(p.baseUrl || "");
  };

  const handleSaveEdit = (pId: string, e: React.FormEvent) => {
    e.preventDefault();
    const updated = providers.map((p) => {
      if (p.id === pId) {
        return {
          ...p,
          apiKey: editApiKey.trim(),
          baseUrl: editBaseUrl.trim() || p.baseUrl,
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

  return (
    <div className="apple-modal-backdrop" onClick={onClose}>
      <div
        className="apple-modal-card"
        style={{ width: "620px", padding: "22px 24px", maxHeight: "88vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              <IconZap size={16} />
            </span>
            <h3 style={{ fontSize: "16px", fontWeight: 600 }}>Agent 接入源与适配器管理</h3>
          </div>
          <button type="button" className="apple-icon-btn" onClick={onClose} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <IconClose size={14} />
          </button>
        </div>

        <p style={{ fontSize: "12px", color: "#86868b", marginBottom: "14px" }}>
          支持本地模型环境自动探查（Ollama / LM Studio）与云端 API 直连（Claude / OpenAI / DeepSeek），通过 Unified Adapter 统一消息协议。
        </p>

        {/* Action Bar: Auto Detect Button */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "#fbfbfd", border: "1px solid #e5e5ea", borderRadius: "8px", marginBottom: "14px" }}>
          <div>
            <strong style={{ fontSize: "12.5px", color: "#1d1d1f" }}>本地环境探活</strong>
            <div style={{ fontSize: "11px", color: "#86868b" }}>自动扫描端口 11434 (Ollama) 与 1234 (LM Studio)</div>
          </div>
          <button
            type="button"
            className="apple-btn-secondary"
            style={{ fontSize: "11px", padding: "4px 10px", display: "inline-flex", alignItems: "center", gap: "5px" }}
            disabled={detecting}
            onClick={handleRunDetect}
          >
            <IconSearch size={12} />
            <span>{detecting ? "探查中…" : "一键自动检测"}</span>
          </button>
        </div>

        {detectSummary && (
          <div className="apple-alert-box info" style={{ marginBottom: "12px", fontSize: "12px", padding: "6px 12px" }}>
            {detectSummary}
          </div>
        )}

        {/* Providers List */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {providers.map((p) => {
            const isCurrent = p.id === activeProvider.id;
            const isEditing = editingProviderId === p.id;

            return (
              <div
                key={p.id}
                className={`workspace-item-card ${isCurrent ? "active" : ""}`}
                style={{ flexDirection: "column", alignItems: "stretch", padding: "12px" }}
                onClick={() => !isEditing && handleSelect(p)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center" }}>
                      {p.isLocal ? <IconLaptop size={14} /> : <IconCloud size={14} />}
                    </span>
                    <strong style={{ fontSize: "13px", color: "#1d1d1f" }}>{p.name}</strong>
                    {p.isLocal ? (
                      <span className={`apple-pill ${p.detected ? "succeeded" : "queued"}`} style={{ fontSize: "10px" }}>
                        {p.detected ? "在线" : "离线"}
                      </span>
                    ) : (
                      <span className="apple-pill succeeded" style={{ fontSize: "10px" }}>
                        {p.apiKey ? "已配置密钥" : "未设密钥"}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="apple-pill running" style={{ fontSize: "10px" }}>
                        当前生效
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="apple-btn-secondary"
                      style={{ fontSize: "11px", padding: "2px 7px" }}
                      onClick={(e) => handleStartEdit(p, e)}
                    >
                      {isEditing ? "取消" : "配置"}
                    </button>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="apple-btn-primary"
                        style={{ fontSize: "11px", padding: "2px 8px" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelect(p);
                        }}
                      >
                        选用
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ fontSize: "11.5px", color: "#86868b", marginTop: "4px" }}>
                  {p.statusMessage || p.baseUrl}
                </div>

                <div style={{ fontSize: "11px", color: "#6e6e73", marginTop: "2px" }}>
                  支持模型：{p.models.join(" · ")}
                </div>

                {/* Inline Configuration Editor */}
                {isEditing && (
                  <form
                    onSubmit={(e) => handleSaveEdit(p.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ marginTop: "10px", padding: "10px", background: "#f8f9fa", borderRadius: "6px", border: "1px solid #e5e5ea" }}
                  >
                    {!p.isLocal && (
                      <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", marginBottom: "6px" }}>
                        API Key:
                        <input
                          type="password"
                          className="feishu-input"
                          placeholder="sk-..."
                          value={editApiKey}
                          onChange={(e) => setEditApiKey(e.target.value)}
                        />
                      </label>
                    )}
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", marginBottom: "8px" }}>
                      API Base URL:
                      <input
                        className="feishu-input"
                        placeholder="https://..."
                        value={editBaseUrl}
                        onChange={(e) => setEditBaseUrl(e.target.value)}
                      />
                    </label>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px" }}>
                      <button
                        type="button"
                        className="apple-btn-secondary"
                        style={{ fontSize: "11px" }}
                        onClick={() => setEditingProviderId(null)}
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="apple-btn-primary"
                        style={{ fontSize: "11px" }}
                      >
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
          <button
            type="button"
            className="apple-btn-secondary"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
