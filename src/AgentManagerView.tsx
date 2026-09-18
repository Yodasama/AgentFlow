import { useState, useEffect } from "react";

export interface AgentRoleConfig {
  id: string;
  roleName: string;
  icon: string;
  description: string;
  defaultModel: string;
  defaultReasoning: string;
  systemPrompt: string;
  isBuiltin?: boolean;
}

export const AGENT_ROLES_STORAGE_KEY = "agentflow_agent_roles_v3";

export const defaultAgentRoles: AgentRoleConfig[] = [
  {
    id: "role-dev",
    roleName: "开发编写",
    icon: "👨‍💻",
    description: "专注代码编写、重构与 Checkpoint 提交，遵循语言最佳实践。",
    defaultModel: "Claude 3.5 Sonnet",
    defaultReasoning: "深度",
    systemPrompt: `你是一名资深全栈工程师。你的职责是根据任务需求和架构设计，编写健壮、可测试、符合规范的代码。
- 遵循单一职责与开闭原则。
- 每次修改后保证代码可编译，不产生冗余废弃代码。
- 如遇逻辑或设计问题，及时在 Checkpoint 留痕记录。`,
    isBuiltin: true,
  },
  {
    id: "role-review",
    roleName: "代码审查",
    icon: "🔍",
    description: "专注代码静态检查、安全性审计与边界隐患审查，提出阻断级和警告级意见。",
    defaultModel: "Claude 3.5 Sonnet",
    defaultReasoning: "极致思维",
    systemPrompt: `你是一名严谨的安全与架构代码审查员。
- 重点审查潜在的空指针、并发竞争、内存泄露、外部输入校验缺失。
- 对未覆盖边界或测试不足的代码提出明确修改建议。
- 审查结果按 blocking（阻断）、warning（提示）分级输出，只有无阻塞项时才准予合并。`,
    isBuiltin: true,
  },
  {
    id: "role-test",
    roleName: "测试验证",
    icon: "🧪",
    description: "负责单元测试、集成测试驱动以及回归验证，捕获代码异常并生成测试报告。",
    defaultModel: "自动化环境 (Test Runner)",
    defaultReasoning: "标准",
    systemPrompt: `负责运行自动化测试用例，捕获测试失败的堆栈信息。
- 分析测试失败的具体函数与行号。
- 输出结构化的测试报告，区分环境错误与代码逻辑断言失败。`,
    isBuiltin: true,
  },
  {
    id: "role-arch",
    roleName: "需求拆解",
    icon: "📐",
    description: "分析复合型大需求，产出清晰的模块切分、领域模型与依赖关系。",
    defaultModel: "GPT-4o",
    defaultReasoning: "深度",
    systemPrompt: `你是一名系统架构师。负责把模糊需求分解为清晰的阶段节点。
- 输出接口签名、数据契约与调用时序。
- 确保模块间低耦合高内聚，为后续开发节点提供明确的输入约束。`,
    isBuiltin: true,
  },
  {
    id: "role-approval",
    roleName: "人工决策",
    icon: "🛡️",
    description: "质量准入把关，校验 Checkpoint Diff 与回归证据，准予合并交付。",
    defaultModel: "人工确认 (Human In Loop)",
    defaultReasoning: "最高",
    systemPrompt: `人工质量终审节点，基于审查意见与测试证据作出交付准入决定。`,
    isBuiltin: true,
  },
];

export function loadAgentRoles(): AgentRoleConfig[] {
  try {
    const saved = localStorage.getItem(AGENT_ROLES_STORAGE_KEY);
    return saved ? JSON.parse(saved) : defaultAgentRoles;
  } catch {
    return defaultAgentRoles;
  }
}

