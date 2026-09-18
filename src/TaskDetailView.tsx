import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeProps,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  cancelRun,
  createMockTask,
  getAttemptLogs,
  getCheckpointDiff,
  getRun,
  listCheckpoints,
  submitDevelopmentApproval,
  getDevelopmentRun,
  type AttemptLogs,
  type CheckpointRecord,
  type DevelopmentRunSnapshot,
  type RunDetail,
  type RunState,
} from "./api";
import { loadAgentRoles, type AgentRoleConfig } from "./AgentManagerView";
import { getTaskProjectLinks } from "./TasksListView";
import {
  IconCpu,
  IconFolder,
  IconZap,
  IconGitBranch,
  IconChevronRight,
  IconCheck,
  IconSparkles,
  IconTag,
  IconUser,
  IconAlertTriangle,
} from "./icons";

const stateLabels: Record<RunState, string> = {
  queued: "排队中",
  running: "运行中",
  waiting_input: "等待人工决策",
  interrupted: "已中断",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};

interface MindMapNodeData {
  label: string;
  role: string;
  model: string;
  reasoning: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  description?: string;
  [key: string]: unknown;
}

// Apple Mind-Map Custom Node Component
function MindMapNode({ data, selected }: NodeProps) {
  const nodeData = data as unknown as MindMapNodeData;
  const statusColors = {
    pending: { bg: "#f5f5f7", text: "#86868b", border: "#e5e5ea" },
    running: { bg: "#e8f2ff", text: "#0071e3", border: "#0071e3" },
    succeeded: { bg: "#eafaf1", text: "#24a159", border: "#24a159" },
    failed: { bg: "#fdf0ed", text: "#e03e1a", border: "#e03e1a" },
    waiting: { bg: "#fef6e7", text: "#d97706", border: "#d97706" },
  };
  const color = statusColors[nodeData.status] || statusColors.pending;

  return (
    <div
      style={{
        background: "#ffffff",
        border: `1.5px solid ${selected ? "#0071e3" : color.border}`,
        borderRadius: "12px",
        padding: "12px 14px",
        minWidth: "200px",
        boxShadow: selected
          ? "0 0 0 3px rgba(0, 113, 227, 0.15), 0 4px 14px rgba(0,0,0,0.06)"
          : "0 2px 8px rgba(0,0,0,0.04)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: "#86868b", width: 7, height: 7 }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "6px",
        }}
      >
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: color.text,
            background: color.bg,
            padding: "2px 6px",
            borderRadius: "5px",
          }}
        >
          {nodeData.role}
        </span>
        <span
          style={{
            fontSize: "10px",
            color: "#86868b",
            background: "#f5f5f7",
            padding: "2px 5px",
            borderRadius: "4px",
          }}
        >
          推理: {nodeData.reasoning}
        </span>
      </div>

      <div
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#1d1d1f",
          marginBottom: "6px",
        }}
      >
        {nodeData.label}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "11px",
          color: "#86868b",
          borderTop: "1px solid #f2f2f5",
          paddingTop: "6px",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <IconCpu size={11} />
          <span>{nodeData.model}</span>
        </span>
        <span style={{ fontSize: "10px", color: color.text }}>
          {nodeData.status === "running"
            ? "运行中"
            : nodeData.status === "succeeded"
            ? "已完成"
            : nodeData.status === "failed"
            ? "异常"
            : nodeData.status === "waiting"
            ? "待处理"
            : "就绪"}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: "#86868b", width: 7, height: 7 }}
      />
    </div>
  );
}

const nodeTypes = { mindMapNode: MindMapNode };

export interface VisualCommitNode {
  id: string;
  sha: string;
  shortSha: string;
  branch: string;
  message: string;
  author: string;
  timestamp: string;
  checkpointId?: string;
  controlledFiles: string[];
  status: "base" | "dev" | "test" | "review" | "candidate" | "merged";
}

