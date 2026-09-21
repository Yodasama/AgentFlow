import { useState, type FormEvent } from "react";
import {
  createMockTask,
  createMockDevelopmentTask,
  type CreateMockTaskRequest,
  type RunSummary,
  type RunState,
} from "./api";

interface Props {
  runs: RunSummary[];
  onSelectRun: (id: string) => void;
  onRefresh: () => Promise<void>;
  busy: boolean;
}

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待人工确认",
  interrupted: "已中断",
  succeeded: "已成功",
  failed: "已失败",
  cancelled: "已取消",
};

export function TasksView({ runs, onSelectRun, onRefresh, busy }: Props) {
  const [filterState, setFilterState] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [taskMode, setTaskMode] = useState<"development" | "single">("development");
  const [title, setTitle] = useState("自动化重构与测试修复");
  const [description, setDescription] = useState("原生 runner 驱动 CLI Agent，闭环完成开发、测试与 Review。");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("测试通过\nReview 批准\nCheckpoint 留痕");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [scenario, setScenario] = useState<"pass" | "test_then_review_retry">("test_then_review_retry");
  const [outcome, setOutcome] = useState<"succeeded" | "failed">("succeeded");
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setModalBusy(true);
    setModalError(null);
    try {
      const criteria = acceptanceCriteria.split("\n").map((s) => s.trim()).filter(Boolean);
      if (taskMode === "development") {
        const created = await createMockDevelopmentTask(
          { title, description, acceptanceCriteria: criteria },
          repositoryPath.trim(),
          scenario
        );
        setShowCreateModal(false);
        await onRefresh();
        onSelectRun(created.runId);
      } else {
        const req: CreateMockTaskRequest = {
          title,
          description,
          acceptanceCriteria: criteria,
          outcome,
        };
        const created = await createMockTask(req);
        setShowCreateModal(false);
        await onRefresh();
        onSelectRun(created.runId);
      }
    } catch (err) {
      setModalError(String(err));
    } finally {
      setModalBusy(false);
    }
  };

  const filteredRuns = runs.filter((r) => {
    if (filterState !== "all" && r.runState !== filterState) return false;
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      return r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="tasks-view-container">
      <div className="tasks-header">
        <div>
          <h2>任务管理 (P8)</h2>
          <p className="subtitle">
            定义、排队与执行任务。所有任务运行严格隔离在 Git Worktree 与独立 Attempt 目录中。
          </p>
        </div>
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() => setShowCreateModal(true)}
        >
          + 创建新任务
        </button>
      </div>

      <div className="tasks-filter-bar">
        <div className="filter-chips">
          {[
            { key: "all", label: `全部 (${runs.length})` },
            { key: "running", label: "运行中" },
            { key: "waiting_input", label: "等待处理" },
            { key: "succeeded", label: "已成功" },
            { key: "failed", label: "已失败" },
            { key: "cancelled", label: "已取消" },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`chip ${filterState === item.key ? "active" : ""}`}
              onClick={() => setFilterState(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="search-box">
          <input
            type="text"
            placeholder="搜索任务名称或描述…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="tasks-cards-grid">
        {filteredRuns.length === 0 ? (
          <div className="empty-card">
            <p>暂无符合筛选条件的任务。</p>
            <button className="secondary-sm" type="button" onClick={() => setShowCreateModal(true)}>
              创建新任务
            </button>
          </div>
        ) : (
          filteredRuns.map((r) => (
            <div key={r.runId} className="task-card" onClick={() => onSelectRun(r.runId)}>
              <div className="task-card-top">
                <span className={`state-tag ${r.runState}`}>{stateLabels[r.runState]}</span>
                <small>{new Date(r.createdAt).toLocaleString()}</small>
              </div>
              <h3>{r.title}</h3>
              <p className="task-desc">{r.description || "无描述"}</p>
              <div className="task-card-footer">
                <small>Run ID: <code>{r.runId.slice(0, 8)}…</code></small>
                <button
                  className="secondary-sm"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectRun(r.runId);
                  }}
                >
                  查看执行事实 →
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showCreateModal && (
        <div className="modal-backdrop" onClick={() => setShowCreateModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>创建并排队任务</h3>
              <button className="close-btn" type="button" onClick={() => setShowCreateModal(false)}>
                ✕
              </button>
            </div>
            {modalError && <p role="alert" className="error-banner">{modalError}</p>}
            <form onSubmit={handleSubmit} className="create-form">
              <label>
                任务类型
                <select
                  disabled={modalBusy}
                  value={taskMode}
                  onChange={(e) => setTaskMode(e.target.value as typeof taskMode)}
                >
                  <option value="development">开发工作流（包含分析、开发、测试、Review 与审批）</option>
                  <option value="single">单步独立任务（CLI Agent 单步派发）</option>
                </select>
              </label>

              <label>
                任务标题
                <input
                  required
                  disabled={modalBusy}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>

              <label>
                任务描述
                <textarea
                  required
                  disabled={modalBusy}
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>

              <label>
                验收条件（每行一条）
                <textarea
                  disabled={modalBusy}
                  rows={3}
                  value={acceptanceCriteria}
                  onChange={(e) => setAcceptanceCriteria(e.target.value)}
                />
              </label>

              {taskMode === "development" ? (
                <>
                  <label>
                    本地 Git 仓库路径
                    <input
                      required
                      disabled={modalBusy}
                      placeholder="/Users/你的用户名/Projects/示例仓库"
                      value={repositoryPath}
                      onChange={(e) => setRepositoryPath(e.target.value)}
                    />
                  </label>
                  <p className="form-hint">
                    将在独立 Git Worktree 中操作，创建 Checkpoint，不会修改或暂存到您的宿主主工作目录。
                  </p>
                  <label>
                    执行仿真场景
                    <select
                      disabled={modalBusy}
                      value={scenario}
                      onChange={(e) => setScenario(e.target.value as typeof scenario)}
                    >
                      <option value="test_then_review_retry">首轮测试失败 → Review 返工 → 等待批准</option>
                      <option value="pass">测试与 Review 顺利通过 → 等待批准</option>
                    </select>
                  </label>
                </>
              ) : (
                <label>
                  模拟执行结果
                  <select
                    disabled={modalBusy}
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value as typeof outcome)}
                  >
                    <option value="succeeded">执行成功</option>
                    <option value="failed">模拟异常失败</option>
                  </select>
                </label>
              )}

              <div className="modal-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={modalBusy}
                  onClick={() => setShowCreateModal(false)}
                >
                  取消
                </button>
                <button className="primary" type="submit" disabled={modalBusy}>
                  {modalBusy ? "正在创建…" : "确认并排队"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
