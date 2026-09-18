import { useCallback, useEffect, useState } from "react";
import {
  listRuns,
  type RunSummary,
} from "./api";
import { TasksListView } from "./TasksListView";
import { TaskDetailView } from "./TaskDetailView";
import { AgentManagerView } from "./AgentManagerView";
import { SchedulesView } from "./SchedulesView";
import { PlanningView } from "./PlanningView";

const navigation = ["任务", "Agent", "定时任务", "项目规划"];

export function App() {
  const [activeTab, setActiveTab] = useState<string>("任务");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const items = await listRuns();
      setRuns(items);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        await refreshRuns();
      } catch (reason) {
        if (active) setError(String(reason));
      }
      if (active) timer = window.setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refreshRuns]);

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
  };

  const handleTabClick = (item: string) => {
    setActiveTab(item);
    // When clicking a tab from detail view, return to list view for that tab
    setSelectedRunId(null);
  };

  return (
    <div className="shell">
      {/* Apple-Style Minimalist Sidebar */}
      <aside className="sidebar">
        {/* Artistic Typographic Brand Header without square avatar */}
        <div className="brand">
          <div className="brand-typography">
            <span className="brand-title">AgentFlow</span>
            <span className="brand-badge">STUDIO</span>
          </div>
          <p className="brand-sub">本地智能工程运行时</p>
        </div>

        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              className={activeTab === item && !selectedRunId ? "active" : ""}
              key={item}
              type="button"
              onClick={() => handleTabClick(item)}
            >
              {item === "任务" && <span className="nav-icon">📋</span>}
              {item === "Agent" && <span className="nav-icon">🤖</span>}
              {item === "定时任务" && <span className="nav-icon">⏰</span>}
              {item === "项目规划" && <span className="nav-icon">🧭</span>}
              <span>{item}</span>
            </button>
          ))}
        </nav>
      </aside>

      {/* Main Content Area */}
      <main>
        {error && (
          <div className="apple-alert-box error" style={{ marginBottom: "16px" }}>
            {error}
          </div>
        )}

        {/* If a task is selected, show Task Detail View (Mindmap Canvas + Execution Status) */}
        {selectedRunId ? (
          <TaskDetailView
            runId={selectedRunId}
            onBack={() => setSelectedRunId(null)}
            onRefreshList={refreshRuns}
          />
        ) : (
          <>
            {activeTab === "任务" && (
              <TasksListView
                runs={runs}
                onSelectRun={handleSelectRun}
                onRefresh={refreshRuns}
                busy={busy}
              />
            )}

            {activeTab === "Agent" && <AgentManagerView />}

            {activeTab === "定时任务" && (
              <SchedulesView
                onTriggerRun={handleSelectRun}
                onRefresh={refreshRuns}
              />
            )}

            {activeTab === "项目规划" && (
              <PlanningView
                onNavigateToRun={handleSelectRun}
                onRefreshRuns={refreshRuns}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;