interface Props {
  runId: string;
  onBack: () => void;
  onRefreshList: () => Promise<void>;
}

export function TaskDetailView({ runId, onBack, onRefreshList }: Props) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [snapshot, setSnapshot] = useState<DevelopmentRunSnapshot | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([]);
  const [logs, setLogs] = useState<AttemptLogs | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [activeLogTab, setActiveLogTab] = useState<"diff" | "commit_logs" | "stdout" | "stderr">("diff");
  const [approvalComment, setApprovalComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Git Branch Tree Hover & Selection State
  const [hoveredCommit, setHoveredCommit] = useState<VisualCommitNode | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<VisualCommitNode | null>(null);

  // Canvas Node & Edge State
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Available Agent Roles & Linked Project
  const [availableRoles, setAvailableRoles] = useState<AgentRoleConfig[]>(loadAgentRoles);
  const linkedProject = getTaskProjectLinks()[runId];

  // New Node Modal
  const [showAddNodeModal, setShowAddNodeModal] = useState(false);
  const [newNodeRole, setNewNodeRole] = useState("开发编写");
  const [newNodeModel, setNewNodeModel] = useState("Claude 3.5 Sonnet");
  const [newNodeReasoning, setNewNodeReasoning] = useState("深度");
  const [newNodeLabel, setNewNodeLabel] = useState("");

  const handleOpenAddNodeModal = () => {
    const currentRoles = loadAgentRoles();
    setAvailableRoles(currentRoles);
    if (currentRoles.length > 0) {
      setNewNodeRole(currentRoles[0].roleName);
      setNewNodeModel(currentRoles[0].defaultModel);
      setNewNodeReasoning(currentRoles[0].defaultReasoning);
    }
    setShowAddNodeModal(true);
  };

  const handleRoleSelectChange = (roleName: string) => {
    setNewNodeRole(roleName);
    const found = availableRoles.find((r) => r.roleName === roleName);
    if (found) {
      setNewNodeModel(found.defaultModel);
      setNewNodeReasoning(found.defaultReasoning);
    }
  };

  const loadData = useCallback(async () => {
    try {
      const runData = await getRun(runId);
      setDetail(runData);

      if (runData.workflowKind === "development_workflow") {
        try {
          const snap = await getDevelopmentRun(runId);
          setSnapshot(snap);
        } catch {
          // ignore
        }
      }

      try {
        const cpList = await listCheckpoints(runId);
        setCheckpoints(cpList);
        if (cpList.length > 0 && !diffText) {
          const latestDiff = await getCheckpointDiff(cpList[cpList.length - 1].checkpointId);
          setDiffText(latestDiff);
        }
      } catch {
        // ignore
      }

      if (runData.attemptId) {
        try {
          const logData = await getAttemptLogs(runId, runData.attemptId);
          setLogs(logData);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      setError(String(err));
    }
  }, [runId, diffText]);

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      void loadData();
    }, 1500);
    return () => clearInterval(interval);
  }, [loadData]);

  // Construct Visual Commits DAG Tree
  const branchName = `agent/worktree-${runId.slice(0, 8)}`;
  const baseSha = checkpoints[0]?.baseSha || "4a1e98e";

  const treeNodes: VisualCommitNode[] = [
    {
      id: "commit-base",
      sha: baseSha,
      shortSha: baseSha.slice(0, 7),
      branch: "main",
      message: "初始化工程基线 (Origin Base Commit)",
      author: "Git System",
      timestamp: detail ? new Date(detail.createdAt).toLocaleTimeString("zh-CN") : "00:00",
      controlledFiles: ["src/", "Cargo.toml", "package.json"],
      status: "base",
    },
    ...checkpoints.map((cp, idx) => ({
      id: cp.checkpointId,
      sha: cp.commitSha,
      shortSha: cp.commitSha.slice(0, 7),
      branch: branchName,
      message: cp.marker || `Checkpoint #${idx + 1}: 代码增量提交与快照`,
      author: "Agent (Claude 3.5 Sonnet)",
      timestamp: new Date(cp.createdAt).toLocaleTimeString("zh-CN"),
      checkpointId: cp.checkpointId,
      controlledFiles: cp.controlledFiles.length > 0 ? cp.controlledFiles : ["agentflow-fixture.txt"],
      status: "dev" as const,
    })),
    ...(snapshot?.flow.candidateCommit
      ? [
          {
            id: "commit-candidate",
            sha: snapshot.flow.candidateCommit,
            shortSha: snapshot.flow.candidateCommit.slice(0, 7),
            branch: branchName,
            message: "候选准入提交 (Candidate Release for Approval)",
            author: "AgentFlow Pipeline",
            timestamp: "最新",
            controlledFiles: ["agentflow-fixture.txt", "review.log"],
            status: "candidate" as const,
          },
        ]
      : []),
    ...(detail?.runState === "succeeded"
      ? [
          {
            id: "commit-merged",
            sha: snapshot?.flow.completedCommit || "7f8a2c1",
            shortSha: (snapshot?.flow.completedCommit || "7f8a2c1").slice(0, 7),
            branch: "main",
            message: "验证准入并合并交付 (Delivered & Merged)",
            author: "Human Reviewer",
            timestamp: detail.finishedAt ? new Date(detail.finishedAt).toLocaleTimeString("zh-CN") : "刚刚",
            controlledFiles: ["全部受控变更集"],
            status: "merged" as const,
          },
        ]
      : []),
  ];

  // Generate or update mindmap nodes based on task and execution progress
  useEffect(() => {
    if (!detail) return;

    const phase = snapshot?.flow.phase;
    const isDev = detail.workflowKind === "development_workflow";

    const defaultNodes: Node[] = isDev
      ? [
          {
            id: "node-1",
            type: "mindMapNode",
            position: { x: 50, y: 120 },
            data: {
              label: "任务需求分析",
              role: "架构与拆解",
              model: "Claude 3.5 Sonnet",
              reasoning: "高",
              status: phase === "analysis" ? "running" : "succeeded",
            },
          },
          {
            id: "node-2",
            type: "mindMapNode",
            position: { x: 310, y: 120 },
            data: {
              label: "核心代码编写与 Checkpoint",
              role: "代码开发",
              model: "Claude 3.5 Sonnet",
              reasoning: "高",
              status:
                phase === "development"
                  ? "running"
                  : phase === "analysis"
                  ? "pending"
                  : "succeeded",
            },
          },
          {
            id: "node-3",
            type: "mindMapNode",
            position: { x: 570, y: 50 },
            data: {
              label: "自动化单元与回归测试",
              role: "测试验证",
              model: "自动化环境 (Test Runner)",
              reasoning: "标准",
              status:
                phase === "tests"
                  ? "running"
                  : ["analysis", "development"].includes(phase ?? "")
                  ? "pending"
                  : snapshot?.flow.testHistory.some((t) => t.status === "failed") &&
                    phase !== "completed" &&
                    phase !== "human_approval"
                  ? "failed"
                  : "succeeded",
            },
          },
          {
            id: "node-4",
            type: "mindMapNode",
            position: { x: 570, y: 200 },
            data: {
              label: "代码规范与安全性 Review",
              role: "代码审查",
              model: "Claude 3.5 Sonnet",
              reasoning: "高",
              status:
                phase === "review"
                  ? "running"
                  : ["analysis", "development", "tests"].includes(phase ?? "")
                  ? "pending"
                  : snapshot?.flow.reviewHistory.some((r) => r.verdict === "changes_requested") &&
                    phase !== "completed" &&
                    phase !== "human_approval"
                  ? "failed"
                  : "succeeded",
            },
          },
          {
            id: "node-5",
            type: "mindMapNode",
            position: { x: 860, y: 120 },
            data: {
              label: "人工决策与交付确认",
              role: "质量审批",
              model: "人工确认 (Human In Loop)",
              reasoning: "最高",
              status:
                phase === "human_approval"
                  ? "waiting"
                  : phase === "completed"
                  ? "succeeded"
                  : "pending",
            },
          },
        ]
      : [
          {
            id: "node-single-1",
            type: "mindMapNode",
            position: { x: 100, y: 120 },
            data: {
              label: detail.title,
              role: "独立执行",
              model: "Mock Agent / 本地模型",
              reasoning: "标准",
              status:
                detail.runState === "running"
                  ? "running"
                  : detail.runState === "succeeded"
                  ? "succeeded"
                  : detail.runState === "failed"
                  ? "failed"
                  : "pending",
            },
          },
        ];

    const defaultEdges: Edge[] = isDev
      ? [
          {
            id: "e1-2",
            source: "node-1",
            target: "node-2",
            style: { stroke: "#b0b0b8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#86868b" },
          },
          {
            id: "e2-3",
            source: "node-2",
            target: "node-3",
            style: { stroke: "#b0b0b8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#86868b" },
          },
          {
            id: "e2-4",
            source: "node-2",
            target: "node-4",
            style: { stroke: "#b0b0b8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#86868b" },
          },
          {
            id: "e3-5",
            source: "node-3",
            target: "node-5",
            style: { stroke: "#b0b0b8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#86868b" },
          },
          {
            id: "e4-5",
            source: "node-4",
            target: "node-5",
            style: { stroke: "#b0b0b8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#86868b" },
          },
        ]
      : [];

    setNodes((prev) => (prev.length > 0 ? prev : defaultNodes));
    setEdges((prev) => (prev.length > 0 ? prev : defaultEdges));
  }, [detail, snapshot, setNodes, setEdges]);

  const handleAddNode = () => {
    if (!newNodeLabel.trim()) return;
    const newId = `custom-node-${Date.now()}`;
    const newNode: Node = {
      id: newId,
      type: "mindMapNode",
      position: { x: 300 + Math.random() * 200, y: 60 + Math.random() * 150 },
      data: {
        label: newNodeLabel.trim(),
        role: newNodeRole,
        model: newNodeModel,
        reasoning: newNodeReasoning,
        status: "pending",
      },
    };
    setNodes((prev) => [...prev, newNode]);
    setShowAddNodeModal(false);
    setNewNodeLabel("");
  };

  const handleCancelRun = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await cancelRun(detail.runId);
      await loadData();
      await onRefreshList();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRerun = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await createMockTask({
        title: `[重试] ${detail.title}`,
        description: detail.description,
        acceptanceCriteria: detail.acceptanceCriteria,
        outcome: "succeeded",
      });
      await onRefreshList();
      onBack();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleApproval = async (decision: "approved" | "rejected") => {
    if (!snapshot?.flow.candidateCommit) return;
    setBusy(true);
    try {
      await submitDevelopmentApproval(detail!.runId, {
        schemaVersion: 1,
        candidateCommit: snapshot.flow.candidateCommit,
        workflowDigest: snapshot.flow.workflowDigest,
        decision,
        comment: approvalComment.trim(),
      });
      setApprovalComment("");
      await loadData();
      await onRefreshList();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSelectCommit = async (node: VisualCommitNode) => {
    setSelectedCommit(node);
    if (node.checkpointId) {
      try {
        const diff = await getCheckpointDiff(node.checkpointId);
        setDiffText(diff);
        setActiveLogTab("diff");
      } catch {
        // ignore
      }
    }
  };

  if (!detail) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "#86868b" }}>
        正在读取任务详情…
      </div>
    );
  }

  // Derive status details for lower half
  const phase = snapshot?.flow.phase;
  const isWaitingApproval =
    detail.runState === "waiting_input" && phase === "human_approval";
  const hasBlockers =
    detail.runState === "failed" ||
    detail.runState === "interrupted" ||
    isWaitingApproval ||
    Boolean(detail.waitingReason);

  return (
    <div className="task-detail-page">
      {/* Top Header Bar */}
      <div className="detail-top-nav">
        <button className="apple-btn-secondary" type="button" onClick={onBack}>
          ← 返回任务列表
        </button>
        <div className="task-title-group">
          <div className="task-breadcrumb">
            {linkedProject ? (
              <span className="breadcrumb-project" title={`所属立项：${linkedProject.planTitle}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <IconFolder size={11} />
                <span>{linkedProject.planTitle}</span>
              </span>
            ) : (
              <span className="breadcrumb-light" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <IconZap size={11} />
                <span>独立轻任务</span>
              </span>
            )}
            <span className="breadcrumb-sep">›</span>
            <span className="breadcrumb-current">{detail.title}</span>
          </div>
          <span className={`apple-pill ${detail.runState}`}>
            {stateLabels[detail.runState]}
          </span>
        </div>
        <div className="detail-action-buttons">
          {["queued", "running", "waiting_input"].includes(detail.runState) && (
            <button
              className="apple-btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => void handleCancelRun()}
            >
              终止执行
            </button>
          )}
          <button
            className="apple-btn-primary"
            type="button"
            disabled={busy}
            onClick={() => void handleRerun()}
          >
            重新运行
          </button>
        </div>
      </div>

      {error && <div className="apple-alert-box error">{error}</div>}

      {/* Upper Half: MindMap Flow Canvas */}
      <section className="mindmap-canvas-section">
        <div className="canvas-header-bar">
          <div className="canvas-title-wrap">
            <span className="section-title">任务架构与执行流</span>
            <small className="section-sub">
              可视化当前执行链路。每个节点展示模型引擎、推理深度与担任的功能角色
            </small>
          </div>
          <button
            className="apple-btn-secondary add-node-btn"
            type="button"
            onClick={() => setShowAddNodeModal(true)}
          >
            + 补充节点
          </button>
        </div>

        <div className="mindmap-reactflow-wrapper">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable
          >
            <Background color="#eaeaea" gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </section>

      {/* Middle: Git Branch & Commit DAG Tree View */}
      <section className="git-tree-section">
        <div className="git-tree-header">
          <div className="tree-header-info">
            <span className="section-title">Git 分支演进树 (Tree Graph)</span>
            <small className="section-sub">
              鼠标悬停节点可查看 Commit 详细内容与受控文件，点击可定位代码 Diff
            </small>
          </div>
          <div className="branch-pills-row">
            <span className="branch-tag main" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <IconGitBranch size={12} />
              <span>main (基准)</span>
            </span>
            <span className="branch-arrow" style={{ display: "inline-flex", alignItems: "center" }}>
              <IconChevronRight size={12} />
            </span>
            <span className="branch-tag worktree" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              <IconGitBranch size={12} />
              <span>{branchName} (隔离开发)</span>
            </span>
          </div>
        </div>

        <div className="git-tree-body">
          {/* Horizontal Tree DAG */}
          <div className="git-tree-dag">
            {treeNodes.map((c, idx) => {
              const isHovered = hoveredCommit?.id === c.id;
              const isSelected = selectedCommit?.id === c.id;

              return (
                <div
                  key={c.id}
                  className={`git-tree-node-wrapper ${isSelected ? "selected" : ""}`}
                  onMouseEnter={() => setHoveredCommit(c)}
                  onMouseLeave={() => setHoveredCommit(null)}
                  onClick={() => void handleSelectCommit(c)}
                >
                  {/* Connector Line */}
                  {idx > 0 && <div className="tree-connector-line" />}

                  {/* Node Circle */}
                  <div className={`tree-node-circle ${c.status}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {c.status === "base" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />}
                    {c.status === "dev" && <IconCheck size={10} />}
                    {c.status === "candidate" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />}
                    {c.status === "merged" && <IconSparkles size={10} />}
                  </div>

                  {/* Node Text Info */}
                  <div className="tree-node-label">
                    <span className="tree-sha">{c.shortSha}</span>
                    <span className="tree-summary">{c.message.slice(0, 14)}…</span>
                  </div>

                  {/* Floating Popover on Hover */}
                  {isHovered && (
                    <div className="tree-hover-popover">
                      <div className="popover-header">
                        <span className="popover-sha" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <IconTag size={11} />
                          <span>{c.sha}</span>
                        </span>
                        <span className={`apple-pill ${c.status === "merged" ? "succeeded" : "running"}`}>
                          {c.branch}
                        </span>
                      </div>
                      <div className="popover-message">{c.message}</div>
                      <div className="popover-meta">
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <IconUser size={11} />
                          <span>提交人：{c.author}</span>
                        </span>
                        <span>时间：{c.timestamp}</span>
                      </div>
                      <div className="popover-files">
                        <strong>受控文件：</strong>
                        {c.controlledFiles.map((f, i) => (
                          <span key={i} className="file-chip">
                            {f}
                          </span>
                        ))}
                      </div>
                      <div className="popover-tip">点击以在下方比对代码 Diff</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Lower Half: Execution Status Breakdown */}
      <section className="status-breakdown-section">
        <div className="section-title-bar">
          <h2>当前执行状态</h2>
          <small>
            Attempt #{detail.attemptNumber ?? "-"} ·{" "}
            {snapshot ? `第 ${snapshot.flow.iteration} 轮迭代 · 已用 ${snapshot.flow.actionsUsed} 步` : "独立单步"}
          </small>
        </div>

        <div className="status-cards-grid">
          {/* 1. 已完成什么 */}
          <div className="status-card">
            <div className="card-header">
              <span className="card-badge green" style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <IconCheck size={11} />
                <span>已完成内容</span>
              </span>
            </div>
            <ul className="status-list">
              <li>
                <strong>创建任务与资源锁定：</strong>
                <span>任务已原子入库，获取工作区隔离环境。</span>
              </li>
              {checkpoints.map((cp, idx) => (
                <li key={cp.checkpointId}>
                  <strong>Checkpoint #{idx + 1}：</strong>
                  <span>
                    代码已提交 (Commit: <code>{cp.commitSha.slice(0, 7)}</code>)
                  </span>
                </li>
              ))}
              {snapshot?.flow.testHistory
                .filter((t) => t.status === "passed")
                .map((t, idx) => (
                  <li key={idx}>
                    <strong>自动化测试通过：</strong>
                    <span>{t.summary}</span>
                  </li>
                ))}
              {snapshot?.flow.reviewHistory
                .filter((r) => r.verdict === "approved")
                .map((r, idx) => (
                  <li key={idx}>
                    <strong>代码审查批准：</strong>
                    <span>{r.summary}</span>
                  </li>
                ))}
              {detail.runState === "succeeded" && (
                <li style={{ color: "#24a159" }}>
                  <strong>最终交付：</strong>
                  <span>任务已全部完成并通过验证。</span>
                </li>
              )}
            </ul>
          </div>

          {/* 2. 下一步需要执行什么 */}
          <div className="status-card">
            <div className="card-header">
              <span className="card-badge blue">→ 下一步计划</span>
            </div>
            <div className="status-content">
              {detail.runState === "queued" && (
                <p>等待本地调度器分配并发通道并启动 Runner 进程…</p>
              )}
              {detail.runState === "running" && (
                <p>
                  当前处于【{phase === "analysis" ? "需求分析" : phase === "development" ? "代码生成" : phase === "tests" ? "测试运行" : phase === "review" ? "代码审查" : "执行中"}】阶段，Runner 正在执行子命令并写入输出日志。
                </p>
              )}
              {isWaitingApproval && (
                <p>所有测试与 Review 已就绪，等待人工确认当前 Checkpoint 代码快照是否准予交付。</p>
              )}
              {detail.runState === "succeeded" && (
                <p>所有步骤已顺利结束，无需进一步操作。可随时重新运行。</p>
              )}
              {detail.runState === "failed" && (
                <p>任务在当前步骤中断，可检查右侧阻塞原因后选择重试。</p>
              )}
              {detail.runState === "cancelled" && (
                <p>执行已被用户取消，资源锁已释放。</p>
              )}
            </div>
          </div>

          {/* 3. 阻塞时，哪里有问题 */}
          <div className={`status-card ${hasBlockers ? "alert" : ""}`}>
            <div className="card-header">
              <span className={`card-badge ${hasBlockers ? "red" : "gray"}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                {hasBlockers ? (
                  <>
                    <IconAlertTriangle size={12} />
                    <span>阻塞与异常诊断</span>
                  </>
                ) : (
                  <span>无阻塞</span>
                )}
              </span>
            </div>
            <div className="status-content">
              {!hasBlockers && (
                <p style={{ color: "#86868b" }}>执行通畅，无阻塞或异常告警。</p>
              )}

              {detail.waitingReason && (
                <p className="blocker-text">
                  <strong>阻塞原因：</strong>
                  {detail.waitingReason}
                </p>
              )}

              {isWaitingApproval && (
                <div className="approval-action-box">
                  <p>
                    <strong>待审批候选版本：</strong>
                    <code>{snapshot?.flow.candidateCommit?.slice(0, 10)}</code>
                  </p>
                  <textarea
                    rows={2}
                    placeholder="审批批注（若要求修改返工时建议填写）…"
                    value={approvalComment}
                    onChange={(e) => setApprovalComment(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
                    <button
                      className="apple-btn-primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void handleApproval("approved")}
                    >
                      批准通过
                    </button>
                    <button
                      className="apple-btn-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => void handleApproval("rejected")}
                    >
                      要求修改返工
                    </button>
                  </div>
                </div>
              )}

              {detail.errorCode && (
                <p className="blocker-text">
                  <strong>错误码：</strong>
                  <code>{detail.errorCode}</code>
                </p>
              )}

              {snapshot?.flow.reviewHistory.some(
                (r) => r.verdict === "changes_requested"
              ) &&
                phase !== "completed" && (
                  <div className="review-findings-box">
                    <strong>Review 提出的问题：</strong>
                    {snapshot.flow.reviewHistory
                      .flatMap((r) => r.findings)
                      .slice(0, 3)
                      .map((f, i) => (
                        <div key={i} className="finding-item">
                          [{f.severity}] {f.file}:{f.line} - {f.message}
                        </div>
                      ))}
                  </div>
                )}
            </div>
          </div>
        </div>

        {/* Evidence Inspector: Git Diff & Historical Commit Logs & Stdio Logs */}
        <div className="evidence-inspector-card" style={{ marginTop: "20px" }}>
          <div className="evidence-tab-bar">
            <button
              type="button"
              className={activeLogTab === "diff" ? "active" : ""}
              onClick={() => setActiveLogTab("diff")}
            >
              Git Checkpoint 代码 Diff
            </button>
            <button
              type="button"
              className={activeLogTab === "commit_logs" ? "active" : ""}
              onClick={() => setActiveLogTab("commit_logs")}
            >
              历史提交日志 ({treeNodes.length})
            </button>
            <button
              type="button"
              className={activeLogTab === "stdout" ? "active" : ""}
              onClick={() => setActiveLogTab("stdout")}
            >
              Runner 终端日志 (stdout)
            </button>
            <button
              type="button"
              className={activeLogTab === "stderr" ? "active" : ""}
              onClick={() => setActiveLogTab("stderr")}
            >
              错误日志 (stderr)
            </button>
          </div>

          <div className="evidence-panel-content">
            {activeLogTab === "diff" && (
              <div className="diff-view-container">
                {diffText ? (
                  <pre className="apple-code-block">
                    {diffText.split("\n").map((line, idx) => {
                      let cls = "line";
                      if (line.startsWith("+") && !line.startsWith("+++")) cls += " add";
                      else if (line.startsWith("-") && !line.startsWith("---")) cls += " del";
                      else if (line.startsWith("@@")) cls += " meta";
                      return (
                        <div key={idx} className={cls}>
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                ) : (
                  <p style={{ padding: "20px", color: "#86868b", textAlign: "center" }}>
                    暂无代码变动 Diff，在上方 Git 分支树中点击任一 Checkpoint 节点以载入。
                  </p>
                )}
              </div>
            )}

            {activeLogTab === "commit_logs" && (
              <div className="commit-history-list">
                {treeNodes.map((c) => (
                  <div key={c.id} className="commit-history-row">
                    <div className="commit-row-left">
                      <span className="commit-row-sha"><code>{c.shortSha}</code></span>
                      <div className="commit-row-info">
                        <strong>{c.message}</strong>
                        <span className="commit-row-meta">
                          分支：{c.branch} · 提交人：{c.author} · 时间：{c.timestamp}
                        </span>
                      </div>
                    </div>
                    <div className="commit-row-actions">
                      {c.checkpointId && (
                        <button
                          type="button"
                          className="apple-btn-secondary"
                          style={{ fontSize: "11px", padding: "4px 8px" }}
                          onClick={() => void handleSelectCommit(c)}
                        >
                          查看此 Commit Diff
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeLogTab === "stdout" && (
              <pre className="apple-code-block terminal">
                {logs?.stdout || "(尚未捕获到标准输出日志)"}
              </pre>
            )}

            {activeLogTab === "stderr" && (
              <pre className="apple-code-block terminal" style={{ color: "#cf222e" }}>
                {logs?.stderr || "(无异常输出日志)"}
              </pre>
            )}
          </div>
        </div>
      </section>

      {/* Modal: Add Node to Mind Map */}
      {showAddNodeModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowAddNodeModal(false)}>
          <div className="apple-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>向脑图添加功能节点</h3>
            <div className="modal-body-form">
              <label>
                功能担任 (Role)
                <select
                  value={newNodeRole}
                  onChange={(e) => handleRoleSelectChange(e.target.value)}
                >
                  {availableRoles.map((r) => (
                    <option key={r.id} value={r.roleName}>
                      {r.icon} {r.roleName} ({r.description.slice(0, 16)}…)
                    </option>
                  ))}
                </select>
              </label>

              <label>
                节点名称
                <input
                  placeholder="例如：优化 SQL 查询与连接池"
                  value={newNodeLabel}
                  onChange={(e) => setNewNodeLabel(e.target.value)}
                />
              </label>

              <label>
                模型名称
                <select
                  value={newNodeModel}
                  onChange={(e) => setNewNodeModel(e.target.value)}
                >
                  <option value="Claude 3.5 Sonnet">Claude 3.5 Sonnet</option>
                  <option value="GPT-4o">GPT-4o</option>
                  <option value="DeepSeek-R1">DeepSeek-R1</option>
                  <option value="本地仿真模型">本地仿真模型 (Mock Agent)</option>
                </select>
              </label>

              <label>
                推理程度
                <select
                  value={newNodeReasoning}
                  onChange={(e) => setNewNodeReasoning(e.target.value)}
                >
                  <option value="极高 (High Thinking)">极高 (High Thinking)</option>
                  <option value="高 (Standard Deep)">高 (Standard Deep)</option>
                  <option value="中等 (Medium)">中等 (Medium)</option>
                  <option value="快速响应 (Low)">快速响应 (Low)</option>
                </select>
              </label>
            </div>

            <div className="modal-btn-row">
              <button
                className="apple-btn-secondary"
                type="button"
                onClick={() => setShowAddNodeModal(false)}
              >
                取消
              </button>
              <button
                className="apple-btn-primary"
                type="button"
                onClick={handleAddNode}
              >
                添加节点
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
