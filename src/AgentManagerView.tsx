import { useState, useEffect } from "react";

export interface AgentConfig {
  id: string;
  name: string;
  role: "开发" | "代码审查" | "测试验证" | "架构设计" | "质量决策";
  model: string;
  reasoningLevel: "极高" | "高" | "中等" | "快速";
  systemPrompt: string;
  description: string;
}

const defaultAgents: AgentConfig[] = [
  {
    id: "agent-dev",
    name: "核心开发 Agent",
    role: "开发",
    model: "Claude 3.5 Sonnet",
    reasoningLevel: "高",
    description: "专注高质量代码生成、重构与 Checkpoint 提交，严格遵循语言最佳实践。",
    systemPrompt: `你是一名资深全栈工程师。你的职责是根据任务要求和架构设计，编写健壮、可测试、符合规范的代码。
- 遵循单一职责与开闭原则。
- 每次修改后保证代码可编译，不产生冗余废弃代码。
- 如遇逻辑或设计问题，及时在 Checkpoint 留痕记录。`,
  },
  {
    id: "agent-review",
    name: "严苛审查 Agent",
    role: "代码审查",
    model: "Claude 3.5 Sonnet",
    reasoningLevel: "极高",
    description: "专注代码静态检查、安全性审计、边界条件审查，以阻断级（blocking）和警告级提出严谨意见。",
    systemPrompt: `你是一名严谨的安全与架构代码审查员。
- 重点审查潜在的空指针、并发竞争、内存泄露、外部输入校验缺失。
- 对未覆盖边界或测试不足的代码提出明确修改建议。
- 审查结果按 blocking（阻断）、warning（提示）分级输出，只有无阻塞项时才准予合并。`,
  },
  {
    id: "agent-test",
    name: "自动化测试 Agent",
    role: "测试验证",
    model: "自动化环境 (Test Runner)",
    reasoningLevel: "中等",
    description: "负责单元测试、集成测试驱动以及回归测试验证，捕获代码异常并生成测试报告。",
    systemPrompt: `负责运行自动化测试用例，捕获测试失败的堆栈信息。
- 分析测试失败的具体函数与行号。
- 输出结构化的测试报告，区分环境错误与代码逻辑断言失败。`,
  },
  {
    id: "agent-arch",
    name: "架构规划 Agent",
    role: "架构设计",
    model: "GPT-4o",
    reasoningLevel: "极高",
    description: "分析大颗粒度需求，产出清晰的模块拆解、领域模型与依赖关系。",
    systemPrompt: `你是一名系统架构师。负责把模糊需求分解为清晰的阶段节点。
- 输出接口签名、数据契约与调用时序。
- 确保模块间低耦合高内聚，为后续开发节点提供明确的输入约束。`,
  },
];

const STORAGE_KEY = "agentflow_custom_agents_v1";

