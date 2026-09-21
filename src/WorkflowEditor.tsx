import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type XYPosition,
  type NodeProps,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  getTaskWorkflow,
  saveTaskWorkflow,
  startTaskWorkflow,
  validateWorkflow,
  createTaskWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowNode,
  type ValidationReport,
} from "./api";

function topologicalPositions(definition: WorkflowDefinition): Record<string, XYPosition> {
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (!incoming.has(edge.source) || !incoming.has(edge.target)) continue;
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }
  const queue = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const rank = new Map(queue.map((id) => [id, 0]));
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const target of outgoing.get(id) || []) {
      rank.set(target, Math.max(rank.get(target) || 0, (rank.get(id) || 0) + 1));
      incoming.set(target, (incoming.get(target) || 0) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  let fallbackRank = Math.max(0, ...rank.values()) + 1;
  for (const node of definition.nodes) {
    if (!visited.has(node.id)) rank.set(node.id, fallbackRank++);
  }
  const lanes = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const nodeRank = rank.get(node.id) || 0;
    lanes.set(nodeRank, [...(lanes.get(nodeRank) || []), node.id]);
  }
  return Object.fromEntries(
    [...lanes.entries()].flatMap(([column, ids]) =>
      ids.map((id, row) => [id, { x: column * 280 + 40, y: row * 150 + 40 }]),
    ),
  );
}

function getProviderShortLabel(providerId?: string): string {
  if (!providerId) return "";
  if (providerId === "provider-cli-agy-1") return "agy · 账号 1";
  if (providerId === "provider-cli-agy-2") return "agy · 账号 2";
  if (providerId === "provider-cli-agy-3") return "agy · 账号 3";
  if (providerId === "provider-cli-codex") return "Codex CLI";
  if (providerId === "mock:default") return "Mock 仿真";
  return providerId;
}

const nodeTypeMeta: Record<
  WorkflowNode["kind"],
  { label: string; dotColor: string }
> = {
  start: { label: "开始", dotColor: "#34c759" },
  agent: { label: "Agent", dotColor: "#a855f7" },
  command: { label: "命令", dotColor: "#0284c7" },
  condition: { label: "分支", dotColor: "#d97706" },
  human_approval: { label: "审批", dotColor: "#ea580c" },
  end: { label: "结束", dotColor: "#71717a" },
};

function getHandleStyle(selected: boolean, position: "left" | "right" | "top" | "bottom" = "right"): React.CSSProperties {
  const isHorizontal = position === "left" || position === "right";
  const size = isHorizontal ? 8 : 6;
  const offset = isHorizontal ? -4 : -3;
  return {
    width: `${size}px`,
    height: `${size}px`,
    background: "#ffffff",
    border: `1.5px solid ${selected ? "#111111" : "#8e8e93"}`,
    borderRadius: "50%",
    [position]: `${offset}px`,
    boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
    zIndex: 10,
    transition: "border-color 0.15s ease, transform 0.15s ease",
  };
}

const kindLabels: Record<WorkflowNode["kind"], string> = {
  start: "开始",
  agent: "Agent 节点",
  command: "执行命令",
  condition: "条件分支",
  human_approval: "人工确认",
  end: "结束",
};

const kindIcons: Record<WorkflowNode["kind"], string> = {
  start: "🟢",
  agent: "🤖",
  command: "⚡",
  condition: "🔀",
  human_approval: "👤",
  end: "🏁",
};

