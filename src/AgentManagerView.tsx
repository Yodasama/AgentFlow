import { useState, useEffect } from "react";

export interface AgentConfig {
  id: string;
  name: string;
  role: "开发" | "代码审查" | "测试验证" | "架构设计";
  icon: string;
  model: string;
  reasoningLevel: "快速" | "标准" | "深度" | "极致思维";
  systemPrompt: string;
  description: string;
  allowWorkspaceReadWrite: boolean;
  allowShellExecution: boolean;
  allowCheckpointCommit: boolean;
}

const defaultAgents: AgentConfig[] = [
  {
    id: "agent-dev",
    name: "核心开发 Agent",
    role: "开发",
    icon: "👨‍💻",
    model: "Claude 3.5 Sonnet",
    reasoningLevel: "深度",
    description: "专注代码编写、重构与 Checkpoint 提交，严格遵循单一职责与语言最佳实践。",
    allowWorkspaceReadWrite: true,
    allowShellExecution: true,
    allowCheckpointCommit: true,
    systemPrompt: `你是一名资深全栈工程师。你的职责是根据任务需求和架构设计，编写健壮、可测试、符合规范的代码。
- 遵循单一职责与开闭原则。
- 每次修改后保证代码可编译，不产生冗余废弃代码。
- 如遇逻辑或设计问题，及时在 Checkpoint 留痕记录。

当前任务上下文：
- 任务名称：{task_title}
- 验收标准：{acceptance_criteria}
- 工作区路径：{workspace_path}`,
  },
  {
    id: "agent-review",
    name: "严苛审查 Agent",
    role: "代码审查",
    icon: "🔍",
    model: "Claude 3.5 Sonnet",
    reasoningLevel: "极致思维",
    description: "专注代码静态检查、安全性审计、边界条件审查，以阻断级（blocking）和警告级提出严谨意见。",
    allowWorkspaceReadWrite: true,
    allowShellExecution: false,
    allowCheckpointCommit: false,
    systemPrompt: `你是一名严谨的安全与架构代码审查员。
- 重点审查潜在的空指针、并发竞争、内存泄露、外部输入校验缺失。
- 对未覆盖边界或测试不足的代码提出明确修改建议。
- 审查结果按 blocking（阻断）、warning（提示）分级输出，只有无阻塞项时才准予合并。

待审查代码 Diff：
{git_diff}`,
  },
  {
    id: "agent-test",
    name: "自动化测试 Agent",
    role: "测试验证",
    icon: "🧪",
    model: "自动化环境 (Test Runner)",
    reasoningLevel: "标准",
    description: "负责单元测试、集成测试驱动以及回归测试验证，捕获代码异常并生成测试报告。",
    allowWorkspaceReadWrite: true,
    allowShellExecution: true,
    allowCheckpointCommit: false,
    systemPrompt: `负责运行自动化测试用例，捕获测试失败的堆栈信息。
- 分析测试失败的具体函数与行号。
- 输出结构化的测试报告，区分环境错误与代码逻辑断言失败。`,
  },
  {
    id: "agent-arch",
    name: "架构规划 Agent",
    role: "架构设计",
    icon: "📐",
    model: "GPT-4o",
    reasoningLevel: "深度",
    description: "分析大颗粒度需求，产出清晰的模块拆解、领域模型与依赖关系。",
    allowWorkspaceReadWrite: true,
    allowShellExecution: false,
    allowCheckpointCommit: false,
    systemPrompt: `你是一名系统架构师。负责把模糊需求分解为清晰的阶段节点。
- 输出接口签名、数据契约与调用时序。
- 确保模块间低耦合高内聚，为后续开发节点提供明确的输入约束。`,
  },
];

const STORAGE_KEY = "agentflow_custom_agents_v2";

const reasoningDescriptions: Record<AgentConfig["reasoningLevel"], { desc: string; steps: string; token: string }> = {
  快速: {
    desc: "思考步数极少，毫秒级响应，适合代码格式化、简单拼写修复或轻量说明生成。",
    steps: "1 ~ 2 步思考",
    token: "约 500 Tokens 预算",
  },
  标准: {
    desc: "兼顾响应速度与代码可靠度，适合常规功能开发、基础单元测试与日常审查。",
    steps: "4 ~ 8 步思考",
    token: "约 2,000 Tokens 预算",
  },
  深度: {
    desc: "多轮推演边界条件与架构耦合，适合复杂业务逻辑编写、并发控制与深度回归。",
    steps: "16 ~ 32 步深度推演",
    token: "约 8,000 Tokens 预算",
  },
  极致思维: {
    desc: "启用完整思维链（Extended Thinking），彻底穷举所有可能的分支异常与安全漏洞。",
    steps: "64+ 步全量思维链",
    token: "约 16,000+ Tokens 预算",
  },
};