export function AgentManagerView() {
  const [agents, setAgents] = useState<AgentConfig[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : defaultAgents;
    } catch {
      return defaultAgents;
    }
  });

  const [selectedAgentId, setSelectedAgentId] = useState<string>(agents[0]?.id || "agent-dev");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // New Agent Form State
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<AgentConfig["role"]>("开发");
  const [newModel, setNewModel] = useState("Claude 3.5 Sonnet");
  const [newReasoning, setNewReasoning] = useState<AgentConfig["reasoningLevel"]>("高");
  const [newPrompt, setNewPrompt] = useState("");

  const selected = agents.find((a) => a.id === selectedAgentId) || agents[0];

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
  }, [agents]);

  const handleUpdatePrompt = (prompt: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === selected.id ? { ...a, systemPrompt: prompt } : a))
    );
  };

  const handleUpdateModel = (model: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === selected.id ? { ...a, model } : a))
    );
  };

  const handleUpdateReasoning = (reasoningLevel: AgentConfig["reasoningLevel"]) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === selected.id ? { ...a, reasoningLevel } : a))
    );
  };

  const handleSave = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
  };

  const handleResetDefaults = () => {
    setAgents(defaultAgents);
    setSelectedAgentId(defaultAgents[0].id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultAgents));
  };

  const handleAddAgent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const newAgent: AgentConfig = {
      id: `agent-${Date.now()}`,
      name: newName.trim(),
      role: newRole,
      model: newModel,
      reasoningLevel: newReasoning,
      description: `自定义 ${newRole} 角色 Agent。`,
      systemPrompt:
        newPrompt.trim() ||
        `你是专职负责【${newRole}】任务的 AI 助理，请遵循工程规范，严谨高效地完成任务。`,
    };
    setAgents((prev) => [...prev, newAgent]);
    setSelectedAgentId(newAgent.id);
    setShowAddModal(false);
    setNewName("");
    setNewPrompt("");
  };

  const handleDeleteAgent = (id: string) => {
    if (agents.length <= 1) return;
    const remaining = agents.filter((a) => a.id !== id);
    setAgents(remaining);
    setSelectedAgentId(remaining[0].id);
  };

  return (
    <div className="agent-manager-page">
      <div className="page-header-row">
        <div>
          <h1>Agent 管理</h1>
          <p className="page-subtitle">
            配置不同功能角色的 Agent 模型、推理深度与专属系统提示词（System Prompt）。
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="apple-btn-secondary" type="button" onClick={handleResetDefaults}>
            恢复预设
          </button>
          <button className="apple-btn-primary" type="button" onClick={() => setShowAddModal(true)}>
            + 新增 Agent
          </button>
        </div>
      </div>

      <div className="agent-layout-grid">
        {/* Left List of Agents */}
        <div className="agent-sidebar-cards">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={`agent-nav-item ${agent.id === selected?.id ? "active" : ""}`}
              onClick={() => setSelectedAgentId(agent.id)}
            >
              <div className="agent-item-top">
                <span className="agent-name">{agent.name}</span>
                <span className="agent-role-pill">{agent.role}</span>
              </div>
              <p className="agent-item-desc">{agent.description}</p>
              <div className="agent-item-footer">
                <span>🤖 {agent.model}</span>
                <span style={{ fontSize: "11px", color: "#86868b" }}>
                  推理: {agent.reasoningLevel}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Right Detail & Prompt Editor */}
        {selected && (
          <div className="agent-editor-panel">
            <div className="editor-header">
              <div>
                <h2>{selected.name}</h2>
                <span style={{ fontSize: "13px", color: "#86868b" }}>
                  担任功能角色：<strong>{selected.role}</strong>
                </span>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                {saveSuccess && (
                  <span style={{ fontSize: "12px", color: "#24a159", fontWeight: 500 }}>
                    ✓ 配置已保存
                  </span>
                )}
                {agents.length > 1 && (
                  <button
                    className="apple-btn-secondary"
                    type="button"
                    style={{ color: "#e03e1a" }}
                    onClick={() => handleDeleteAgent(selected.id)}
                  >
                    删除此 Agent
                  </button>
                )}
                <button className="apple-btn-primary" type="button" onClick={handleSave}>
                  保存配置
                </button>
              </div>
            </div>

            <div className="editor-controls-row">
              <label>
                驱动模型 (Model)
                <select
                  value={selected.model}
                  onChange={(e) => handleUpdateModel(e.target.value)}
                >
                  <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet</option>
                  <option value="GPT-4o">GPT-4o</option>
                  <option value="DeepSeek-R1">DeepSeek-R1</option>
                  <option value="本地仿真模型 (Mock)">本地仿真模型 (Mock Runner)</option>
                </select>
              </label>

              <label>
                推理深度 (Reasoning Level)
                <select
                  value={selected.reasoningLevel}
                  onChange={(e) =>
                    handleUpdateReasoning(
                      e.target.value as AgentConfig["reasoningLevel"]
                    )
                  }
                >
                  <option value="极高">极高 (High Thinking / 复杂推导)</option>
                  <option value="高">高 (Standard Deep / 架构分析)</option>
                  <option value="中等">中等 (Balanced / 标准开发)</option>
                  <option value="快速">快速 (Fast / 简短总结)</option>
                </select>
              </label>
            </div>

            <div className="prompt-editor-section">
              <label>
                <strong>功能角色系统提示词 (System Prompt)</strong>
                <p style={{ margin: "2px 0 8px", fontSize: "12px", color: "#86868b" }}>
                  指导此 Agent 在工作流节点中专注执行对应角色的边界规范与输出要求。
                </p>
                <textarea
                  className="apple-textarea"
                  rows={12}
                  value={selected.systemPrompt}
                  onChange={(e) => handleUpdatePrompt(e.target.value)}
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Modal: Add Agent */}
      {showAddModal && (
        <div
          className="apple-modal-backdrop"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="apple-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新增功能角色 Agent</h3>
            <form onSubmit={handleAddAgent} className="modal-body-form">
              <label>
                Agent 名称
                <input
                  required
                  placeholder="例如：高级架构与数据库优化 Agent"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>

              <label>
                担任功能角色
                <select
                  value={newRole}
                  onChange={(e) =>
                    setNewRole(e.target.value as AgentConfig["role"])
                  }
                >
                  <option value="开发">开发 (Developer)</option>
                  <option value="代码审查">代码审查 (Reviewer)</option>
                  <option value="测试验证">测试验证 (Tester)</option>
                  <option value="架构设计">架构设计 (Architect)</option>
                  <option value="质量决策">质量决策 (Decision)</option>
                </select>
              </label>

              <label>
                默认驱动模型
                <select
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                >
                  <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet</option>
                  <option value="GPT-4o">GPT-4o</option>
                  <option value="DeepSeek-R1">DeepSeek-R1</option>
                  <option value="本地仿真模型 (Mock)">本地仿真模型 (Mock Runner)</option>
                </select>
              </label>

              <label>
                推理深度
                <select
                  value={newReasoning}
                  onChange={(e) =>
                    setNewReasoning(
                      e.target.value as AgentConfig["reasoningLevel"]
                    )
                  }
                >
                  <option value="极高">极高 (High Thinking)</option>
                  <option value="高">高 (Standard Deep)</option>
                  <option value="中等">中等 (Balanced)</option>
                  <option value="快速">快速 (Fast)</option>
                </select>
              </label>

              <label>
                角色系统提示词 (选填)
                <textarea
                  rows={4}
                  placeholder="留空将使用默认角色引导词…"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                />
              </label>

              <div className="modal-btn-row">
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowAddModal(false)}
                >
                  取消
                </button>
                <button className="apple-btn-primary" type="submit">
                  确认添加
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
