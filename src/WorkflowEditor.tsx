import { useCallback, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  getStandardWorkflow,
  validateWorkflow,
  publishWorkflow,
  listWorkflowVersions,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowVersionRecord,
  type ValidationReport,
} from "./api";

const kindColors: Record<WorkflowNode["kind"], { bg: string; border: string; text: string }> = {
  start: { bg: "#0f3a22", border: "#22c55e", text: "#86efac" },
  agent: { bg: "#2e1065", border: "#a855f7", text: "#d8b4fe" },
  command: { bg: "#1e293b", border: "#38bdf8", text: "#7dd3fc" },
  condition: { bg: "#451a03", border: "#f59e0b", text: "#fde68a" },
  human_approval: { bg: "#3f1d1d", border: "#f97316", text: "#fdba74" },
  end: { bg: "#064e3b", border: "#10b981", text: "#6ee7b7" },
};

const kindLabels: Record<WorkflowNode["kind"], string> = {
  start: "开始 (Start)",
  agent: "Agent 节点",
  command: "执行命令 (Command)",
  condition: "条件分支 (Condition)",
  human_approval: "人工确认 (Approval)",
  end: "结束 (End)",
};

function workflowToFlow(definition: WorkflowDefinition) {
  // Convert workflow nodes to ReactFlow nodes
  const nodes: Node[] = definition.nodes.map((node, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const color = kindColors[node.kind] ?? { bg: "#1e293b", border: "#64748b", text: "#e2e8f0" };

    return {
      id: node.id,
      position: { x: col * 260 + 40, y: row * 160 + 40 },
      data: {
        label: (
          <div style={{ padding: "8px 10px", fontSize: "12px", textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
              <span
                style={{
                  fontSize: "10px",
                  textTransform: "uppercase",
                  padding: "1px 5px",
                  borderRadius: "3px",
                  background: color.bg,
                  color: color.text,
                  fontWeight: 600,
                }}
              >
                {kindLabels[node.kind]}
              </span>
              <span style={{ fontSize: "10px", opacity: 0.6 }}>v{node.version}</span>
            </div>
            <div style={{ fontWeight: 600, fontSize: "13px", color: "#f8fafc" }}>{node.label}</div>
            {node.role && <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>角色: {node.role}</div>}
            {node.command && (
              <div style={{ fontSize: "10px", color: "#38bdf8", marginTop: "2px", fontFamily: "monospace" }}>
                ${node.command.program} {node.command.arguments.join(" ")}
              </div>
            )}
          </div>
        ),
        rawNode: node,
      },
      style: {
        background: "#0f172a",
        border: `1.5px solid ${color.border}`,
        borderRadius: "8px",
        color: "#f8fafc",
        width: 220,
        boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
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
        stroke: isRepeatBack ? "#f59e0b" : edge.isDefault ? "#94a3b8" : "#38bdf8",
        strokeWidth: isRepeatBack ? 2 : 1.5,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: isRepeatBack ? "#f59e0b" : edge.isDefault ? "#94a3b8" : "#38bdf8",
      },
      labelStyle: {
        fill: isRepeatBack ? "#fde68a" : "#94a3b8",
        fontSize: 10,
        fontWeight: 500,
      },
    };
  });

  return { nodes, edges };
}

export function WorkflowEditor() {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionRecord[]>([]);
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const loadWorkflow = useCallback((def: WorkflowDefinition) => {
    setDefinition(def);
    const flow = workflowToFlow(def);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  const refreshVersions = useCallback(async () => {
    try {
      const records = await listWorkflowVersions();
      setVersions(records);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void getStandardWorkflow().then((def) => {
      loadWorkflow(def);
    });
    void refreshVersions();
  }, [loadWorkflow, refreshVersions]);

  const handleValidate = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const report = await validateWorkflow(definition);
      setValidation(report);
      if (report.valid) {
        setMessage("工作流结构合法，各项校验已通过。");
      }
    } catch (err) {
      setMessage(`校验异常：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!definition) return;
    setBusy(true);
    setMessage(null);
    try {
      const record = await publishWorkflow(definition);
      setMessage(`工作流发布成功！版本 ID: ${record.workflowVersionId}，Digest: ${record.digest.slice(0, 12)}…`);
      await refreshVersions();
    } catch (err) {
      setMessage(`发布失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleResetStandard = async () => {
    setBusy(true);
    try {
      const def = await getStandardWorkflow();
      loadWorkflow(def);
      setValidation(null);
      setMessage("已重新载入标准开发工作流模板。");
    } catch (err) {
      setMessage(`重置失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workflow-view">
      <div className="workflow-toolbar">
        <div>
          <h2>工作流可视化设计器 (P9)</h2>
          <p className="subtitle">
            {definition?.name ?? "加载中…"} · Schema v{definition?.schemaVersion ?? 1} ·{" "}
            {definition?.nodes.length ?? 0} 个节点 · {definition?.edges.length ?? 0} 条连线
          </p>
        </div>
        <div className="toolbar-actions">
          <button className="secondary" type="button" disabled={busy} onClick={() => void handleResetStandard()}>
            载入标准模板
          </button>
          <button className="secondary" type="button" disabled={busy} onClick={() => void handleValidate()}>
            验证合法性
          </button>
          <button className="primary" type="button" disabled={busy} onClick={() => void handlePublish()}>
            发布版本 (SQLite)
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() => setShowVersions((val) => !val)}
          >
            版本历史 ({versions.length})
          </button>
        </div>
      </div>

      {message && (
        <p role="status" className="info-banner" style={{ margin: "8px 0" }}>
          {message}
        </p>
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
        <div className="flow-canvas" style={{ flex: 1, height: "540px", background: "#090d16", borderRadius: "8px" }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              const raw = (node.data as { rawNode?: WorkflowNode }).rawNode;
              if (raw) setSelectedNode(raw);
            }}
            fitView
          >
            <Background color="#1e293b" gap={16} />
            <Controls />
            <MiniMap
              nodeStrokeColor="#38bdf8"
              nodeColor="#1e293b"
              style={{ background: "#0b1329", border: "1px solid #1e293b" }}
            />
          </ReactFlow>
        </div>

        {selectedNode && (
          <aside className="node-inspector">
            <div className="panel-heading">
              <h3>节点详情</h3>
              <button className="close-btn" type="button" onClick={() => setSelectedNode(null)}>
                ✕
              </button>
            </div>
            <dl>
              <div>
                <dt>节点 ID</dt>
                <dd><code>{selectedNode.id}</code></dd>
              </div>
              <div>
                <dt>节点类型</dt>
                <dd>{kindLabels[selectedNode.kind]}</dd>
              </div>
              <div>
                <dt>显示名称</dt>
                <dd>{selectedNode.label}</dd>
              </div>
              {selectedNode.role && (
                <div>
                  <dt>绑定角色</dt>
                  <dd><code>{selectedNode.role}</code></dd>
                </div>
              )}
              {selectedNode.requiredInputs.length > 0 && (
                <div>
                  <dt>必需输入</dt>
                  <dd>{selectedNode.requiredInputs.join(", ")}</dd>
                </div>
              )}
              {selectedNode.command && (
                <div>
                  <dt>预置命令</dt>
                  <dd>
                    <code>
                      {selectedNode.command.program} {selectedNode.command.arguments.join(" ")}
                    </code>
                    <small>结果类别: {selectedNode.command.resultKind}</small>
                  </dd>
                </div>
              )}
            </dl>
          </aside>
        )}

        {showVersions && (
          <aside className="versions-drawer">
            <div className="panel-heading">
              <h3>发布版本记录 ({versions.length})</h3>
              <button className="close-btn" type="button" onClick={() => setShowVersions(false)}>
                ✕
              </button>
            </div>
            {versions.length === 0 ? (
              <p className="empty">暂无发布的持久化工作流版本，点击上方“发布版本”即可写入不可变记录。</p>
            ) : (
              <div className="versions-list">
                {versions.map((ver) => (
                  <article key={ver.workflowVersionId} className="version-card">
                    <strong>{ver.name}</strong>
                    <p className="digest-code">
                      Digest: <code>{ver.digest.slice(0, 16)}…</code>
                    </p>
                    <small>{new Date(ver.createdAt).toLocaleString()}</small>
                    <button
                      className="secondary-sm"
                      type="button"
                      onClick={() => {
                        loadWorkflow(ver.definition);
                        setMessage(`已载入历史发布版本: ${ver.name} (${ver.digest.slice(0, 8)})`);
                      }}
                    >
                      载入此版本
                    </button>
                  </article>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
