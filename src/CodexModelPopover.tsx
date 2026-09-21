import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  IconZap,
  IconChevronRight,
  IconChevronLeft,
  IconRotateCcw,
  IconCheck,
  IconSettings,
  IconCpu,
  IconActivity,
} from "./icons";
import {
  getStoredProviders,
  AgentProviderConfig,
} from "./agentAdapter";

export interface CodexModelPopoverProps {
  selectedModel: string;
  selectedReasoning: string;
  onSelectModel: (model: string, providerId: string) => void;
  onSelectReasoning: (level: string) => void;
  onOpenProviderModal?: () => void;
  onOpenTokenModal?: () => void;
  activeProvider: AgentProviderConfig;
}

export const REASONING_STEPS = [
  { index: 0, label: "轻度", desc: "快速极速响应 (Low)" },
  { index: 1, label: "中等", desc: "日常任务思考 (Medium)" },
  { index: 2, label: "深度", desc: "深度长链自检 (High)" },
];

export function CodexModelPopover({
  selectedModel,
  selectedReasoning,
  onSelectModel,
  onSelectReasoning,
  onOpenProviderModal,
  onOpenTokenModal,
  activeProvider,
}: CodexModelPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<"slider" | "models">("slider");
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  // Stored providers (all local CLI agents)
  const providers = useMemo(() => getStoredProviders(), [isOpen]);

  // Tab state within stage 2 (defaults to the currently active provider's ID)
  const [selectedAgentId, setSelectedAgentId] = useState<string>(activeProvider.id);

  // Sync selectedAgentId if activeProvider changes externally
  useEffect(() => {
    setSelectedAgentId(activeProvider.id);
  }, [activeProvider.id]);

  // Current targeted agent provider in the popup
  const currentAgent = useMemo(() => {
    return providers.find((p) => p.id === selectedAgentId) || activeProvider;
  }, [providers, selectedAgentId, activeProvider]);

  // Determine active reasoning step index (0..2: 轻度 / 中等 / 深度)
  const getReasoningIndex = (str: string): number => {
    if (str.includes("深度") || str.includes("High") || str.includes("极致") || str.includes("强劲")) return 2;
    if (str.includes("中等") || str.includes("标准") || str.includes("Medium")) return 1;
    return 0; // Default to 0 ("轻度")
  };

  const currentIndex = getReasoningIndex(selectedReasoning);
  const currentStep = REASONING_STEPS[currentIndex];

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setView("slider");
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        setIsOpen(false);
        setView("slider");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Snap calculation for discrete slider
  const updateSliderFromX = (clientX: number) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetIdx = Math.round(ratio * (REASONING_STEPS.length - 1));
    const safeIdx = Math.max(0, Math.min(REASONING_STEPS.length - 1, targetIdx));
    onSelectReasoning(REASONING_STEPS[safeIdx].label);
  };

  const handleTrackMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    updateSliderFromX(e.clientX);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (isDraggingRef.current) {
        updateSliderFromX(moveEvent.clientX);
      }
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelectReasoning("轻度");
  };

  // Helper for agent short name
  const getAgentShortName = (p: AgentProviderConfig) => {
    if (p.id === "provider-cli-agy-1") return "agy 账号1";
    if (p.id === "provider-cli-agy-2") return "agy 账号2";
    if (p.id === "provider-cli-agy-3") return "agy 账号3";
    if (p.id === "provider-cli-codex") return "Codex";
    return p.name.split(" ")[0];
  };

  // When switching agent tabs:
  const handleSwitchAgentTab = (providerId: string) => {
    setSelectedAgentId(providerId);
    const target = providers.find((p) => p.id === providerId);
    if (!target) return;

    // If current model does not exist in target agent's models, switch to target's primary model
    if (!target.models.includes(selectedModel)) {
      const defaultForAgent = target.models[0] || "默认模式";
      onSelectModel(defaultForAgent, target.id);
    } else {
      // Model belongs to both or stays active
      onSelectModel(selectedModel, target.id);
    }
  };

  const activeAgentShort = getAgentShortName(activeProvider);
  const modelShortName = selectedModel.replace(/Claude-|GPT-/g, "").split(" ")[0] || selectedModel;
  const triggerLabel = `${activeAgentShort} · ${modelShortName} · ${currentStep.label}`;

  return (
    <div className="codex-model-container" ref={containerRef}>
      {/* Dock Trigger Button */}
      <button
        type="button"
        className={`codex-model-trigger-btn ${isOpen ? "active" : ""}`}
        onClick={() => {
          setIsOpen(!isOpen);
          setView("slider");
          setSelectedAgentId(activeProvider.id);
        }}
        title={`当前 Agent: ${activeProvider.name} | 模型: ${selectedModel} | 推理: ${currentStep.label}`}
      >
        <IconZap size={13} stroke="#5c5c60" />
        <span className="codex-model-trigger-text">{triggerLabel}</span>
      </button>

      {/* Floating Two-Stage Card Popover */}
      {isOpen && (
        <div className="codex-model-popover">
          {view === "slider" ? (
            /* ================= STAGE 1: REASONING SLIDER CARD ================= */
            <div className="codex-slider-card">
              {/* Top Header Row */}
              <div className="codex-slider-header">
                {/* Left Lightning Icon */}
                <div className="codex-slider-icon-left">
                  <IconZap size={15} stroke="#8e8e93" />
                </div>

                {/* Center Clickable Title & Subtitle */}
                <div
                  className="codex-slider-title-block"
                  onClick={() => setView("models")}
                  title="点击切换 CLI Agent 或模型"
                >
                  <div className="codex-slider-level-text">
                    <span>{currentStep.label}</span>
                    <IconChevronRight size={13} stroke="#0071e3" strokeWidth={2.2} />
                  </div>
                  <div className="codex-slider-model-subtitle">
                    <span className="agent-badge-tag">{activeAgentShort}</span>
                    <span className="model-name-tag">{selectedModel}</span>
                  </div>
                </div>

                {/* Right Reset Icon */}
                <button
                  type="button"
                  className="codex-slider-reset-btn"
                  onClick={handleReset}
                  title="重置为默认推理强度 (轻度)"
                >
                  <IconRotateCcw size={14} stroke="#8e8e93" />
                </button>
              </div>

              {/* Discrete Slider Track with 5 Dots */}
              <div
                className="codex-slider-track-wrap"
                ref={trackRef}
                onMouseDown={handleTrackMouseDown}
              >
                {/* Discrete Dots */}
                {REASONING_STEPS.map((step, idx) => (
                  <div
                    key={step.index}
                    className={`codex-slider-dot ${idx === currentIndex ? "covered" : ""}`}
                    style={{
                      left: `calc(11px + (100% - 22px) * ${idx / (REASONING_STEPS.length - 1)})`,
                    }}
                  />
                ))}

                {/* Snapping Circular Knob */}
                <div
                  className="codex-slider-knob"
                  style={{
                    left: `calc(2px + (100% - 22px) * ${currentIndex / (REASONING_STEPS.length - 1)})`,
                  }}
                />
              </div>
            </div>
          ) : (
            /* ================= STAGE 2: AGENT & MODEL PICKER CARD ================= */
            <div className="codex-picker-card">
              {/* Header */}
              <div className="codex-picker-header">
                <div className="codex-picker-topline">
                  <button
                    type="button"
                    className="codex-picker-back-btn"
                    onClick={() => setView("slider")}
                    title="返回推理强度设置"
                  >
                    <IconChevronLeft size={13} stroke="#8e8e93" />
                    <span>推理设置</span>
                  </button>
                </div>
                <div className="codex-picker-title">选择 CLI Agent 与模型</div>
              </div>

              {/* 1. CLI Agent Switcher Tabs */}
              <div className="codex-agent-segmented-bar">
                {providers.map((p) => {
                  const isCurrent = p.id === selectedAgentId;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`codex-agent-seg-tab ${isCurrent ? "active" : ""}`}
                      onClick={() => handleSwitchAgentTab(p.id)}
                      title={p.name}
                    >
                      {getAgentShortName(p)}
                    </button>
                  );
                })}
              </div>

              {/* Active Agent Context Badge */}
              <div className="codex-agent-env-badge">
                <span className="agent-env-dot" />
                <span className="agent-env-text">
                  {currentAgent.name} · {currentAgent.statusMessage || "就绪"}
                </span>
              </div>

              {/* Section Subheader: Authentic Models for Current Agent */}
              <div className="codex-agent-models-header">
                <span>该 Agent 提供的专属模型集</span>
                <span className="models-count">{currentAgent.models.length} 个可用</span>
              </div>

              {/* Scrollable Model List FOR THE CURRENT AGENT ONLY */}
              <div className="codex-picker-list">
                {currentAgent.models.map((model) => {
                  const isSelected =
                    selectedModel === model && activeProvider.id === currentAgent.id;
                  return (
                    <div
                      key={model}
                      className={`codex-picker-item ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        onSelectModel(model, currentAgent.id);
                        setView("slider");
                      }}
                    >
                      <div className="codex-picker-item-left">
                        <IconCpu size={13} stroke={isSelected ? "#0071e3" : "#8e8e93"} />
                        <span className="codex-picker-item-name">{model}</span>
                      </div>
                      {isSelected && (
                        <span className="codex-picker-item-check">
                          <IconCheck size={15} stroke="#0071e3" strokeWidth={2.4} />
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* Footer Token Activity & Balance Option */}
                {onOpenTokenModal && (
                  <div
                    className="codex-picker-item manage-action"
                    onClick={() => {
                      setIsOpen(false);
                      onOpenTokenModal();
                    }}
                  >
                    <span className="codex-picker-item-name" style={{ color: "#0071e3" }}>
                      📊 查看 Token 活动与账户余额…
                    </span>
                    <IconActivity size={14} stroke="#0071e3" />
                  </div>
                )}

                {/* Footer Manage Option */}
                {onOpenProviderModal && (
                  <div
                    className="codex-picker-item manage-action"
                    onClick={() => {
                      setIsOpen(false);
                      onOpenProviderModal();
                    }}
                  >
                    <span className="codex-picker-item-name" style={{ color: "#0071e3" }}>
                      ⇄ 管理本地多账号与隔离环境…
                    </span>
                    <IconSettings size={14} stroke="#0071e3" />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
