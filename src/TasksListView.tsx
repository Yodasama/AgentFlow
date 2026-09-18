import { useState, type FormEvent } from "react";
import {
  createMockDevelopmentTask,
  createMockTask,
  type RunSummary,
  type RunState,
} from "./api";

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待人工决策",
  interrupted: "已中断",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

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
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setModalBusy(true);
    setModalError(null);
    try {
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
        setShowCreateModal(false);
        setTitle("");
        setDescription("");
        await onRefresh();
        // Automatically jump to task detail view
        onSelectRun(created.runId);
      } else {
        const created = await createMockTask({
          title: title.trim(),
          description: description.trim(),
          acceptanceCriteria: ["单步执行完成"],
          outcome: "succeeded",
        });
        setShowCreateModal(false);
        setTitle("");
        setDescription("");
        await onRefresh();
        // Automatically jump to task detail view
        onSelectRun(created.runId);
      }
    } catch (err) {
      setModalError(String(err));
    } finally {
      setModalBusy(false);
    }
  };

  const filtered = runs.filter((r) => {
    if (!searchTerm.trim()) return true;
    const q = searchTerm.toLowerCase();
    return (
      r.title.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q)
    );
  });

  return (
    <div className="tasks-list-page">
      {/* Page Header */}
      <div className="page-header-row">
        <div>
          <h1>任务</h1>
          <p className="page-subtitle">
            全部任务一览。点击任意任务行可直接进入详情页查看思维导图工作流与执行事实。
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            className="apple-search-input"
            type="text"
            placeholder="搜索任务…"
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

      {/* Tasks Table: 从左到右: 创建时间，任务名称，任务简介，当前状态 */}
      <div className="apple-table-card">
        <table className="apple-tasks-table">
          <thead>
            <tr>
              <th style={{ width: "18%" }}>创建时间</th>
              <th style={{ width: "26%" }}>任务名称</th>
              <th style={{ width: "42%" }}>任务简介</th>
              <th style={{ width: "14%", textAlign: "right" }}>当前状态</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="apple-table-empty">
                  {runs.length === 0
                    ? "暂无任务。点击右上角“+ 新建任务”创建第一个任务。"
                    : "未找到匹配的任务。"}
                </td>
              </tr>
            ) : (
              filtered.map((run) => (
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
                    <strong>{run.title}</strong>
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
              ))
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
            <p style={{ fontSize: "13px", color: "#86868b", marginTop: "2px", marginBottom: "16px" }}>
              创建后将直接跳转到任务详情页，并根据任务自动预设脑图工作流。
            </p>

            {modalError && (
              <div className="apple-alert-box error">{modalError}</div>
            )}

            <form onSubmit={handleCreate} className="modal-body-form">
              <label>
                任务工作流类型
                <select
                  value={taskMode}
                  onChange={(e) =>
                    setTaskMode(e.target.value as typeof taskMode)
                  }
                >
                  <option value="development">
                    标准开发闭环 (含需求分析、代码编写、测试与审查)
                  </option>
                  <option value="single">单步独立执行 (单一功能任务)</option>
                </select>
              </label>

              <label>
                任务名称
                <input
                  required
                  placeholder="例如：重构用户登录鉴权与 Token 刷新逻辑"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label>
                任务简介与要求
                <textarea
                  rows={3}
                  placeholder="简要描述本任务的具体目标，系统将据此初始化思维导图…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              {taskMode === "development" && (
                <label>
                  本地 Git 仓库路径
                  <input
                    placeholder="/Users/yida/项目/TaskBoard (留空将使用当前工作区)"
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
                  {modalBusy ? "创建中…" : "创建并前往脑图"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