function WorkflowCanvasNode({ data, isConnectable, selected }: NodeProps) {
  const { rawNode: node, providerId } = data as {
    rawNode: WorkflowNode;
    providerId?: string;
    providerLabel?: string;
  };

  // Start & End nodes: Sleek, compact capsule design
  if (node.kind === "start" || node.kind === "end") {
    const isStart = node.kind === "start";
    return (
      <div
        className={`workflow-canvas-node ${selected ? "selected" : ""}`}
        style={{
          background: "#ffffff",
          border: `1.5px solid ${selected ? "#111111" : "#e5e5ea"}`,
          borderRadius: "20px",
          color: "#111111",
          width: 96,
          height: 34,
          boxSizing: "border-box",
          padding: "0 12px",
          boxShadow: selected
            ? "0 0 0 2px rgba(17, 17, 17, 0.12), 0 4px 12px rgba(0, 0, 0, 0.06)"
            : "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)",
          position: "relative",
          transition: "all 0.15s ease",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "6px",
        }}
      >
        {isStart && (
          <Handle
            type="source"
            position={Position.Right}
            isConnectable={isConnectable}
            style={getHandleStyle(selected, "right")}
          />
        )}
        {!isStart && (
          <Handle
            type="target"
            position={Position.Left}
            isConnectable={isConnectable}
            style={getHandleStyle(selected, "left")}
          />
        )}
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: isStart ? "#34c759" : "#71717a",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: "12px", fontWeight: 600, color: "#111111", letterSpacing: "-0.01em" }}>
          {node.label || (isStart ? "开始" : "结束")}
        </span>
      </div>
    );
  }

  const meta = nodeTypeMeta[node.kind] ?? { label: node.kind, dotColor: "#64748b" };
  const shortProvider = getProviderShortLabel(providerId);
  const roleId = node.role || "executor";
  const displayAgentInfo = `${roleId} · ${shortProvider || "未配置"}`;

  return (
    <div
      className={`workflow-canvas-node ${selected ? "selected" : ""}`}
      style={{
        background: "#ffffff",
        border: `1.5px solid ${selected ? "#111111" : "#e5e5ea"}`,
        borderRadius: "10px",
        color: "#111111",
        width: 210,
        boxSizing: "border-box",
        boxShadow: selected
          ? "0 0 0 2px rgba(17, 17, 17, 0.12), 0 6px 18px rgba(0, 0, 0, 0.06)"
          : "0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02)",
        position: "relative",
        transition: "all 0.15s ease",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        padding: "10px 12px",
        textAlign: "left",
      }}
    >
      {/* Target handle (Left) */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={isConnectable}
        style={getHandleStyle(selected, "left")}
      />
      {/* Source handle (Right) */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={isConnectable}
        style={getHandleStyle(selected, "right")}
      />
      {/* Top Handle - for rework loops */}
      <Handle
        type="target"
        id="top"
        position={Position.Top}
        isConnectable={isConnectable}
        style={getHandleStyle(selected, "top")}
      />
      {/* Bottom Handle - for rework / branching */}
      <Handle
        type="source"
        id="bottom"
        position={Position.Bottom}
        isConnectable={isConnectable}
        style={getHandleStyle(selected, "bottom")}
      />

      {/* Header: Dot + Type label */}
      <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "5px" }}>
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: meta.dotColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: "10.5px",
            fontWeight: 600,
            color: "#8e8e93",
            letterSpacing: "0.03em",
            textTransform: "uppercase",
          }}
        >
          {meta.label}
        </span>
      </div>

      {/* Node Title */}
      <div
        style={{
          fontWeight: 600,
          fontSize: "13px",
          color: "#111111",
          lineHeight: 1.35,
          letterSpacing: "-0.01em",
          marginBottom: "6px",
          wordBreak: "break-word",
        }}
      >
        {node.label}
      </div>

      {/* Essential Sub-Context */}
      {node.kind === "agent" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            fontSize: "11px",
            color: "#0071e3",
            background: "#f0f7ff",
            border: "1px solid #d0e7ff",
            padding: "2px 6px",
            borderRadius: "4px",
            maxWidth: "100%",
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: "10px" }}>⚡</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayAgentInfo}
          </span>
        </div>
      )}

      {node.kind === "command" && node.command && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontSize: "11px",
            fontFamily: "var(--apple-font-mono, monospace)",
            color: "#0284c7",
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            padding: "2px 6px",
            borderRadius: "4px",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.command.program} {node.command.arguments.join(" ")}
        </div>
      )}

      {node.kind === "condition" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontSize: "11px",
            color: "#92400e",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            padding: "2px 6px",
            borderRadius: "4px",
            fontWeight: 500,
          }}
        >
          条件分支
        </div>
      )}

      {node.kind === "human_approval" && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            fontSize: "11px",
            color: "#9a3412",
            background: "#fff7ed",
            border: "1px solid #fed7aa",
            padding: "2px 6px",
            borderRadius: "4px",
            fontWeight: 500,
          }}
        >
          需人工审批
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  workflowNode: WorkflowCanvasNode,
};

function workflowToFlow(definition: WorkflowDefinition, savedPositions: Record<string, XYPosition> = {}) {
  const automaticPositions = topologicalPositions(definition);
  const nodes: Node[] = definition.nodes.map((node, index) => {
    const providerId = node.role ? definition.roleBindings[node.role] : undefined;
    const providerObj = AVAILABLE_AGENT_PROVIDERS.find((p) => p.id === providerId);
    return {
      id: node.id,
      type: "workflowNode",
      position: savedPositions[node.id] || automaticPositions[node.id] || { x: index * 280 + 40, y: 40 },
      data: {
        rawNode: node,
        providerId,
        providerLabel: providerObj?.label ?? (providerId ? providerId : undefined),
      },
    };
  });

  const edges: Edge[] = definition.edges.map((edge) => {
    const isRepeatBack = definition.repeatBlocks.some((rb) => rb.backEdgeId === edge.id);
    let label = edge.isDefault ? "默认" : "";
    if (edge.predicate) {
      label = `${edge.predicate.field} ${edge.predicate.operator} ${JSON.stringify(edge.predicate.expected)}`;
    }
    if (isRepeatBack) {
      label = `[返工循环] ${label}`;
    }

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: label || undefined,
      animated: isRepeatBack,
      style: {
        stroke: isRepeatBack ? "#d97706" : edge.isDefault ? "#8e8e93" : "#0071e3",
        strokeWidth: isRepeatBack ? 2 : 1.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: isRepeatBack ? "#d97706" : edge.isDefault ? "#8e8e93" : "#0071e3",
      },
      labelStyle: {
        fill: isRepeatBack ? "#92400e" : "#636366",
        fontSize: 10,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: "#ffffff",
        stroke: "#e5e5ea",
        strokeWidth: 1,
        rx: 4,
        ry: 4,
      },
      labelBgPadding: [4, 6] as [number, number],
    };
  });

  return { nodes, edges };
}

interface Props {
  runId: string;
  onStarted: () => Promise<void> | void;
  onForkDraft?: (newRunId: string) => void;
}

export interface SystemRoleDefinition {
  id: string;
  name: string;
  description: string;
  defaultProviderId: string;
}

export const SYSTEM_BUILTIN_ROLES: SystemRoleDefinition[] = [
  { id: "executor", name: "执行者 (Executor)", description: "主力代码实现与任务交付", defaultProviderId: "provider-cli-agy-1" },
  { id: "reviewer", name: "审查者 (Reviewer)", description: "代码审查、质量校验与规范审计", defaultProviderId: "provider-cli-codex" },
  { id: "planner", name: "规划者 (Planner)", description: "需求拆解、架构推演与步骤规划", defaultProviderId: "provider-cli-agy-1" },
  { id: "tester", name: "测试者 (Tester)", description: "自动化测试、用例设计与边界验证", defaultProviderId: "provider-cli-agy-2" },
  { id: "researcher", name: "研究者 (Researcher)", description: "技术调研、依赖比选与文档探查", defaultProviderId: "provider-cli-agy-3" },
  { id: "refactorer", name: "重构者 (Refactorer)", description: "坏味道清理、架构优化与性能调优", defaultProviderId: "provider-cli-codex" },
  { id: "orchestrator", name: "协调者 (Orchestrator)", description: "多智能体分工协调与进度把控", defaultProviderId: "provider-cli-agy-1" },
  { id: "documenter", name: "文档者 (Documenter)", description: "技术文档整理、接口说明与变更日志", defaultProviderId: "provider-cli-agy-1" },
];

