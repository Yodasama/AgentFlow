import { useState, useEffect, type FormEvent } from "react";
import {
  createMockDevelopmentTask,
  createMockTask,
  listGoals,
  type RunSummary,
  type RunState,
  type GoalRecord,
} from "./api";
import { IconFolder, IconZap } from "./icons";

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待人工决策",
  interrupted: "已中断",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

export const TASK_PROJECT_LINKS_KEY = "agentflow_task_project_links_v1";

export interface TaskProjectLink {
  planId: string;
  planTitle: string;
  milestoneTitle?: string;
}

export function getTaskProjectLinks(): Record<string, TaskProjectLink> {
  try {
    const saved = localStorage.getItem(TASK_PROJECT_LINKS_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

interface Props {
  runs: RunSummary[];
  onSelectRun: (runId: string) => void;
  onRefresh: () => Promise<void>;
  busy: boolean;
}

export function TasksListView({ runs, onSelectRun, onRefresh, busy }: Props) {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [taskMode, setTaskMode] = useState<"development" | "single">("development");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState<"all" | "project" | "light">("all");
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");

  const [availablePlans, setAvailablePlans] = useState<GoalRecord[]>([]);
  const [taskLinks, setTaskLinks] = useState<Record<string, TaskProjectLink>>(getTaskProjectLinks);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    void listGoals().then(setAvailablePlans).catch(() => {});
    setTaskLinks(getTaskProjectLinks());
  }, [runs]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setModalBusy(true);
    setModalError(null);
    try {
      let createdRunId = "";
      if (taskMode === "development") {
        const created = await createMockDevelopmentTask(
          {
            title: title.trim(),
            description: description.trim() || "自动化开发与审查闭环任务",
            acceptanceCriteria: ["测试通过", "审查批准", "Checkpoint 提交"],
          },
          repositoryPath.trim() || "/Users/yida/项目/TaskBoard",
          "test_then_review_retry"
        );
        createdRunId = created.runId;
      } else {
        const created = await createMockTask({
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: ["单步执行完成"],
          outcome: "succeeded",
        });
        createdRunId = created.runId;
      }

      // If a project plan was selected, record the link
      if (selectedPlanId) {
        const targetPlan = availablePlans.find((p) => p.id === selectedPlanId);
        if (targetPlan) {
          const updated = {
            ...taskLinks,
            [createdRunId]: {
              planId: targetPlan.id,
              planTitle: targetPlan.title,
            },
          };
          setTaskLinks(updated);
          localStorage.setItem(TASK_PROJECT_LINKS_KEY, JSON.stringify(updated));
        }
      }

      setShowCreateModal(false);
      setTitle("");
      setDescription("");
      setSelectedPlanId("");
      await onRefresh();
      // Automatically jump to task detail view
      onSelectRun(createdRunId);
    } catch (err) {
      setModalError(String(err));
    } finally {
      setModalBusy(false);
    }
  };

  const filtered = runs.filter((r) => {
    // Search query
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      const matchText =
        r.title.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        taskLinks[r.runId]?.planTitle.toLowerCase().includes(q);
      if (!matchText) return false;
    }

    // Weight/Association Filter
    if (filterType === "project") {
      return Boolean(taskLinks[r.runId]);
    }
    if (filterType === "light") {
      return !taskLinks[r.runId];
    }
    return true;
  });

  const projectTasksCount = runs.filter((r) => Boolean(taskLinks[r.runId])).length;
  const lightTasksCount = runs.length - projectTasksCount;

  return (
    <div className="tasks-list-page">
      {/* Page Header */}
      <div className="page-header-row">
        <div>
          <h1>任务列表</h1>
          <p className="page-subtitle">
            查看全部执行任务。支持独立轻量任务与立项拆解任务的分类管理，点击可进入脑图工作流与执行详情。
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            className="apple-search-input"
            type="text"
            placeholder="搜索任务或关联项目…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <button
            className="apple-btn-primary"
            type="button"
            disabled={busy}
            onClick={() => setShowCreateModal(true)}
          >
            + 新建任务
          </button>
        </div>
      </div>

      {/* Task Filter Segmented Bar */}
      <div className="task-filter-bar">
        <button
          type="button"
          className={`filter-pill ${filterType === "all" ? "active" : ""}`}
          onClick={() => setFilterType("all")}
        >
          全部任务 ({runs.length})
        </button>
        <button
          type="button"
          className={`filter-pill ${filterType === "project" ? "active" : ""}`}
          onClick={() => setFilterType("project")}
          style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
        >
          <IconFolder size={12} />
          <span>规划关联任务 ({projectTasksCount})</span>
        </button>
        <button
          type="button"
          className={`filter-pill ${filterType === "light" ? "active" : ""}`}
          onClick={() => setFilterType("light")}
          style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
        >
          <IconZap size={12} />
          <span>独立轻任务 ({lightTasksCount})</span>
        </button>
      </div>

      {/* Tasks Table: 创建时间，任务名称 & 所属项目，任务简介，当前状态 */}
      <div className="apple-table-card">
        <table className="apple-tasks-table">
          <thead>
            <tr>
              <th style={{ width: "16%" }}>创建时间</th>
              <th style={{ width: "32%" }}>任务名称 & 关联规划</th>
              <th style={{ width: "38%" }}>任务简介</th>
              <th style={{ width: "14%", textAlign: "right" }}>当前状态</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="apple-table-empty">
                  {runs.length === 0
                    ? "暂无任务。点击右上角“+ 新建任务”创建第一个任务。"
                    : "未找到符合当前过滤条件的任务。"}
                </td>
              </tr>
            ) : (
              filtered.map((run) => {
                const link = taskLinks[run.runId];

                return (
                  <tr
                    key={run.runId}
                    className="apple-task-row"
                    onClick={() => onSelectRun(run.runId)}
                  >
                    <td className="col-time">
                      {new Date(run.createdAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>

                    <td className="col-name">
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                        <strong>{run.title}</strong>
                        {link ? (
                          <span className="task-project-tag" title={`所属立项：${link.planTitle}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <IconFolder size={11} />
                            <span>{link.planTitle}</span>
                          </span>
                        ) : (
                          <span className="task-light-tag" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <IconZap size={11} />
                            <span>独立轻任务</span>
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="col-desc">
                      <span>{run.description || "无简介"}</span>
                    </td>

                    <td className="col-status" style={{ textAlign: "right" }}>
                      <span className={`apple-pill ${run.runState}`}>
                        {stateLabels[run.runState]}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal: 新建任务 */}
      {showCreateModal && (
        <div
          className="apple-modal-backdrop"
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="apple-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>新建任务</h3>
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px", marginBottom: "14px" }}>
              轻量任务可直接创建执行；重任务可关联到“项目规划”中，实现大工程的分解闭环。
            </p>

            {modalError && (
              <div className="apple-alert-box error">{modalError}</div>
            )}

            <form onSubmit={handleCreate} className="modal-body-form">
              {/* Project Linking Dropdown */}
              <label>
                所属立项规划 (可选，重任务建议关联)
                <select
                  value={selectedPlanId}
                  onChange={(e) => setSelectedPlanId(e.target.value)}
                >
                  <option value="">无关联 (独立轻量任务)</option>
                  {availablePlans.map((p) => (
                    <option key={p.id} value={p.id}>
                      [立项规划] {p.title}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                任务类型
                <select
                  value={taskMode}
                  onChange={(e) =>
                    setTaskMode(e.target.value as typeof taskMode)
                  }
                >
                  <option value="development">
                    标准开发闭环 (需求分析、代码编写、单元测试与代码审查)
                  </option>
                  <option value="single">快速单步运行 (直接执行命令或脚本)</option>
                </select>
              </label>

              <label>
                任务名称
                <input
                  required
                  disabled={modalBusy}
                  placeholder="例如：重构数据连接池异常捕获逻辑"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label>
                任务简介与上下文
                <textarea
                  disabled={modalBusy}
                  rows={3}
                  placeholder="简述任务要解决的问题、边界条件与预期成果…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              {taskMode === "development" && (
                <label>
                  本地 Git 仓库路径
                  <input
                    disabled={modalBusy}
                    placeholder="/Users/yida/项目/TaskBoard (留空默认使用当前工作区)"
                    value={repositoryPath}
                    onChange={(e) => setRepositoryPath(e.target.value)}
                  />
                </label>
              )}

              <div className="modal-btn-row">
                <button
                  className="apple-btn-secondary"
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                >
                  取消
                </button>
                <button
                  className="apple-btn-primary"
                  type="submit"
                  disabled={modalBusy}
                >
                  {modalBusy ? "创建中…" : "立即创建并打开"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
