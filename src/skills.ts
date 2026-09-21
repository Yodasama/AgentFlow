export interface Skill {
  id: string;
  name: string;
  description: string;
  category: "前端设计" | "工程规范" | "内容创作" | "安全审计" | "自动化运维" | "其他";
  instructions: string;
  enabled: boolean;
  isBuiltin?: boolean;
  sourceUrl?: string;
  updatedAt: string;
}

export const SKILLS_STORAGE_KEY = "agentflow_skills_v2";

export const DEFAULT_SKILLS: Skill[] = [];

export function getStoredSkills(): Skill[] {
  try {
    const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
    if (!raw) {
      // Check if user had custom skills in v1
      const oldRaw = localStorage.getItem("agentflow_skills_v1");
      if (oldRaw) {
        try {
          const oldList = JSON.parse(oldRaw);
          if (Array.isArray(oldList)) {
            const userSkills = oldList.filter((s: Skill) => !s.isBuiltin);
            if (userSkills.length > 0) {
              saveSkills(userSkills);
              return userSkills;
            }
          }
        } catch {
          // ignore
        }
      }
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSkills(skills: Skill[]): void {
  localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(skills));
}

export function toggleSkill(id: string): Skill[] {
  const list = getStoredSkills();
  const updated = list.map((s) =>
    s.id === id ? { ...s, enabled: !s.enabled, updatedAt: new Date().toISOString() } : s
  );
  saveSkills(updated);
  return updated;
}

export function addSkill(skill: Omit<Skill, "id" | "updatedAt">): Skill {
  const list = getStoredSkills();
  const newSkill: Skill = {
    ...skill,
    id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    updatedAt: new Date().toISOString(),
  };
  const updated = [newSkill, ...list];
  saveSkills(updated);
  return newSkill;
}

export function updateSkill(id: string, patch: Partial<Skill>): Skill[] {
  const list = getStoredSkills();
  const updated = list.map((s) =>
    s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s
  );
  saveSkills(updated);
  return updated;
}

export function deleteSkill(id: string): Skill[] {
  const list = getStoredSkills();
  const updated = list.filter((s) => s.id !== id);
  saveSkills(updated);
  return updated;
}

export function clearAllSkills(): Skill[] {
  saveSkills([]);
  return [];
}

export function normalizeCategory(cat?: string): Skill["category"] {
  if (!cat) return "其他";
  const valid: Skill["category"][] = [
    "前端设计",
    "工程规范",
    "内容创作",
    "安全审计",
    "自动化运维",
    "其他",
  ];
  if (valid.includes(cat as any)) return cat as Skill["category"];
  const lower = cat.toLowerCase();
  if (lower.includes("front") || lower.includes("ui") || lower.includes("design") || lower.includes("设计")) {
    return "前端设计";
  }
  if (
    lower.includes("code") ||
    lower.includes("git") ||
    lower.includes("spec") ||
    lower.includes("工程") ||
    lower.includes("规范") ||
    lower.includes("dev")
  ) {
    return "工程规范";
  }
  if (
    lower.includes("write") ||
    lower.includes("blog") ||
    lower.includes("doc") ||
    lower.includes("创作") ||
    lower.includes("内容")
  ) {
    return "内容创作";
  }
  if (lower.includes("sec") || lower.includes("audit") || lower.includes("安全") || lower.includes("审计")) {
    return "安全审计";
  }
  if (
    lower.includes("ops") ||
    lower.includes("auto") ||
    lower.includes("运维") ||
    lower.includes("自动化") ||
    lower.includes("ci")
  ) {
    return "自动化运维";
  }
  return "其他";
}

export function parseSkillFromContent(
  content: string,
  fallbackName?: string,
  sourceUrl?: string
): Omit<Skill, "id" | "updatedAt"> {
  const trimmed = content.trim();

  // 1. Try parsing JSON format
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.name && (obj.instructions || obj.description || obj.content)) {
        return {
          name: String(obj.name).trim(),
          description: String(obj.description || "").trim(),
          category: normalizeCategory(obj.category),
          instructions: String(obj.instructions || obj.content || obj.description).trim(),
          enabled: true,
          isBuiltin: false,
          sourceUrl: sourceUrl || obj.sourceUrl,
        };
      }
    } catch {
      // Not valid JSON, proceed to Markdown
    }
  }

  // 2. Try parsing Markdown with YAML Frontmatter
  const frontmatterRegex = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;
  const match = trimmed.match(frontmatterRegex);

  let name = fallbackName || "";
  let description = "";
  let category: Skill["category"] = "其他";
  let instructions = trimmed;

  if (match) {
    const yamlBlock = match[1];
    instructions = match[2].trim();

    const lines = yamlBlock.split(/\r?\n/);
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "name" && value) name = value;
        if (key === "description" && value) description = value;
        if (key === "category" && value) category = normalizeCategory(value);
      }
    }
  }

  // If name is still empty, search for first markdown heading
  if (!name) {
    const headingMatch = instructions.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      name = headingMatch[1].replace(/^Protocol:\s*/i, "").trim();
    } else {
      name = fallbackName || "未命名技能";
    }
  }

  // If description is still empty, search for first paragraph
  if (!description) {
    const paras = instructions
      .split(/\r?\n\r?\n/)
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith("#"));
    if (paras.length > 0) {
      description = paras[0].slice(0, 140);
    } else {
      description = "外部导入的 Agent 共享技能";
    }
  }

  return {
    name,
    description,
    category,
    instructions,
    enabled: true,
    isBuiltin: false,
    sourceUrl,
  };
}

export function importSkillFromContent(
  content: string,
  fallbackName?: string,
  sourceUrl?: string
): Skill {
  const parsed = parseSkillFromContent(content, fallbackName, sourceUrl);
  return addSkill(parsed);
}

export function getActiveSkillsPrompt(): string {
  const active = getStoredSkills().filter((s) => s.enabled);
  if (active.length === 0) return "";
  return (
    `\n\n[全局共享技能库 (Shared Skills 已启用 ${active.length} 项)]:\n` +
    active
      .map((s) => `### 【${s.name}】(${s.category})\n${s.instructions.trim()}`)
      .join("\n\n")
  );
}