const modelOptions = [
  { id: "Claude 3.5 Sonnet", badge: "推荐 · 编程与架构", provider: "Anthropic" },
  { id: "GPT-4o", badge: "全能 · 逻辑与规划", provider: "OpenAI" },
  { id: "DeepSeek-R1", badge: "极致推演 · 思维链", provider: "DeepSeek" },
  { id: "自动化环境 (Test Runner)", badge: "本地原生 · 零消耗", provider: "Local Runner" },
];

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
  const [showAddModal, setShowAddModal] = useState(false);
  const [saveBanner, setSaveBanner] = useState(false);

  // New agent form
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<AgentConfig["role"]>("开发");
  const [newModel, setNewModel] = useState("Claude 3.5 Sonnet");
  const [newReasoning, setNewReasoning] = useState<AgentConfig["reasoningLevel"]>("深度");

  const selected = agents.find((a) => a.id === selectedAgentId) || agents[0];

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agents));
  }, [agents]);

  const triggerSaveHint = () => {
    setSaveBanner(true);
    setTimeout(() => setSaveBanner(false), 1500);
  };

  const updateSelectedAgent = (patch: Partial<AgentConfig>) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === selected.id ? { ...a, ...patch } : a))
    );
    triggerSaveHint();
  };

  const handleInsertVariable = (varName: string) => {
    const updatedPrompt = `${selected.systemPrompt} {${varName}}`;
    updateSelectedAgent({ systemPrompt: updatedPrompt });
  };

  const handleResetToDefaults = () => {
    setAgents(defaultAgents);
    setSelectedAgentId(defaultAgents[0].id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultAgents));
    triggerSaveHint();
  };

  const handleAddAgent = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const roleIcons: Record<AgentConfig["role"], string> = {
      开发: "👨‍💻",
      代码审查: "🔍",
      测试验证: "🧪",
      架构设计: "📐",
    };
    const newAgent: AgentConfig = {
      id: `agent-${Date.now()}`,
      name: newName.trim(),
      role: newRole,
      icon: roleIcons[newRole] || "🤖",
      model: newModel,
      reasoningLevel: newReasoning,
      description: `自定义 ${newRole} 职能 Agent。`,
      allowWorkspaceReadWrite: true,
      allowShellExecution: newRole === "开发" || newRole === "测试验证",
      allowCheckpointCommit: newRole === "开发",
      systemPrompt: `你是负责【${newRole}】任务的 AI 助理。请严谨遵循代码规范与工程最佳实践。`,
    };
    setAgents((prev) => [...prev, newAgent]);
    setSelectedAgentId(newAgent.id);
    setShowAddModal(false);
    setNewName("");
    triggerSaveHint();
  };

  const handleDeleteAgent = (id: string) => {
    if (agents.length <= 1) return;
    const remaining = agents.filter((a) => a.id !== id);
    setAgents(remaining);
    setSelectedAgentId(remaining[0].id);
  };

  return (
    <div className="agent-manager-page">
      {/* Page Header */}
      <div className="page-header-row">
        <div>
          <h1>Agent 智能体管理</h1>
          <p className="page-subtitle">
            精细化配置各职能 Agent 的底层模型引擎、思维推演深度以及专属预设 Prompt。
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          {saveBanner && (
            <span className="agent-saved-pill">✓ 设置已自动保存</span>
          )}
          <button
            className="apple-btn-secondary"
            type="button"
            onClick={handleResetToDefaults}
          >
            恢复官方预设
          </button>
          <button
            className="apple-btn-primary"
            type="button"
            onClick={() => setShowAddModal(true)}
          >
            + 新增 Agent
          </button>
        </div>
      </div>

      {/* Main Grid: Left Roster List + Right Inspector Studio */}
      <div className="agent-studio-layout">
        {/* Left: Agent Cards Roster */}
        <div className="agent-roster-column">
          <div className="roster-header">
            <span>职能角色阵容 ({agents.length})</span>
          </div>

          <div className="roster-cards-list">
            {agents.map((agent) => {
              const isActive = agent.id === selected.id;
              return (
                <div
                  key={agent.id}
                  className={`agent-roster-card ${isActive ? "active" : ""}`}
                  onClick={() => setSelectedAgentId(agent.id)}
                >
                  <div className="roster-card-top">
                    <div className="roster-avatar">{agent.icon}</div>
                    <div className="roster-info">
                      <strong>{agent.name}</strong>
                      <span className="roster-role-tag">{agent.role}</span>
                    </div>
                  </div>

                  <div className="roster-card-meta">
                    <span className="meta-chip">🤖 {agent.model.split(" ")[0]}</span>
                    <span className="meta-chip">
                      {agent.reasoningLevel === "快速" && "⚡️ 快速"}
                      {agent.reasoningLevel === "标准" && "⚖️ 标准"}
                      {agent.reasoningLevel === "深度" && "🧠 深度"}
                      {agent.reasoningLevel === "极致思维" && "🚀 极致思维"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Inspector & Configuration Studio */}
        <div className="agent-inspector-column">
          {/* Identity & Header */}
          <div className="inspector-card">
            <div className="inspector-header-row">
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <span style={{ fontSize: "28px" }}>{selected.icon}</span>
                <div>
                  <input
                    className="agent-title-input"
                    value={selected.name}
                    onChange={(e) => updateSelectedAgent({ name: e.target.value })}
                  />
                  <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
                    {selected.description}
                  </p>
                </div>
              </div>

              {agents.length > 1 && (
                <button
                  className="apple-btn-danger"
                  type="button"
                  onClick={() => handleDeleteAgent(selected.id)}
                >
                  移除此 Agent
                </button>
              )}
            </div>
          </div>

          {/* Section 1: Model Engine Selection */}
          <div className="inspector-card">
            <div className="card-section-title">
              <span>底层模型引擎</span>
              <small>选择驱动该角色推演的底层大语言模型</small>
            </div>

            <div className="model-options-grid">
              {modelOptions.map((opt) => {
                const isSelected = selected.model === opt.id;
                return (
                  <div
                    key={opt.id}
                    className={`model-option-card ${isSelected ? "selected" : ""}`}
                    onClick={() => updateSelectedAgent({ model: opt.id })}
                  >
                    <div className="model-option-top">
                      <strong>{opt.id}</strong>
                      <span className="provider-tag">{opt.provider}</span>
                    </div>
                    <span className="model-badge">{opt.badge}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: Reasoning Intensity Controller */}
          <div className="inspector-card">
            <div className="card-section-title">
              <span>推理强度与思维链深度 (Reasoning Intensity)</span>
              <small>调节模型思考深度、Token 预算与推演轮次</small>
            </div>

            {/* Segmented Intensity Selector */}
            <div className="reasoning-segmented-bar">
              {(["快速", "标准", "深度", "极致思维"] as const).map((level) => {
                const isSelected = selected.reasoningLevel === level;
                return (
                  <button
                    key={level}
                    type="button"
                    className={`reasoning-segment-btn ${isSelected ? "active" : ""}`}
                    onClick={() => updateSelectedAgent({ reasoningLevel: level })}
                  >
                    {level === "快速" && "⚡️ 快速 (Low)"}
                    {level === "标准" && "⚖️ 标准 (Medium)"}
                    {level === "深度" && "🧠 深度 (High)"}
                    {level === "极致思维" && "🚀 极致思维 (Extreme)"}
                  </button>
                );
              })}
            </div>

            {/* Intensity Metric Box */}
            <div className="reasoning-metric-box">
              <div className="metric-col">
                <span className="metric-label">推演步数：</span>
                <strong className="metric-value">
                  {reasoningDescriptions[selected.reasoningLevel].steps}
                </strong>
              </div>
              <div className="metric-col">
                <span className="metric-label">Token 预算：</span>
                <strong className="metric-value">
                  {reasoningDescriptions[selected.reasoningLevel].token}
                </strong>
              </div>
              <p className="metric-desc">
                {reasoningDescriptions[selected.reasoningLevel].desc}
              </p>
            </div>
          </div>

          {/* Section 3: Preset Prompt Studio */}
          <div className="inspector-card">
            <div className="card-section-title">
              <span>预设系统提示词 (System Prompt Studio)</span>
              <small>定义该角色的行为准则、质量底线以及上下文规范</small>
            </div>

            {/* Quick Variable Chips */}
            <div className="prompt-variable-chips">
              <span className="var-label">插入动态变量：</span>
              <button
                type="button"
                className="var-chip"
                onClick={() => handleInsertVariable("task_title")}
              >
                + &#123;task_title&#125; (任务名)
              </button>
              <button
                type="button"
                className="var-chip"
                onClick={() => handleInsertVariable("acceptance_criteria")}
              >
                + &#123;acceptance_criteria&#125; (验收条件)
              </button>
              <button
                type="button"
                className="var-chip"
                onClick={() => handleInsertVariable("workspace_path")}
              >
                + &#123;workspace_path&#125; (工作区路径)
              </button>
              <button
                type="button"
                className="var-chip"
                onClick={() => handleInsertVariable("git_diff")}
              >
                + &#123;git_diff&#125; (代码差异)
              </button>
            </div>

            <textarea
              className="apple-prompt-editor"
              rows={9}
              value={selected.systemPrompt}
              onChange={(e) => updateSelectedAgent({ systemPrompt: e.target.value })}
              placeholder="编写系统角色指令与执行原则…"
            />
            <div className="prompt-footer-row">
              <span style={{ fontSize: "11px", color: "#86868b" }}>
                字符数：{selected.systemPrompt.length}
              </span>
              <span style={{ fontSize: "11px", color: "#24a159" }}>
                ✓ 修改即时写入本地不可变环境
              </span>
            </div>
          </div>

          {/* Section 4: Capabilities & Sandboxing */}
          <div className="inspector-card">
            <div className="card-section-title">
              <span>执行权限与沙箱控制 (Sandboxing)</span>
              <small>对本地隔离环境授予最小必要操作权限</small>
            </div>

            <div className="capabilities-list">
              <label className="cap-toggle-row">
                <div>
                  <strong>允许读取与写入工作区代码</strong>
                  <p>支持创建、编辑受控文件并验证语法</p>
                </div>
                <input
                  type="checkbox"
                  checked={selected.allowWorkspaceReadWrite}
                  onChange={(e) =>
                    updateSelectedAgent({ allowWorkspaceReadWrite: e.target.checked })
                  }
                />
              </label>

              <label className="cap-toggle-row">
                <div>
                  <strong>允许在独立隔离进程组中运行 Shell 命令</strong>
                  <p>执行构建命令、单元测试与静态扫描</p>
                </div>
                <input
                  type="checkbox"
                  checked={selected.allowShellExecution}
                  onChange={(e) =>
                    updateSelectedAgent({ allowShellExecution: e.target.checked })
                  }
                />
              </label>

              <label className="cap-toggle-row">
                <div>
                  <strong>允许自动提交 Git Checkpoint</strong>
                  <p>每轮代码迭代自动原子化保存快照与 Commit</p>
                </div>
                <input
                  type="checkbox"
                  checked={selected.allowCheckpointCommit}
                  onChange={(e) =>
                    updateSelectedAgent({ allowCheckpointCommit: e.target.checked })
                  }
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Add Custom Agent */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="apple-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>新增职能 Agent</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px" }}>
              创建专门针对特定研发环节的智能体角色。
            </p>

            <form onSubmit={handleAddAgent} className="modal-body-form" style={{ marginTop: "12px" }}>
              <label>
                Agent 名称
                <input
                  required
                  placeholder="例如：SQL 优化与审计 Agent"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <label>
                  职能角色 (Role)
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as AgentConfig["role"])}
                  >
                    <option value="开发">开发 (Developer)</option>
                    <option value="代码审查">代码审查 (Reviewer)</option>
                    <option value="测试验证">测试验证 (Tester)</option>
                    <option value="架构设计">架构设计 (Architect)</option>
                  </select>
                </label>

                <label>
                  模型引擎
                  <select
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                  >
                    <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet</option>
                    <option value="GPT-4o">GPT-4o</option>
                    <option value="DeepSeek-R1">DeepSeek-R1</option>
                    <option value="自动化环境 (Test Runner)">自动化环境 (Test Runner)</option>
                  </select>
                </label>
              </div>

              <label>
                推理强度
                <select
                  value={newReasoning}
                  onChange={(e) => setNewReasoning(e.target.value as AgentConfig["reasoningLevel"])}
                >
                  <option value="快速">快速 (Low)</option>
                  <option value="标准">标准 (Medium)</option>
                  <option value="深度">深度 (High)</option>
                  <option value="极致思维">极致思维 (Extreme)</option>
                </select>
              </label>

              <div className="modal-btn-row">
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowAddModal(false)}
                >
                  取消
                </button>
                <button
                  className="apple-btn-primary"
                  type="submit"
                >
                  添加并开始配置
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
