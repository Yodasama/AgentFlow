import { useState, useEffect } from "react";
import {
  IconCode,
  IconSearch,
  IconFlask,
  IconRuler,
  IconShield,
  IconZap,
  IconCheck,
} from "./icons";
import { DrawerSelect } from "./DrawerSelect";
import { confirmDelete } from "./confirmDelete";
import { fetchExternalUrl } from "./api";
import {
  type Skill,
  getStoredSkills,
  toggleSkill,
  addSkill,
  updateSkill,
  deleteSkill,
  clearAllSkills,
  parseSkillFromContent,
} from "./skills";


export interface AgentRoleConfig {
  id: string;
  roleName: string;
  icon: string;
  description: string;
  systemPrompt: string;
  isBuiltin?: boolean;
}

export function RoleIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  if (icon === "code" || icon === "👨‍💻") return <IconCode size={size} />;
  if (icon === "search" || icon === "🔍") return <IconSearch size={size} />;
  if (icon === "test" || icon === "🧪") return <IconFlask size={size} />;
  if (icon === "ruler" || icon === "📐") return <IconRuler size={size} />;
  if (icon === "shield" || icon === "🛡️") return <IconShield size={size} />;
  return <IconZap size={size} />;
}

export const AGENT_ROLES_STORAGE_KEY = "agentflow_agent_roles_v6_pure_cli";

export const defaultAgentRoles: AgentRoleConfig[] = [
  {
    id: "role-dev",
    roleName: "开发编写",
    icon: "code",
    description: "专注代码编写、重构与 Checkpoint 提交，遵循语言最佳实践。",
    systemPrompt: `你是一名资深全栈工程师。你的职责是根据任务需求和架构设计，编写健壮、可测试、符合规范的代码。
- 遵循单一职责与开闭原则。
- 每次修改后保证代码可编译，不产生冗余废弃代码。
- 如遇逻辑或设计问题，及时在 Checkpoint 留痕记录。`,
    isBuiltin: true,
  },
  {
    id: "role-review",
    roleName: "代码审查",
    icon: "search",
    description: "专注代码静态检查、安全性审计与边界隐患审查，提出阻断级和警告级意见。",
    systemPrompt: `你是一名严谨的安全与架构代码审查员。
- 重点审查潜在的空指针、并发竞争、内存泄露、外部输入校验缺失。
- 对未覆盖边界或测试不足的代码提出明确修改建议。
- 审查结果按 blocking（阻断）、warning（提示）分级输出，只有无阻塞项时才准予合并。`,
    isBuiltin: true,
  },
  {
    id: "role-test",
    roleName: "测试验证",
    icon: "test",
    description: "负责单元测试、集成测试驱动以及回归验证，捕获代码异常并生成测试报告。",
    systemPrompt: `负责运行自动化测试用例，捕获测试失败的堆栈信息。
- 分析测试失败的具体函数与行号。
- 输出结构化的测试报告，区分环境错误与代码逻辑断言失败。`,
    isBuiltin: true,
  },
  {
    id: "role-arch",
    roleName: "需求拆解",
    icon: "ruler",
    description: "分析复合型大需求，产出清晰的模块切分、领域模型与依赖关系。",
    systemPrompt: `你是一名系统架构师。负责把模糊需求分解为清晰的阶段节点。
- 输出接口签名、数据契约与调用时序。
- 确保模块间低耦合高内聚，为后续开发节点提供明确的输入约束。`,
    isBuiltin: true,
  },
  {
    id: "role-approval",
    roleName: "人工决策",
    icon: "shield",
    description: "质量准入把关，校验 Checkpoint Diff 与回归证据，准予合并交付。",
    systemPrompt: `人工质量终审节点，基于审查意见与测试证据作出交付准入决定。`,
    isBuiltin: true,
  },
];