const AVAILABLE_AGENT_PROVIDERS = [
  { id: "provider-cli-agy-1", label: "Google agy (账号 1 - 主账号)" },
  { id: "provider-cli-agy-2", label: "Google agy (账号 2)" },
  { id: "provider-cli-agy-3", label: "Google agy (账号 3)" },
  { id: "provider-cli-codex", label: "OpenAI Codex CLI (codex)" },
  { id: "mock:default", label: "Mock Agent / 仿真执行" },
];

export function WorkflowEditor({ runId, onStarted, onForkDraft }: Props) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "node" | "edge"; id: string; label: string } | null>(null);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [revision, setRevision] = useState(1);

  // Node editing state
  const [editLabel, setEditLabel] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editProvider, setEditProvider] = useState("provider-cli-agy-1");
  const [customRoleMode, setCustomRoleMode] = useState(false);
  const [editInputs, setEditInputs] = useState("");
  const [editProgram, setEditProgram] = useState("npm");
  const [editArguments, setEditArguments] = useState("test");
  const [editResultKind, setEditResultKind] = useState<"test" | "structured" | "generic">("test");

  // Edge editing state
  const [edgeIsDefault, setEdgeIsDefault] = useState(true);
  const [edgeHasPredicate, setEdgeHasPredicate] = useState(false);
  const [edgeField, setEdgeField] = useState("outcome");
  const [edgeOperator, setEdgeOperator] = useState<"equals" | "not_equals" | "exists" | "does_not_exist">("equals");
  const [edgeExpected, setEdgeExpected] = useState("succeeded");
  const [edgeIsRework, setEdgeIsRework] = useState(false);
  const [edgeMaxIterations, setEdgeMaxIterations] = useState(3);

  // Role bindings modal state
  const [showRoleBindingsModal, setShowRoleBindingsModal] = useState(false);
  const [tempRoleBindings, setTempRoleBindings] = useState<Record<string, string>>({});
  const [newRoleName, setNewRoleName] = useState("");

  const loadWorkflow = useCallback((def: WorkflowDefinition, positions: Record<string, XYPosition> = {}) => {
    setDefinition(def);
    const flow = workflowToFlow(def, positions);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedNode(null);
    setSelectedEdgeId(null);
  }, [setNodes, setEdges]);

  useEffect(() => {
    void getTaskWorkflow(runId).then((record) => {
      loadWorkflow(record.definition, record.layout);
      setEditable(record.status === "draft");
      setRevision(record.revision);
    }).catch((error) => setMessage(`读取任务工作流失败：${String(error)}`));
  }, [loadWorkflow, runId]);

  useEffect(() => {
    if (selectedNode) {
      setEditLabel(selectedNode.label);
      const role = selectedNode.role ?? "";
      setEditRole(role);
      setCustomRoleMode(false);
      const provider = (role && definition?.roleBindings[role]) || "provider-cli-agy-1";
      setEditProvider(provider);
      setEditInputs(selectedNode.requiredInputs.join(", "));
      if (selectedNode.command) {
        setEditProgram(selectedNode.command.program);
        setEditArguments(selectedNode.command.arguments.join(" "));
        setEditResultKind(selectedNode.command.resultKind);
      } else {
        setEditProgram("npm");
        setEditArguments("test");
        setEditResultKind("test");
      }
    }
  }, [selectedNode, definition]);

  useEffect(() => {
    if (selectedEdgeId && definition) {
      const edge = definition.edges.find((e) => e.id === selectedEdgeId);
      if (edge) {
        setEdgeIsDefault(edge.isDefault);
        if (edge.predicate) {
          setEdgeHasPredicate(true);
          setEdgeField(edge.predicate.field);
          setEdgeOperator(edge.predicate.operator);
          setEdgeExpected(
            typeof edge.predicate.expected === "string"
              ? edge.predicate.expected
              : JSON.stringify(edge.predicate.expected ?? "")
          );
        } else {
          setEdgeHasPredicate(false);
          setEdgeField("outcome");
          setEdgeOperator("equals");
          setEdgeExpected("succeeded");
        }
        const rework = definition.repeatBlocks.find((rb) => rb.backEdgeId === edge.id);
        setEdgeIsRework(Boolean(rework));
        setEdgeMaxIterations(rework?.maxIterations ?? 3);
      }
    }
  }, [selectedEdgeId, definition]);

  const handleValidate = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await validateWorkflow(definition);
      setValidation(report);
      if (report.valid) {
        setMessage("工作流结构合法，各项依赖与拓扑校验均已通过。");
      }
    } catch (err) {
      setMessage(`校验异常：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const currentLayout = () => Object.fromEntries(nodes.map((node) => [node.id, node.position]));

  const handleSave = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const record = await saveTaskWorkflow(runId, definition, currentLayout());
      setRevision(record.revision);
      setMessage("已保存到当前任务。启动前仍可继续修改。");
    } catch (err) {
      setMessage(`保存失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await validateWorkflow(definition);
      setValidation(report);
      if (!report.valid) {
        setMessage("工作流未通过 Rust 校验，修正后才能启动。");
        return;
      }
      const saved = await saveTaskWorkflow(runId, definition, currentLayout());
      setRevision(saved.revision);
      await startTaskWorkflow(runId);
      setEditable(false);
      setMessage("工作流已冻结并开始执行。后续执行严格使用这个版本。");
      await onStarted();
    } catch (err) {
      setMessage(`启动失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveNodeEdit = () => {
    if (!definition || !selectedNode) return;
    let finalRole = selectedNode.role;
    let updatedRoleBindings = { ...definition.roleBindings };

    if (selectedNode.kind === "agent") {
      finalRole = editRole.trim() || selectedNode.role || "executor";
      updatedRoleBindings[finalRole] = editProvider;
    }

    const updatedNodes = definition.nodes.map((n) => {
      if (n.id === selectedNode.id) {
        return {
          ...n,
          label: editLabel.trim() || n.label,
          role: n.kind === "agent" ? finalRole : n.role,
          command: n.kind === "command" ? {
            program: editProgram.trim() || "npm",
            arguments: editArguments.split(" ").map((s) => s.trim()).filter(Boolean),
            resultKind: editResultKind,
          } : n.command,
          requiredInputs: editInputs.split(",").map((s) => s.trim()).filter(Boolean),
        };
      }
      return n;
    });

    const newDef: WorkflowDefinition = {
      ...definition,
      nodes: updatedNodes,
      roleBindings: updatedRoleBindings,
    };
    loadWorkflow(newDef);
    setMessage(`节点 ${selectedNode.id} 属性与 Agent 配置已更新。`);
  };

  const handleSaveEdgeEdit = () => {
    if (!definition || !selectedEdgeId) return;
    const currentEdge = definition.edges.find((e) => e.id === selectedEdgeId);
    if (!currentEdge) return;

    let parsedExpected: unknown = edgeExpected;
    if (edgeExpected === "true") parsedExpected = true;
    else if (edgeExpected === "false") parsedExpected = false;
    else if (!Number.isNaN(Number(edgeExpected)) && edgeExpected.trim() !== "") {
      parsedExpected = Number(edgeExpected);
    }

    const updatedEdges = definition.edges.map((e) => {
      if (e.id === selectedEdgeId) {
        return {
          ...e,
          isDefault: edgeIsDefault,
          predicate: edgeHasPredicate ? {
            field: edgeField.trim() || "outcome",
            operator: edgeOperator,
            expected: parsedExpected,
          } : null,
        };
      }
      return e;
    });

    let updatedRepeatBlocks = definition.repeatBlocks.filter((rb) => rb.backEdgeId !== selectedEdgeId);
    if (edgeIsRework) {
      updatedRepeatBlocks.push({
        id: `rework_${selectedEdgeId}`,
        nodeIds: [currentEdge.source, currentEdge.target],
        entryNodeId: currentEdge.target,
        exitNodeId: currentEdge.source,
        backEdgeId: selectedEdgeId,
        maxIterations: Math.max(1, edgeMaxIterations),
      });
    }

    const newDef: WorkflowDefinition = {
      ...definition,
      edges: updatedEdges,
      repeatBlocks: updatedRepeatBlocks,
    };
    loadWorkflow(newDef);
    setMessage(`连线 ${selectedEdgeId} 属性与流转规则已更新。`);
  };

  const handleDeleteNode = (nodeId: string) => {
    if (!definition) return;
    const target = definition.nodes.find((n) => n.id === nodeId);
    if (target?.kind === "start" || target?.kind === "end") {
      setMessage("开始和结束节点为工作流拓扑锚点，不可删除。");
      return;
    }
    const newNodes = definition.nodes.filter((n) => n.id !== nodeId);
    const newEdges = definition.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    const newDef: WorkflowDefinition = {
      ...definition,
      nodes: newNodes,
      edges: newEdges,
    };
    loadWorkflow(newDef);
    setSelectedNode(null);
    setMessage(`节点 ${nodeId} 已从画布移除。`);
  };

  const handleDeleteEdge = (edgeId: string) => {
    if (!definition) return;
    const next = {
      ...definition,
      edges: definition.edges.filter((edge) => edge.id !== edgeId),
      repeatBlocks: definition.repeatBlocks.filter((rb) => rb.backEdgeId !== edgeId),
    };
    loadWorkflow(next);
    setSelectedEdgeId(null);
    setMessage(`连线 ${edgeId} 已从画布移除。`);
  };

  const handleConnect = (connection: Connection) => {
    if (!definition || !connection.source || !connection.target || connection.source === connection.target) return;
    if (definition.edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) {
      setMessage("该连线已存在。");
      return;
    }
    const edgeId = `edge_${connection.source}_${connection.target}_${Date.now()}`;
    const next: WorkflowDefinition = {
      ...definition,
      edges: [...definition.edges, {
        id: edgeId,
        source: connection.source,
        target: connection.target,
        isDefault: true,
        predicate: null,
      }],
    };
    loadWorkflow(next);
    setSelectedEdgeId(edgeId);
    setMessage("已添加连线，可点击连线配置流转条件或返工循环。");
  };

  const handleAutoLayout = () => {
    if (!definition) return;
    const positions = topologicalPositions(definition);
    const arranged = nodes.map((node) => ({ ...node, position: positions[node.id] || node.position }));
    setNodes(arranged);
    setMessage("已按执行依赖自动排列。");
  };

  const handleAddNode = (kind: WorkflowNode["kind"]) => {
    if (!definition) return;
    const newId = `node_${kind}_${Date.now()}`;
    const defaultRole = kind === "agent"
      ? (Object.keys(definition.roleBindings)[0] || "executor")
      : null;
    const newRoleBindings = { ...definition.roleBindings };
    if (kind === "agent" && defaultRole && !newRoleBindings[defaultRole]) {
      newRoleBindings[defaultRole] = "provider-cli-agy-1";
    }
    const newNode: WorkflowNode = {
      id: newId,
      version: 1,
      kind,
      label: `新 ${kindLabels[kind]}`,
      role: defaultRole,
      command: kind === "command" ? { program: "npm", arguments: ["test"], resultKind: "test" } : null,
      requiredInputs: [],
    };
    const newDef: WorkflowDefinition = {
      ...definition,
      nodes: [...definition.nodes, newNode],
      roleBindings: newRoleBindings,
    };
    loadWorkflow(newDef);
    setSelectedNode(newNode);
    setMessage(`已添加新节点: ${newNode.label}`);
  };

  const openRoleBindings = () => {
    if (!definition) return;
    setTempRoleBindings({ ...(definition.roleBindings || {}) });
    setNewRoleName("");
    setShowRoleBindingsModal(true);
  };

  const handleSaveRoleBindings = () => {
    if (!definition) return;
    const newDef: WorkflowDefinition = {
      ...definition,
      roleBindings: tempRoleBindings,
    };
    loadWorkflow(newDef);
    setShowRoleBindingsModal(false);
    setMessage("角色与 Agent 映射配置已更新。");
  };

  const handleAddRole = () => {
    const clean = newRoleName.trim();
    if (!clean) return;
    if (tempRoleBindings[clean]) {
      setMessage(`角色 ${clean} 已存在。`);
      return;
    }
    setTempRoleBindings((prev) => ({ ...prev, [clean]: "provider-cli-agy-1" }));
    setNewRoleName("");
  };

  const handleDeleteRole = (roleKey: string) => {
    setTempRoleBindings((prev) => {
      const next = { ...prev };
      delete next[roleKey];
      return next;
    });
  };

  const selectedEdgeObj = selectedEdgeId && definition
    ? definition.edges.find((e) => e.id === selectedEdgeId)
    : null;
  const sourceNodeObj = selectedEdgeObj
    ? definition?.nodes.find((n) => n.id === selectedEdgeObj.source)
    : null;
  const targetNodeObj = selectedEdgeObj
    ? definition?.nodes.find((n) => n.id === selectedEdgeObj.target)
    : null;

  const handleForkDraft = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const newDraft = await createTaskWorkflowDraft({
        title: `[草稿] ${definition.name || "任务工作流"}`,
        description: "基于此工作流复制的新编辑草稿",
        acceptanceCriteria: ["按工作流完成全部节点"],
      });
      await saveTaskWorkflow(newDraft.runId, definition, currentLayout());
      setMessage("已成功创建新草稿！即将切换到可编辑视图…");
      if (onForkDraft) {
        onForkDraft(newDraft.runId);
      }
    } catch (err) {
      setMessage(`创建新草稿失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    if (!editable || !definition) return;
    const hasProtected = deletedNodes.some((dn) => {
      const raw = (dn.data as { rawNode?: WorkflowNode }).rawNode;
      return raw?.kind === "start" || raw?.kind === "end";
    });
    if (hasProtected) {
      setMessage("开始和结束节点为工作流拓扑锚点，不可删除。");
      return;
    }
    const deletedIds = new Set(deletedNodes.map((n) => n.id));
    const nextNodes = definition.nodes.filter((n) => !deletedIds.has(n.id));
    const nextEdges = definition.edges.filter((e) => !deletedIds.has(e.source) && !deletedIds.has(e.target));
    const nextDef: WorkflowDefinition = {
      ...definition,
      nodes: nextNodes,
      edges: nextEdges,
    };
    loadWorkflow(nextDef);
    setSelectedNode(null);
    setMessage(`已删除 ${deletedNodes.length} 个节点及关联连线。`);
  }, [editable, definition, loadWorkflow]);

  const onEdgesDelete = useCallback((deletedEdges: Edge[]) => {
    if (!editable || !definition) return;
    const deletedIds = new Set(deletedEdges.map((e) => e.id));
    const nextEdges = definition.edges.filter((e) => !deletedIds.has(e.id));
    const nextRepeatBlocks = definition.repeatBlocks.filter((rb) => !deletedIds.has(rb.backEdgeId));
    const nextDef: WorkflowDefinition = {
      ...definition,
      edges: nextEdges,
      repeatBlocks: nextRepeatBlocks,
    };
    loadWorkflow(nextDef);
    setSelectedEdgeId(null);
    setMessage(`已删除 ${deletedEdges.length} 条连线。`);
  }, [editable, definition, loadWorkflow]);

  return (
    <div className="workflow-view">
      <div className="workflow-studio-bar">
        <div className="studio-bar-top">
          <div className="studio-info-group">
            <span className="workflow-mode-tag">
              {editable ? "✨ 草稿编辑" : "🔒 只读归档"}
            </span>
            <span className="studio-stats-text">
              第 {revision} 版 · {definition?.nodes.length ?? 0} 节点 · {definition?.edges.length ?? 0} 连线
            </span>
          </div>

          <div className="studio-actions-group">
            <button className="apple-btn-secondary studio-btn" type="button" onClick={openRoleBindings} title="配置角色与本地 Agent 的映射">
              👥 角色映射 ({Object.keys(definition?.roleBindings ?? {}).length})
            </button>
            <button className="apple-btn-secondary studio-btn" type="button" disabled={busy} onClick={() => void handleValidate()}>
              验证合法性
            </button>
            {editable ? (
              <>
                <button className="apple-btn-secondary studio-btn" type="button" disabled={busy} onClick={() => void handleSave()}>
                  保存草稿
                </button>
                <button className="apple-btn-primary studio-btn" type="button" disabled={busy} onClick={() => void handleStart()}>
                  {busy ? "处理中…" : "保存并启动"}
                </button>
              </>
            ) : (
              <button
                className="apple-btn-primary studio-btn"
                type="button"
                disabled={busy}
                onClick={() => void handleForkDraft()}
                title="复制当前工作流为新草稿以便编辑"
              >
                📋 复制为新草稿
              </button>
            )}
          </div>
        </div>

        {editable && (
          <div className="studio-bar-bottom">
            <div className="studio-quick-nodes">
              <span className="quick-label">快速添加:</span>
              <button className="secondary-sm" type="button" onClick={() => handleAddNode("agent")}>+ 🤖 Agent</button>
              <button className="secondary-sm" type="button" onClick={() => handleAddNode("command")}>+ ⚡ Command</button>
              <button className="secondary-sm" type="button" onClick={() => handleAddNode("condition")}>+ 🔀 Condition</button>
              <button className="secondary-sm" type="button" onClick={() => handleAddNode("human_approval")}>+ 👤 人工确认</button>
              <button className="secondary-sm" type="button" onClick={() => handleAddNode("end")}>+ 🏁 结束</button>
              <button className="secondary-sm auto-layout-btn" type="button" onClick={handleAutoLayout}>⚡ 自动排列</button>
            </div>
            <span className="studio-tip-text">
              💡 拖动节点右侧圆点连线 · Backspace 删除
            </span>
          </div>
        )}
      </div>

      {!editable && (
        <div className="readonly-workflow-banner">
          <div className="readonly-banner-info">
            <span className="readonly-badge">只读快照</span>
            <span className="readonly-desc">
              当前任务已启动或已完成，工作流已冻结归档以保证执行可追溯。如需调整节点或流转规则，请点击右侧「复制为新草稿」。
            </span>
          </div>
          <button
            className="apple-btn-primary fork-btn"
            type="button"
            disabled={busy}
            onClick={() => void handleForkDraft()}
          >
            📋 复制为新草稿
          </button>
        </div>
      )}

      {message && (
        <div className="workflow-floating-toast">
          <span>{message}</span>
        </div>
      )}

      {validation && (
        <div className={`validation-box ${validation.valid ? "valid" : "invalid"}`}>
          <strong>{validation.valid ? "✓ 校验通过：符合不可变图约束" : "✕ 存在校验问题："}</strong>
          {validation.issues.length > 0 && (
            <ul>
              {validation.issues.map((issue, idx) => (
                <li key={idx}>
                  <code>[{issue.code}]</code> {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="workflow-container">
        <div className="flow-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={editable ? handleConnect : undefined}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              const raw = (node.data as { rawNode?: WorkflowNode }).rawNode;
              if (raw) {
                setSelectedNode(raw);
                setSelectedEdgeId(null);
              }
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNode(null);
            }}
            deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable={true}
            proOptions={{ hideAttribution: true }}
            fitView
          >
            <Background color="#eaeaea" gap={20} size={1.2} />
            <Controls />
            <MiniMap
              nodeStrokeColor="#111111"
              nodeColor="#f5f5f7"
              style={{ background: "#ffffff", border: "1px solid #eaeaea", borderRadius: "8px", boxShadow: "0 2px 8px rgba(0,0,0,0.05)" }}
            />
          </ReactFlow>
        </div>

        {/* Node Inspector */}
        {selectedNode && (
          <aside className="node-inspector">
            <div className="panel-heading">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3>节点属性</h3>
                {!editable && <span style={{ fontSize: "10px", color: "#8e8e93", background: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: "4px" }}>只读</span>}
              </div>
              <button className="close-btn" type="button" onClick={() => setSelectedNode(null)}>
                ✕
              </button>
            </div>

            <div className="inspector-meta-box">
              <div className="inspector-meta-row">
                <span className="inspector-meta-key">节点 ID</span>
                <code className="inspector-meta-code" title={selectedNode.id}>{selectedNode.id}</code>
              </div>
              <div className="inspector-meta-row">
                <span className="inspector-meta-key">节点类型</span>
                <span className="inspector-meta-val">
                  <span style={{ marginRight: 4 }}>{kindIcons[selectedNode.kind]}</span>
                  {kindLabels[selectedNode.kind]}
                </span>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (editable) handleSaveNodeEdit();
              }}
              className="inspector-form"
            >
              <label>
                <span>显示名称</span>
                <input
                  disabled={!editable}
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </label>

              {selectedNode.kind === "agent" && (
                <>
                  <label>
                    <span>调用执行 Agent (CLI)</span>
                    <select
                      disabled={!editable}
                      value={editProvider}
                      onChange={(e) => setEditProvider(e.target.value)}
                    >
                      {AVAILABLE_AGENT_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span>工作流角色 (Role)</span>
                    <select
                      disabled={!editable}
                      value={customRoleMode ? "__custom__" : (editRole || "executor")}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "__custom__") {
                          setCustomRoleMode(true);
                          setEditRole("");
                        } else {
                          setCustomRoleMode(false);
                          setEditRole(val);
                          if (definition?.roleBindings[val]) {
                            setEditProvider(definition.roleBindings[val]);
                          } else {
                            const builtin = SYSTEM_BUILTIN_ROLES.find((r) => r.id === val);
                            if (builtin) {
                              setEditProvider(builtin.defaultProviderId);
                            }
                          }
                        }
                      }}
                    >
                      <optgroup label="系统内置角色 (Built-in Roles)">
                        {SYSTEM_BUILTIN_ROLES.map((role) => {
                          const boundProviderId = definition?.roleBindings[role.id] || role.defaultProviderId;
                          const providerLabel = AVAILABLE_AGENT_PROVIDERS.find((p) => p.id === boundProviderId)?.label.replace(/ \(账号.*/, '') || boundProviderId;
                          return (
                            <option key={role.id} value={role.id}>
                              {role.name} · {providerLabel}
                            </option>
                          );
                        })}
                      </optgroup>
                      {Object.keys(definition?.roleBindings ?? {}).filter((k) => !SYSTEM_BUILTIN_ROLES.some((r) => r.id === k)).length > 0 && (
                        <optgroup label="已自定义角色 (Custom Roles)">
                          {Object.keys(definition?.roleBindings ?? {})
                            .filter((k) => !SYSTEM_BUILTIN_ROLES.some((r) => r.id === k))
                            .map((role) => {
                              const boundProviderId = definition?.roleBindings[role];
                              const providerLabel = AVAILABLE_AGENT_PROVIDERS.find((p) => p.id === boundProviderId)?.label.replace(/ \(账号.*/, '') || boundProviderId || "未配置";
                              return (
                                <option key={role} value={role}>
                                  {role} · {providerLabel}
                                </option>
                              );
                            })}
                        </optgroup>
                      )}
                      <option value="__custom__">➕ 新建自定义角色...</option>
                    </select>
                  </label>

                  {customRoleMode && (
                    <label style={{ marginTop: "-4px" }}>
                      <span>新角色标识名称</span>
                      <input
                        disabled={!editable}
                        value={editRole}
                        onChange={(e) => setEditRole(e.target.value.trim().toLowerCase())}
                        placeholder="例如: architect, security_officer"
                        autoFocus
                      />
                    </label>
                  )}

                  <div className="inspector-tip-box blue" style={{ fontSize: "11px", lineHeight: "1.4", margin: "4px 0 8px 0" }}>
                    🤖 当前角色 <strong>{SYSTEM_BUILTIN_ROLES.find(r => r.id === editRole)?.name || editRole || "未命名"}</strong> 将在执行时调用：
                    <div style={{ marginTop: "2px", fontWeight: 600 }}>
                      {AVAILABLE_AGENT_PROVIDERS.find((p) => p.id === editProvider)?.label || editProvider}
                    </div>
                  </div>
                </>
              )}

              {selectedNode.kind === "command" && (
                <>
                  <label>
                    <span>执行程序 (Program)</span>
                    <input
                      disabled={!editable}
                      value={editProgram}
                      onChange={(e) => setEditProgram(e.target.value)}
                      placeholder="如: npm, cargo, pytest"
                    />
                  </label>
                  <label>
                    <span>命令参数 (Arguments)</span>
                    <input
                      disabled={!editable}
                      value={editArguments}
                      onChange={(e) => setEditArguments(e.target.value)}
                      placeholder="如: test -- --nocapture"
                    />
                  </label>
                  <label>
                    <span>结果判定类型</span>
                    <select
                      disabled={!editable}
                      value={editResultKind}
                      onChange={(e) => setEditResultKind(e.target.value as any)}
                    >
                      <option value="test">测试用例断言 (Test)</option>
                      <option value="structured">结构化 JSON 输出 (Structured)</option>
                      <option value="generic">通用命令返回码 (Generic)</option>
                    </select>
                  </label>
                </>
              )}

              {selectedNode.kind === "condition" && (
                <div className="inspector-tip-box amber">
                  💡 条件分支由出边（Edge）的谓词表达式控制。请点击从该节点连出的连线配置流转条件。
                </div>
              )}

              {selectedNode.kind === "human_approval" && (
                <div className="inspector-tip-box orange">
                  💡 人工确认节点执行到此处时自动挂起，并在任务界面展示审批工具栏，支持人工批准或拒绝。
                </div>
              )}

              {(selectedNode.kind === "start" || selectedNode.kind === "end") && (
                <div className="inspector-tip-box green">
                  🔒 此节点是工作流不可或缺的拓扑边界。
                </div>
              )}

              <label>
                <span>必需输入项 (逗号分隔)</span>
                <input
                  disabled={!editable}
                  value={editInputs}
                  onChange={(e) => setEditInputs(e.target.value)}
                  placeholder="如: candidateCommit, iteration"
                />
              </label>

              {editable ? (
                <div className="inspector-actions-row">
                  <button className="apple-btn-primary inspector-save-btn" type="submit">
                    更新节点属性
                  </button>
                  {selectedNode.kind !== "start" && selectedNode.kind !== "end" && (
                    <button
                      className="apple-btn-danger-outline"
                      type="button"
                      onClick={() => setPendingDelete({ kind: "node", id: selectedNode.id, label: selectedNode.label })}
                    >
                      删除节点
                    </button>
                  )}
                </div>
              ) : (
                <small style={{ color: "#8e8e93", marginTop: "4px" }}>工作流已冻结，节点属性处于只读状态。</small>
              )}
            </form>
          </aside>
        )}

        {/* Edge Inspector */}
        {selectedEdgeId && (
          <aside className="node-inspector">
            <div className="panel-heading">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3>连线配置</h3>
                {!editable && <span style={{ fontSize: "10px", color: "#8e8e93", background: "rgba(0,0,0,0.05)", padding: "1px 6px", borderRadius: "4px" }}>只读</span>}
              </div>
              <button className="close-btn" type="button" onClick={() => setSelectedEdgeId(null)}>✕</button>
            </div>

            <div className="inspector-meta-box">
              <div className="inspector-meta-row">
                <span className="inspector-meta-key">连线 ID</span>
                <code className="inspector-meta-code" title={selectedEdgeId}>{selectedEdgeId}</code>
              </div>
              <div className="inspector-meta-row">
                <span className="inspector-meta-key">流转关系</span>
                <span className="inspector-meta-val" style={{ fontSize: "11px" }}>
                  {sourceNodeObj?.label || selectedEdgeObj?.source} ➔ {targetNodeObj?.label || selectedEdgeObj?.target}
                </span>
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (editable) handleSaveEdgeEdit();
              }}
              className="inspector-form"
            >
              <label className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={edgeIsDefault}
                  onChange={(e) => setEdgeIsDefault(e.target.checked)}
                />
                <span>作为默认流向分支 (Default Branch)</span>
              </label>

              <label className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={edgeHasPredicate}
                  onChange={(e) => setEdgeHasPredicate(e.target.checked)}
                />
                <span>启用条件判断 (Predicate)</span>
              </label>

              {edgeHasPredicate && (
                <div className="inspector-predicate-box">
                  <label>
                    <span>判断字段 (Field Path)</span>
                    <input
                      disabled={!editable}
                      value={edgeField}
                      onChange={(e) => setEdgeField(e.target.value)}
                      placeholder="如: outcome, facts.status"
                    />
                  </label>
                  <label>
                    <span>比较操作符 (Operator)</span>
                    <select
                      disabled={!editable}
                      value={edgeOperator}
                      onChange={(e) => setEdgeOperator(e.target.value as any)}
                    >
                      <option value="equals">等于 (equals)</option>
                      <option value="not_equals">不等于 (not_equals)</option>
                      <option value="exists">存在该字段 (exists)</option>
                      <option value="does_not_exist">不存在该字段 (does_not_exist)</option>
                    </select>
                  </label>
                  {edgeOperator !== "exists" && edgeOperator !== "does_not_exist" && (
                    <label>
                      <span>期望值 (Expected)</span>
                      <input
                        disabled={!editable}
                        value={edgeExpected}
                        onChange={(e) => setEdgeExpected(e.target.value)}
                        placeholder="如: succeeded, failed, true"
                      />
                    </label>
                  )}
                </div>
              )}

              <label className="inspector-checkbox-label">
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={edgeIsRework}
                  onChange={(e) => setEdgeIsRework(e.target.checked)}
                />
                <span>标记为返工循环回路 (Rework Loop)</span>
              </label>

              {edgeIsRework && (
                <label>
                  <span>最大返工重试次数 (Max Iterations)</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    disabled={!editable}
                    value={edgeMaxIterations}
                    onChange={(e) => setEdgeMaxIterations(parseInt(e.target.value, 10) || 3)}
                  />
                </label>
              )}

              {editable ? (
                <div className="inspector-actions-row">
                  <button className="apple-btn-primary inspector-save-btn" type="submit">
                    更新连线配置
                  </button>
                  <button
                    className="apple-btn-danger-outline"
                    type="button"
                    onClick={() => setPendingDelete({ kind: "edge", id: selectedEdgeId, label: selectedEdgeId })}
                  >
                    删除连线
                  </button>
                </div>
              ) : (
                <small style={{ color: "#8e8e93" }}>连线处于只读状态。</small>
              )}
            </form>
          </aside>
        )}
      </div>

      {/* Role Bindings Modal */}
      {showRoleBindingsModal && (
        <div className="apple-modal-backdrop" onClick={() => setShowRoleBindingsModal(false)}>
          <div className="apple-modal-card" style={{ width: "620px" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>角色与本地 Agent 映射配置</h3>
              <button className="close-btn" type="button" onClick={() => setShowRoleBindingsModal(false)}>✕</button>
            </div>
            <p style={{ fontSize: "12px", color: "var(--apple-text-secondary)" }}>
              为工作流中的角色（Role）绑定实际执行的本地 CLI Agent（支持 Google agy 各账号与 OpenAI Codex CLI）。
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "320px", overflowY: "auto" }}>
              {Object.entries(tempRoleBindings).map(([role, targetAgent]) => (
                <div
                  key={role}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 12px",
                    background: "#f9f9fb",
                    borderRadius: "8px",
                    border: "1px solid #e5e5ea",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <strong style={{ fontSize: "13px" }}>{role}</strong>
                    <span style={{ fontSize: "11px", color: "var(--apple-text-secondary)" }}>工作流抽象角色</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <select
                      disabled={!editable}
                      value={targetAgent}
                      onChange={(e) => {
                        const val = e.target.value;
                        setTempRoleBindings((prev) => ({ ...prev, [role]: val }));
                      }}
                      style={{ fontSize: "12px", padding: "4px 8px", borderRadius: "6px" }}
                    >
                      {AVAILABLE_AGENT_PROVIDERS.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.label}</option>
                      ))}
                    </select>
                    {editable && (
                      <button
                        type="button"
                        style={{ border: 0, background: "transparent", color: "#f87171", cursor: "pointer", fontSize: "12px" }}
                        onClick={() => handleDeleteRole(role)}
                        title="删除角色"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {editable && (
              <>
                <div style={{ marginTop: "12px", padding: "10px", background: "#f5f5f7", borderRadius: "8px", border: "1px solid #e5e5ea" }}>
                  <div style={{ fontSize: "11px", fontWeight: 600, color: "#636366", marginBottom: "6px" }}>
                    快捷添加系统内置角色：
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {SYSTEM_BUILTIN_ROLES.filter((r) => !tempRoleBindings[r.id]).map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="apple-btn-secondary"
                        style={{ fontSize: "11px", padding: "3px 8px", borderRadius: "6px", background: "#ffffff" }}
                        onClick={() => {
                          setTempRoleBindings((prev) => ({ ...prev, [r.id]: r.defaultProviderId }));
                        }}
                        title={r.description}
                      >
                        + {r.name.split(" ")[0]}
                      </button>
                    ))}
                    {SYSTEM_BUILTIN_ROLES.every((r) => tempRoleBindings[r.id]) && (
                      <span style={{ fontSize: "11px", color: "#8e8e93" }}>全部内置角色已在列表中</span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                  <input
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="自定义角色名称，如: architect, auditor"
                    style={{ flex: 1, fontSize: "12px", padding: "6px 10px" }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddRole();
                      }
                    }}
                  />
                  <button className="apple-btn-secondary" type="button" onClick={handleAddRole}>
                    + 添加角色
                  </button>
                </div>
              </>
            )}

            <div className="modal-btn-row" style={{ marginTop: "14px" }}>
              <button className="apple-btn-secondary" type="button" onClick={() => setShowRoleBindingsModal(false)}>
                取消
              </button>
              {editable && (
                <button className="apple-btn-primary" type="button" onClick={handleSaveRoleBindings}>
                  保存角色配置
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {pendingDelete && (
        <div className="apple-modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="apple-modal-card delete-confirm-card" onClick={(event) => event.stopPropagation()}>
            <h3>{pendingDelete.kind === "node" ? "删除节点" : "删除连线"}</h3>
            <p>
              确定删除“{pendingDelete.label}”吗？
              {pendingDelete.kind === "node" ? "关联连线也会一并删除。" : ""}
              此操作无法撤销。
            </p>
            <div className="modal-btn-row">
              <button className="apple-btn-secondary" type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button
                className="apple-btn-danger"
                type="button"
                onClick={() => {
                  if (pendingDelete.kind === "node") handleDeleteNode(pendingDelete.id);
                  else handleDeleteEdge(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
