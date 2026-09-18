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
import { ChatView } from "./ChatView";
import { type Workspace, getActiveWorkspace } from "./workspaces";
import { WorkspaceModal } from "./WorkspaceModal";

import {
  IconChat,
  IconTasks,
  IconPlanning,
  IconSchedule,
  IconAgent,
  IconFolder,
  IconChevronDown,
} from "./icons";

const navigation = ["对话", "任务", "项目规划", "定时任务"];

export function App() {
  const [activeTab, setActiveTab] = useState<string>("对话");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [busy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Global Active Workspace
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace>(() => getActiveWorkspace());
  const [showGlobalWsModal, setShowGlobalWsModal] = useState(false);

  // Cross-module handover for Grill-Me: { title, description }
  const [grillTopic, setGrillTopic] = useState<{ title: string; description: string } | null>(null);

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
    setSelectedRunId(null);
  };

  const handleStartGrillMeFromPlanning = (title: string, description: string) => {
    setGrillTopic({ title, description });
    setActiveTab("对话");
    setSelectedRunId(null);
  };

  return (
    <div className="shell">
      {/* Permanently Fixed Apple-Style Sidebar */}
      <aside className="sidebar">
        {/* Artistic Typographic Brand Header */}
        <div className="brand">
          <div className="brand-artistic">
            Agent<em>Flow</em>
          </div>

          {/* Global Workspace Indicator & Switcher */}
          <button
            type="button"
            className="sidebar-workspace-btn"
            onClick={() => setShowGlobalWsModal(true)}
            title="点击管理与切换工作区目录"
          >
            <span className="ws-dot">
              <IconFolder size={13} />
            </span>
            <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
              {currentWorkspace.name}
            </span>
            <span className="ws-chevron" style={{ display: "inline-flex", alignItems: "center" }}>
              <IconChevronDown size={12} />
            </span>
          </button>
        </div>

        {/* Main Navigation: 对话, 任务, 项目规划, 定时任务 */}
        <nav aria-label="主导航">
          {navigation.map((item) => (
            <button
              className={activeTab === item && !selectedRunId ? "active" : ""}
              key={item}
              type="button"
              onClick={() => handleTabClick(item)}
            >
              {item === "对话" && <span className="nav-icon"><IconChat size={16} /></span>}
              {item === "任务" && <span className="nav-icon"><IconTasks size={16} /></span>}
              {item === "项目规划" && <span className="nav-icon"><IconPlanning size={16} /></span>}
              {item === "定时任务" && <span className="nav-icon"><IconSchedule size={16} /></span>}
              <span>{item}</span>
            </button>
          ))}
        </nav>

        {/* Agent Role Management pinned at the very bottom of sidebar */}
        <div className="sidebar-bottom">
          <button
            className={activeTab === "Agent" && !selectedRunId ? "active" : ""}
            type="button"
            onClick={() => handleTabClick("Agent")}
          >
            <span className="nav-icon"><IconAgent size={16} /></span>
            <span>Agent 角色管理</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main>
        {error && (
          <div className="apple-alert-box error" style={{ marginBottom: "16px" }}>
            {error}
          </div>
        )}

        {/* If a task is selected, show Task Detail View */}
        {selectedRunId ? (
          <TaskDetailView
            runId={selectedRunId}
            onBack={() => setSelectedRunId(null)}
            onRefreshList={refreshRuns}
          />
        ) : (
          <>
            {activeTab === "对话" && (
              <ChatView
                onNavigateToRun={handleSelectRun}
                onNavigateToTab={(tab) => setActiveTab(tab)}
                onRefreshRuns={refreshRuns}
                initialGrillTopic={grillTopic}
                onClearGrillTopic={() => setGrillTopic(null)}
              />
            )}

            {activeTab === "任务" && (
              <TasksListView
                runs={runs}
                onSelectRun={handleSelectRun}
                onRefresh={refreshRuns}
                busy={busy}
              />
            )}

            {activeTab === "项目规划" && (
              <PlanningView
                onNavigateToRun={handleSelectRun}
                onRefreshRuns={refreshRuns}
                onStartGrillMe={handleStartGrillMeFromPlanning}
                onNavigateToTab={(tab) => setActiveTab(tab)}
              />
            )}

            {activeTab === "定时任务" && (
              <SchedulesView
                onTriggerRun={handleSelectRun}
                onRefresh={refreshRuns}
              />
            )}

            {activeTab === "Agent" && <AgentManagerView />}
          </>
        )}
      </main>

      {/* Global Workspace Modal */}
      {showGlobalWsModal && (
        <WorkspaceModal
          activeWorkspace={currentWorkspace}
          onSelectWorkspace={(ws) => setCurrentWorkspace(ws)}
          onClose={() => setShowGlobalWsModal(false)}
        />
      )}
    </div>
  );
}

export default App;