export function AgentManagerView() {
  const [roles, setRoles] = useState<AgentRoleConfig[]>(loadAgentRoles);
  const [selectedRoleId, setSelectedRoleId] = useState<string>(roles[0]?.id || "role-dev");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // New Role Form State
  const [newRoleName, setNewRoleName] = useState("");
  const [newIcon, setNewIcon] = useState("⚡️");
  const [newDesc, setNewDesc] = useState("");
  const [newModel, setNewModel] = useState("Claude 3.5 Sonnet");
  const [newReasoning, setNewReasoning] = useState("深度");
  const [newPrompt, setNewPrompt] = useState("");

  const selected = roles.find((r) => r.id === selectedRoleId) || roles[0];

  useEffect(() => {
    localStorage.setItem(AGENT_ROLES_STORAGE_KEY, JSON.stringify(roles));
  }, [roles]);

  const triggerSaveNotification = () => {
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 1500);
  };

  const updateSelectedRole = (patch: Partial<AgentRoleConfig>) => {
    setRoles((prev) =>
      prev.map((r) => (r.id === selected.id ? { ...r, ...patch } : r))
    );
    triggerSaveNotification();
  };

  const handleResetDefaults = () => {
    setRoles(defaultAgentRoles);
    setSelectedRoleId(defaultAgentRoles[0].id);
    localStorage.setItem(AGENT_ROLES_STORAGE_KEY, JSON.stringify(defaultAgentRoles));
    triggerSaveNotification();
  };

  const handleAddRole = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    const newRoleItem: AgentRoleConfig = {
      id: `custom-role-${Date.now()}`,
      roleName: newRoleName.trim(),
      icon: newIcon.trim() || "🤖",
      description: newDesc.trim() || "自定义业务角色。",
      defaultModel: newModel,
      defaultReasoning: newReasoning,
      systemPrompt:
        newPrompt.trim() ||
        `你是专职负责【${newRoleName.trim()}】任务的 AI 助手。请严谨遵循代码规范与工程最佳实践。`,
      isBuiltin: false,
    };
    setRoles((prev) => [...prev, newRoleItem]);
    setSelectedRoleId(newRoleItem.id);
    setShowAddModal(false);
    setNewRoleName("");
    setNewDesc("");
    setNewPrompt("");
    triggerSaveNotification();
  };

  const handleDeleteRole = (id: string) => {
    if (roles.length <= 1) return;
    const remaining = roles.filter((r) => r.id !== id);
    setRoles(remaining);
    setSelectedRoleId(remaining[0].id);
  };

  return (
    <div className="agent-manager-page compact">
      {/* Compact Page Header */}
      <div className="page-header-row" style={{ marginBottom: "16px" }}>
        <div>
          <h1 style={{ fontSize: "22px" }}>Agent 角色库</h1>
          <p className="page-subtitle" style={{ fontSize: "12px" }}>
            管理工作流中可担任的功能角色与预设 Prompt 指令。在任务画布添加节点时直接选用，具体参数与提示词调试在任务中进行。
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {saveSuccess && (
            <span className="agent-saved-pill" style={{ fontSize: "10px", padding: "2px 8px" }}>
              ✓ 已自动保存
            </span>
          )}
          <button
            className="apple-btn-secondary"
            type="button"
            style={{ fontSize: "12px", padding: "5px 10px" }}
            onClick={handleResetDefaults}
          >
            恢复官方预设
          </button>
          <button
            className="apple-btn-primary"
            type="button"
            style={{ fontSize: "12px", padding: "5px 12px" }}
            onClick={() => setShowAddModal(true)}
          >
            + 新增角色
          </button>
        </div>
      </div>

      {/* Compact Split Studio Layout (Fits on One Page) */}
      <div className="agent-studio-layout compact-layout">
        {/* Left: Compact Role List */}
        <div className="agent-roster-column compact-list">
          <div className="roster-header">
            <span>预设功能角色 ({roles.length})</span>
          </div>

          <div className="roster-cards-list">
            {roles.map((role) => {
              const isActive = role.id === selected.id;
              return (
                <div
                  key={role.id}
                  className={`agent-roster-card compact-card ${isActive ? "active" : ""}`}
                  onClick={() => setSelectedRoleId(role.id)}
                >
                  <div className="roster-card-top" style={{ gap: "8px" }}>
                    <span style={{ fontSize: "18px" }}>{role.icon}</span>
                    <div className="roster-info" style={{ flex: 1 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong style={{ fontSize: "13px" }}>{role.roleName}</strong>
                        <span className="roster-role-tag" style={{ fontSize: "10px" }}>
                          {role.isBuiltin ? "内置" : "自定义"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: "4px", marginTop: "3px" }}>
                        <span className="meta-chip" style={{ fontSize: "9px", padding: "1px 5px" }}>
                          🤖 {role.defaultModel.split(" ")[0]}
                        </span>
                        <span className="meta-chip" style={{ fontSize: "9px", padding: "1px 5px" }}>
                          🧠 {role.defaultReasoning}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Consolidated Role Inspector (Single cohesive card) */}
        <div className="agent-inspector-column compact-inspector">
          <div className="inspector-card compact-editor-card">
            {/* Header: Icon + Name + Desc + Delete */}
            <div className="inspector-header-row" style={{ paddingBottom: "12px", borderBottom: "1px solid #f0f0f2" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
                <span style={{ fontSize: "28px" }}>{selected.icon}</span>
                <div style={{ flex: 1 }}>
                  <input
                    className="agent-title-input"
                    style={{ fontSize: "18px", fontWeight: 600, padding: "2px 0" }}
                    value={selected.roleName}
                    onChange={(e) => updateSelectedRole({ roleName: e.target.value })}
                  />
                  <input
                    style={{
                      border: 0,
                      fontSize: "13px",
                      color: "#86868b",
                      marginTop: "3px",
                      width: "95%",
                      outline: "none",
                      background: "transparent",
                    }}
                    value={selected.description}
                    onChange={(e) => updateSelectedRole({ description: e.target.value })}
                    placeholder="角色职责描述…"
                  />
                </div>
              </div>

              {!selected.isBuiltin && roles.length > 1 && (
                <button
                  className="apple-btn-danger"
                  type="button"
                  style={{ fontSize: "12px", padding: "5px 10px" }}
                  onClick={() => handleDeleteRole(selected.id)}
                >
                  删除角色
                </button>
              )}
            </div>

            {/* Middle: Recommended Engine & Reasoning Level */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", margin: "14px 0" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "13px", color: "#1d1d1f", fontWeight: 500 }}>
                推荐模型引擎 (画布添加节点时默认选用)
                <select
                  value={selected.defaultModel}
                  onChange={(e) => updateSelectedRole({ defaultModel: e.target.value })}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: "1px solid #e5e5ea",
                    background: "#ffffff",
                    fontSize: "13px",
                    color: "#1d1d1f",
                  }}
                >
                  <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet (长上下文与架构)</option>
                  <option value="GPT-4o">GPT-4o (逻辑与拆解)</option>
                  <option value="DeepSeek-R1">DeepSeek-R1 (深度思维链)</option>
                  <option value="自动化环境 (Test Runner)">自动化环境 (Test Runner)</option>
                  <option value="人工确认 (Human In Loop)">人工确认 (Human In Loop)</option>
                </select>
              </label>

              <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: "13px", color: "#1d1d1f", fontWeight: 500 }}>
                推荐推理深度
                <select
                  value={selected.defaultReasoning}
                  onChange={(e) => updateSelectedRole({ defaultReasoning: e.target.value })}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "8px",
                    border: "1px solid #e5e5ea",
                    background: "#ffffff",
                    fontSize: "13px",
                    color: "#1d1d1f",
                  }}
                >
                  <option value="快速">快速 (Low · 1~2 步快速响应)</option>
                  <option value="标准">标准 (Medium · 4~8 步平衡思考)</option>
                  <option value="深度">深度 (High · 16~32 步多轮推演)</option>
                  <option value="极致思维">极致思维 (Extreme · 全量思维链)</option>
                  <option value="最高">最高 (Human · 人工严谨审核)</option>
                </select>
              </label>
            </div>

            {/* Bottom: Role System Prompt Studio */}
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#1d1d1f" }}>
                  角色专属预设 Prompt 指令
                </span>
                <span style={{ fontSize: "12px", color: "#86868b" }}>
                  字符数：{selected.systemPrompt.length}
                </span>
              </div>

              <textarea
                className="apple-prompt-editor"
                rows={9}
                style={{ fontSize: "13px", lineHeight: "1.6", padding: "12px", minHeight: "190px" }}
                value={selected.systemPrompt}
                onChange={(e) => updateSelectedRole({ systemPrompt: e.target.value })}
                placeholder="编写该功能角色的系统指令与原则…"
              />

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "3px" }}>
                <span style={{ fontSize: "12px", color: "#86868b" }}>
                  提示：可在任务内随时针对具体执行目标进行微调。
                </span>
                <span style={{ fontSize: "12px", color: "#24a159" }}>
                  ✓ 修改已自动同步
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Add Custom Role */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="apple-modal-card" style={{ width: "460px" }} onClick={(e) => e.stopPropagation()}>
            <h3>新增功能角色</h3>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
              创建专属的功能担任角色，设置角色定位与预设 Prompt。
            </p>

            <form onSubmit={handleAddRole} className="modal-body-form" style={{ marginTop: "10px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "50px 1fr", gap: "8px" }}>
                <label>
                  图标
                  <input
                    value={newIcon}
                    onChange={(e) => setNewIcon(e.target.value)}
                    style={{ textAlign: "center" }}
                  />
                </label>
                <label>
                  角色名称
                  <input
                    required
                    placeholder="例如：安全巡检、性能调优"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                  />
                </label>
              </div>

              <label>
                角色定位与职责说明
                <input
                  required
                  placeholder="例如：负责排查代码漏洞与并发性能隐患"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <label>
                  推荐模型引擎
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

                <label>
                  推荐推理深度
                  <select
                    value={newReasoning}
                    onChange={(e) => setNewReasoning(e.target.value)}
                  >
                    <option value="快速">快速 (Low)</option>
                    <option value="标准">标准 (Medium)</option>
                    <option value="深度">深度 (High)</option>
                    <option value="极致思维">极致思维 (Extreme)</option>
                  </select>
                </label>
              </div>

              <label>
                预设 Prompt 指令
                <textarea
                  rows={3}
                  placeholder="定义该角色执行时的系统指令准则…"
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
                <button
                  className="apple-btn-primary"
                  type="submit"
                >
                  保存并加入角色库
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