export function loadAgentRoles(): AgentRoleConfig[] {
  try {
    const saved = localStorage.getItem(AGENT_ROLES_STORAGE_KEY);
    if (!saved) return defaultAgentRoles;
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultAgentRoles;
    return parsed.map((r: AgentRoleConfig & { defaultModel?: string; defaultReasoning?: string }) => {
      const role = { ...r };
      delete role.defaultModel;
      delete role.defaultReasoning;
      return role;
    });
  } catch {
    return defaultAgentRoles;
  }
}

export function AgentManagerView() {
  const [viewTab, setViewTab] = useState<"roles" | "skills">("roles");

  // Roles state
  const [roles, setRoles] = useState<AgentRoleConfig[]>(loadAgentRoles);
  const [selectedRoleId, setSelectedRoleId] = useState<string>(roles[0]?.id || "role-dev");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // New Role Form State
  const [newRoleName, setNewRoleName] = useState("");
  const [newIcon, setNewIcon] = useState("zap");
  const [newDesc, setNewDesc] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  // Skills state
  const [skills, setSkills] = useState<Skill[]>(getStoredSkills);
  const [skillCategory, setSkillCategory] = useState<string>("全部");
  const [showSkillModal, setShowSkillModal] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);

  // Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importTab, setImportTab] = useState<"url" | "file">("url");
  const [importUrl, setImportUrl] = useState("");
  const [importText, setImportText] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewSkill, setPreviewSkill] = useState<Omit<Skill, "id" | "updatedAt"> | null>(null);

  // Skill Form State
  const [skillName, setSkillName] = useState("");
  const [skillCategoryVal, setSkillCategoryVal] = useState<Skill["category"]>("工程规范");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillEnabled, setSkillEnabled] = useState(true);

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
      id: `role-${Date.now()}`,
      roleName: newRoleName.trim(),
      icon: newIcon.trim() || "zap",
      description: newDesc.trim() || "通用功能角色",
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
    const role = roles.find((item) => item.id === id);
    if (!confirmDelete(`角色“${role?.roleName || "未命名"}”`)) return;
    const remaining = roles.filter((r) => r.id !== id);
    setRoles(remaining);
    setSelectedRoleId(remaining[0].id);
  };

  // Skill Handlers
  const handleToggleSkill = (id: string) => {
    const updated = toggleSkill(id);
    setSkills(updated);
    triggerSaveNotification();
  };

  const handleOpenAddSkill = () => {
    setEditingSkill(null);
    setSkillName("");
    setSkillCategoryVal("工程规范");
    setSkillDesc("");
    setSkillInstructions("");
    setSkillEnabled(true);
    setShowSkillModal(true);
  };

  const handleOpenEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setSkillName(skill.name);
    setSkillCategoryVal(skill.category);
    setSkillDesc(skill.description);
    setSkillInstructions(skill.instructions);
    setSkillEnabled(skill.enabled);
    setShowSkillModal(true);
  };

  const handleSaveSkill = (e: React.FormEvent) => {
    e.preventDefault();
    if (!skillName.trim() || !skillInstructions.trim()) return;

    if (editingSkill) {
      const updated = updateSkill(editingSkill.id, {
        name: skillName.trim(),
        category: skillCategoryVal,
        description: skillDesc.trim(),
        instructions: skillInstructions.trim(),
        enabled: skillEnabled,
      });
      setSkills(updated);
    } else {
      addSkill({
        name: skillName.trim(),
        category: skillCategoryVal,
        description: skillDesc.trim() || "共享 Agent 行为准则与领域技能",
        instructions: skillInstructions.trim(),
        enabled: skillEnabled,
      });
      setSkills(getStoredSkills());
    }

    setShowSkillModal(false);
    triggerSaveNotification();
  };

  const handleDeleteSkill = (id: string) => {
    const skill = skills.find((s) => s.id === id);
    if (!confirmDelete(`技能“${skill?.name || "未命名"}”`)) return;
    const updated = deleteSkill(id);
    setSkills(updated);
    triggerSaveNotification();
  };

  const handleClearAllSkills = () => {
    if (!confirmDelete("所有共享技能")) return;
    const updated = clearAllSkills();
    setSkills(updated);
    triggerSaveNotification();
  };

  const handleFetchUrl = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!importUrl.trim()) return;
    setIsImporting(true);
    setImportError(null);
    setPreviewSkill(null);
    try {
      const raw = await fetchExternalUrl(importUrl.trim());
      const parsed = parseSkillFromContent(raw, undefined, importUrl.trim());
      setPreviewSkill(parsed);
    } catch (err: any) {
      setImportError(typeof err === "string" ? err : err?.message || "下载技能失败，请检查 URL 是否有效");
    } finally {
      setIsImporting(false);
    }
  };

  const handleParseText = () => {
    if (!importText.trim()) return;
    setImportError(null);
    try {
      const parsed = parseSkillFromContent(importText.trim());
      setPreviewSkill(parsed);
    } catch {
      setImportError("解析内容失败，请确保格式正确");
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setImportText(content);
        const parsed = parseSkillFromContent(content, file.name.replace(/\.[^/.]+$/, ""));
        setPreviewSkill(parsed);
      }
    };
    reader.readAsText(file);
  };

  const handleConfirmImport = () => {
    if (!previewSkill) return;
    addSkill(previewSkill);
    setSkills(getStoredSkills());
    setShowImportModal(false);
    setPreviewSkill(null);
    setImportUrl("");
    setImportText("");
    triggerSaveNotification();
  };


  const filteredSkills = skills.filter((s) => {
    if (skillCategory === "全部") return true;
    return s.category === skillCategory;
  });

  const activeSkillsCount = skills.filter((s) => s.enabled).length;

  return (
    <div className="agent-manager-page compact">
      {/* Top Module Switcher Tabs */}
      <div className="agent-tabs-header">
        <button
          className={`agent-tab-btn ${viewTab === "roles" ? "active" : ""}`}
          type="button"
          onClick={() => setViewTab("roles")}
        >
          <RoleIcon icon="zap" size={15} />
          <span>Agent 角色库 ({roles.length})</span>
        </button>
        <button
          className={`agent-tab-btn ${viewTab === "skills" ? "active" : ""}`}
          type="button"
          onClick={() => setViewTab("skills")}
        >
          <span style={{ fontSize: "14px" }}>⚡</span>
          <span>共享技能库 (Skills)</span>
          <span
            style={{
              fontSize: "10px",
              background: "#f0f7ff",
              color: "#0071e3",
              padding: "1px 7px",
              borderRadius: "10px",
              fontWeight: 600,
              border: "1px solid #d0e7ff",
            }}
          >
            {activeSkillsCount} 已启用
          </span>
        </button>
      </div>

      {/* =========================================================================
          TAB 1: ROLES MANAGEMENT
          ========================================================================= */}
      {viewTab === "roles" && (
        <>
          {/* Compact Page Header */}
          <div className="page-header-row" style={{ marginBottom: "16px" }}>
            <div>
              <h1 style={{ fontSize: "22px" }}>Agent 角色库</h1>
              <p className="page-subtitle" style={{ fontSize: "12px" }}>管理功能角色的职责定位与系统预设 Prompt。</p>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {saveSuccess && (
                <span className="agent-saved-pill" style={{ fontSize: "10px", padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <IconCheck size={11} />
                  <span>已自动保存</span>
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

          {/* Compact Split Studio Layout */}
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
                        <span style={{ display: "inline-flex", alignItems: "center" }}>
                          <RoleIcon icon={role.icon} size={16} />
                        </span>
                        <div className="roster-info" style={{ flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <strong style={{ fontSize: "13px" }}>{role.roleName}</strong>
                            <span className="roster-role-tag" style={{ fontSize: "10px" }}>
                              {role.isBuiltin ? "内置" : "自定义"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Consolidated Role Inspector */}
            <div className="agent-inspector-column compact-inspector">
              <div className="inspector-card compact-editor-card">
                {/* Header: Icon + Name + Desc + Delete */}
                <div className="inspector-header-row" style={{ paddingBottom: "12px", borderBottom: "1px solid #f0f0f2" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
                    <span style={{ display: "inline-flex", alignItems: "center" }}>
                      <RoleIcon icon={selected.icon} size={22} />
                    </span>
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

                {/* Bottom: Role System Prompt Studio */}
                <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "14px" }}>
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
                    <span style={{ fontSize: "12px", color: "#346538", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                      <IconCheck size={12} />
                      <span>修改已自动同步</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* =========================================================================
          TAB 2: SHARED SKILLS MANAGEMENT
          ========================================================================= */}
      {viewTab === "skills" && (
        <div className="skills-container">
          {/* Header row */}
          <div className="page-header-row">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <h1 style={{ fontSize: "22px", margin: 0 }}>共享技能库 (Shared Skills)</h1>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#0071e3",
                    background: "#f0f7ff",
                    border: "1px solid #d0e7ff",
                    padding: "2px 8px",
                    borderRadius: "12px",
                  }}
                >
                  ⚡ 全局生效中：{activeSkillsCount} 项
                </span>
              </div>
              <p className="page-subtitle" style={{ fontSize: "12px", marginTop: "4px" }}>
                已启用的技能将作为全局领域规范，自动注入并共享给所有 Agent（包含 Google agy 各账号、OpenAI Codex CLI 与定时任务）。
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {saveSuccess && (
                <span className="agent-saved-pill" style={{ fontSize: "10px", padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <IconCheck size={11} />
                  <span>技能已更新</span>
                </span>
              )}
              {skills.length > 0 && (
                <button
                  className="apple-btn-danger-outline"
                  type="button"
                  style={{ fontSize: "12px", padding: "5px 10px" }}
                  onClick={handleClearAllSkills}
                >
                  清空技能库
                </button>
              )}
              <button
                className="apple-btn-secondary"
                type="button"
                style={{ fontSize: "12px", padding: "5px 12px" }}
                onClick={handleOpenAddSkill}
              >
                + 手动新建
              </button>
              <button
                className="apple-btn-primary"
                type="button"
                style={{ fontSize: "12px", padding: "5px 12px" }}
                onClick={() => {
                  setShowImportModal(true);
                  setPreviewSkill(null);
                  setImportError(null);
                }}
              >
                📥 下载 / 导入技能
              </button>
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="skills-empty-state">
              <div className="skills-empty-icon">⚡</div>
              <h3>暂无共享技能</h3>
              <p>
                共享技能可以为所有 Agent 提供统一的领域规范与执行指令。
                系统不预设任何死板技能，你可以直接从外部 URL（如 GitHub Raw / Gist 中的 SKILL.md）一键下载导入，或导入本地技能文件。
              </p>
              <div className="skills-empty-actions">
                <button
                  type="button"
                  className="apple-btn-primary"
                  onClick={() => {
                    setImportTab("url");
                    setShowImportModal(true);
                    setPreviewSkill(null);
                    setImportError(null);
                  }}
                >
                  📥 从外部 URL 下载技能
                </button>
                <button
                  type="button"
                  className="apple-btn-secondary"
                  onClick={() => {
                    setImportTab("file");
                    setShowImportModal(true);
                    setPreviewSkill(null);
                    setImportError(null);
                  }}
                >
                  📄 导入本地文件 / 粘贴内容
                </button>
                <button
                  type="button"
                  className="apple-btn-secondary"
                  onClick={handleOpenAddSkill}
                >
                  + 手动新建技能
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Category Filter Bar */}
              <div className="skills-filter-bar">
                {["全部", "前端设计", "工程规范", "内容创作", "安全审计", "自动化运维", "其他"].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`skills-filter-pill ${skillCategory === cat ? "active" : ""}`}
                    onClick={() => setSkillCategory(cat)}
                  >
                    {cat} {cat === "全部" ? `(${skills.length})` : `(${skills.filter((s) => s.category === cat).length})`}
                  </button>
                ))}
              </div>

              {/* Skills Cards Grid */}
              <div className="skills-grid">
                {filteredSkills.map((skill) => (
                  <div key={skill.id} className={`skill-card ${skill.enabled ? "enabled" : ""}`}>
                    {/* Card Top: Category badge + Apple Switch */}
                    <div className="skill-card-header">
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <span className={`skill-category-badge ${skill.category}`}>
                          {skill.category}
                        </span>
                        {skill.sourceUrl && (
                          <span className="skill-source-badge" title={skill.sourceUrl}>
                            🔗 外部下载
                          </span>
                        )}
                      </div>
                      <label className="apple-switch" title={skill.enabled ? "点击停用" : "点击启用并共享给所有 Agent"}>
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={() => handleToggleSkill(skill.id)}
                        />
                        <span className="apple-switch-slider" />
                      </label>
                    </div>

                    {/* Card Title & Desc */}
                    <div>
                      <div className="skill-card-title">{skill.name}</div>
                      <p className="skill-card-desc">{skill.description}</p>
                    </div>

                    {/* Instructions preview */}
                    <div className="skill-instructions-box" title="执行时将作为上下文注入给所有 Agent">
                      {skill.instructions}
                    </div>

                    {/* Card Footer: Tag + Actions */}
                    <div className="skill-card-footer">
                      <span>{skill.sourceUrl ? "外部导入" : "自定义技能"}</span>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button
                          type="button"
                          className="apple-btn-secondary"
                          style={{ fontSize: "11px", padding: "2px 8px" }}
                          onClick={() => handleOpenEditSkill(skill)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="apple-btn-danger-outline"
                          style={{ fontSize: "11px", padding: "2px 8px" }}
                          onClick={() => handleDeleteSkill(skill.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* =========================================================================
          MODAL: ADD ROLE
          ========================================================================= */}
      {showAddModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddModal(false)}>
          <div className="apple-modal-card" style={{ width: "460px" }} onClick={(e) => e.stopPropagation()}>
            <h3>新增功能角色</h3>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
              创建专属的功能担任角色，设置角色定位与预设 Prompt。
            </p>

            <form onSubmit={handleAddRole} className="modal-body-form" style={{ marginTop: "10px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "10px" }}>
                <label>
                  <span>图标类型</span>
                  <DrawerSelect
                    value={newIcon}
                    onChange={(val) => setNewIcon(val)}
                    options={[
                      { value: "code", label: "代码", description: "开发与编写", icon: <RoleIcon icon="code" size={14} /> },
                      { value: "search", label: "审查", description: "安全与规范审计", icon: <RoleIcon icon="search" size={14} /> },
                      { value: "test", label: "测试", description: "测试与回归套件", icon: <RoleIcon icon="test" size={14} /> },
                      { value: "ruler", label: "架构", description: "蓝图与任务分解", icon: <RoleIcon icon="ruler" size={14} /> },
                      { value: "shield", label: "安全", description: "边界防护与防御", icon: <RoleIcon icon="shield" size={14} /> },
                      { value: "zap", label: "通用", description: "轻量快速执行", icon: <RoleIcon icon="zap" size={14} /> },
                    ]}
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

      {/* =========================================================================
          MODAL: IMPORT / DOWNLOAD SKILL
          ========================================================================= */}
      {showImportModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowImportModal(false)}>
          <div className="apple-modal-card" style={{ width: "560px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>下载 / 导入外部技能</h3>
              <button
                type="button"
                className="apple-btn-secondary"
                style={{ border: 0, padding: "4px 8px", fontSize: "14px", cursor: "pointer" }}
                onClick={() => setShowImportModal(false)}
              >
                ✕
              </button>
            </div>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "4px", marginBottom: "12px" }}>
              从外部链接或本地文件导入技能规范（支持标准 SKILL.md、YAML Frontmatter 与 JSON）。
            </p>

            {/* Import Tabs */}
            <div className="skill-import-tabs">
              <button
                type="button"
                className={`skill-import-tab-btn ${importTab === "url" ? "active" : ""}`}
                onClick={() => {
                  setImportTab("url");
                  setImportError(null);
                }}
              >
                🌐 从外部 URL 下载
              </button>
              <button
                type="button"
                className={`skill-import-tab-btn ${importTab === "file" ? "active" : ""}`}
                onClick={() => {
                  setImportTab("file");
                  setImportError(null);
                }}
              >
                📄 本地文件 / 粘贴内容
              </button>
            </div>

            {/* TAB 1: FROM URL */}
            {importTab === "url" && (
              <form onSubmit={handleFetchUrl} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", fontWeight: 500 }}>
                  <span>技能文件链接 (支持 GitHub Raw / Gist / 任意 HTTP 链接)</span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="url"
                      required
                      placeholder="https://raw.githubusercontent.com/.../SKILL.md"
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="submit"
                      disabled={isImporting || !importUrl.trim()}
                      className="apple-btn-primary"
                      style={{ padding: "6px 14px", flexShrink: 0 }}
                    >
                      {isImporting ? "下载中…" : "下载并解析"}
                    </button>
                  </div>
                </label>
              </form>
            )}

            {/* TAB 2: FROM FILE / TEXT */}
            {importTab === "file" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <label className="apple-btn-secondary" style={{ cursor: "pointer", fontSize: "12px", padding: "6px 12px" }}>
                    📁 选择本地 SKILL.md 文件
                    <input
                      type="file"
                      accept=".md,.json,.txt"
                      style={{ display: "none" }}
                      onChange={handleFileUpload}
                    />
                  </label>
                  <span style={{ fontSize: "12px", color: "#86868b" }}>或直接在下方粘贴 Markdown / JSON 内容</span>
                </div>

                <textarea
                  rows={5}
                  placeholder="在此粘贴包含 --- name: ... --- 的 SKILL.md 或 JSON 内容…"
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  style={{ fontFamily: "var(--apple-font-mono, monospace)", fontSize: "12px", resize: "vertical" }}
                />

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="apple-btn-secondary"
                    disabled={!importText.trim()}
                    onClick={handleParseText}
                    style={{ fontSize: "12px", padding: "5px 12px" }}
                  >
                    解析文本内容
                  </button>
                </div>
              </div>
            )}

            {/* Error banner */}
            {importError && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "8px 12px", borderRadius: "6px", fontSize: "12px", marginTop: "10px" }}>
                ⚠️ {importError}
              </div>
            )}

            {/* Preview Box */}
            {previewSkill && (
              <div className="skill-preview-box">
                <div className="skill-preview-title">✓ 解析成功预览</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: "10px", marginBottom: "8px" }}>
                  <label style={{ fontSize: "12px" }}>
                    <span style={{ color: "#64748b" }}>技能名称:</span>
                    <input
                      value={previewSkill.name}
                      onChange={(e) => setPreviewSkill({ ...previewSkill, name: e.target.value })}
                      style={{ width: "100%", marginTop: "2px", fontWeight: 600 }}
                    />
                  </label>
                  <label style={{ fontSize: "12px" }}>
                    <span style={{ color: "#64748b" }}>分类:</span>
                    <select
                      value={previewSkill.category}
                      onChange={(e) => setPreviewSkill({ ...previewSkill, category: e.target.value as any })}
                      style={{ width: "100%", marginTop: "2px" }}
                    >
                      <option value="前端设计">前端设计</option>
                      <option value="工程规范">工程规范</option>
                      <option value="内容创作">内容创作</option>
                      <option value="安全审计">安全审计</option>
                      <option value="自动化运维">自动化运维</option>
                      <option value="其他">其他</option>
                    </select>
                  </label>
                </div>

                <label style={{ fontSize: "12px", display: "block", marginBottom: "8px" }}>
                  <span style={{ color: "#64748b" }}>描述:</span>
                  <input
                    value={previewSkill.description}
                    onChange={(e) => setPreviewSkill({ ...previewSkill, description: e.target.value })}
                    style={{ width: "100%", marginTop: "2px" }}
                  />
                </label>

                <div style={{ fontSize: "11px", color: "#64748b", marginBottom: "4px" }}>
                  指令规范预览 ({previewSkill.instructions.length} 字符):
                </div>
                <div className="skill-instructions-box" style={{ maxHeight: "90px" }}>
                  {previewSkill.instructions}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "12px" }}>
                  <button
                    type="button"
                    className="apple-btn-secondary"
                    onClick={() => setPreviewSkill(null)}
                  >
                    重置
                  </button>
                  <button
                    type="button"
                    className="apple-btn-primary"
                    onClick={handleConfirmImport}
                  >
                    确认导入技能并共享
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          MODAL: ADD / EDIT SKILL
          ========================================================================= */}
      {showSkillModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowSkillModal(false)}>
          <div className="apple-modal-card" style={{ width: "520px" }} onClick={(e) => e.stopPropagation()}>
            <h3>{editingSkill ? "编辑共享技能" : "新增共享技能"}</h3>
            <p style={{ fontSize: "12px", color: "#86868b", marginTop: "2px" }}>
              技能将以标准 Prompt 指令格式，自动注入并共享给所有执行的 Agent 与定时任务。
            </p>

            <form onSubmit={handleSaveSkill} className="modal-body-form" style={{ marginTop: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: "10px" }}>
                <label>
                  技能名称
                  <input
                    required
                    placeholder="例如：Hugo 静态博客自动化发布"
                    value={skillName}
                    onChange={(e) => setSkillName(e.target.value)}
                  />
                </label>
                <label>
                  分类
                  <select
                    value={skillCategoryVal}
                    onChange={(e) => setSkillCategoryVal(e.target.value as any)}
                  >
                    <option value="前端设计">前端设计</option>
                    <option value="工程规范">工程规范</option>
                    <option value="内容创作">内容创作</option>
                    <option value="安全审计">安全审计</option>
                    <option value="自动化运维">自动化运维</option>
                    <option value="其他">其他</option>
                  </select>
                </label>
              </div>

              <label>
                简要描述
                <input
                  placeholder="例如：规范博客 front-matter 元数据与构建流程"
                  value={skillDesc}
                  onChange={(e) => setSkillDesc(e.target.value)}
                />
              </label>

              <label>
                详细技能指令 (Markdown / Prompt 规范)
                <textarea
                  required
                  rows={6}
                  placeholder="编写给 Agent 遵循的具体操作规范与约束条款…"
                  value={skillInstructions}
                  onChange={(e) => setSkillInstructions(e.target.value)}
                  style={{ fontFamily: "var(--apple-font-mono, monospace)", fontSize: "12px" }}
                />
              </label>

              <label className="inspector-checkbox-label" style={{ marginTop: "4px" }}>
                <input
                  type="checkbox"
                  checked={skillEnabled}
                  onChange={(e) => setSkillEnabled(e.target.checked)}
                />
                <span>立即启用此技能并共享给所有 Agent</span>
              </label>

              <div className="modal-btn-row" style={{ marginTop: "16px" }}>
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowSkillModal(false)}
                >
                  取消
                </button>
                <button
                  className="apple-btn-primary"
                  type="submit"
                >
                  {editingSkill ? "保存技能更改" : "创建并共享技能"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
