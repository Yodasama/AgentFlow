import { invoke } from "@tauri-apps/api/core";

export interface AppStatus {
  appName: string;
  protocolVersion: number;
  dataDirectory: string;
  runnerBundled: boolean;
  databaseReady: boolean;
  schedulerError: string | null;
}

export type RunState =
  | "queued"
  | "running"
  | "waiting_input"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AttemptState =
  | "prepared"
  | "starting"
  | "running"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface CreateMockTaskRequest {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  outcome: "succeeded" | "failed";
  accountId?: string | null;
  delayMilliseconds?: number | null;
}

export interface RunSummary {
  runId: string;
  taskId: string;
  title: string;
  description: string;
  runState: RunState;
  attemptState: AttemptState | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  workflowKind: string | null;
  waitingReason: string | null;
  stepExecutionId: string;
  attemptId: string | null;
  acceptanceCriteria: string[];
  stepState: "pending" | "running" | "waiting_input" | "succeeded" | "failed" | "skipped";
  attemptNumber: number | null;
  result: unknown | null;
  errorCode: string | null;
}

export interface WorkflowNode {
  id: string;
  version: number;
  kind: "start" | "agent" | "command" | "condition" | "human_approval" | "end";
  label: string;
  role: string | null;
  command: {
    program: string;
    arguments: string[];
    resultKind: "test" | "structured" | "generic";
  } | null;
  requiredInputs: string[];
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  isDefault: boolean;
  predicate: {
    field: string;
    operator: "equals" | "not_equals" | "exists" | "does_not_exist";
    expected: unknown | null;
  } | null;
}

export interface RepeatBlock {
  id: string;
  nodeIds: string[];
  entryNodeId: string;
  exitNodeId: string;
  backEdgeId: string;
  maxIterations: number;
}

export interface WorkflowDefinition {
  schemaVersion: number;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  repeatBlocks: RepeatBlock[];
  roleBindings: Record<string, string>;
  availableInputs: string[];
  budget: {
    maxSteps: number;
    maxIterations: number;
  };
}

export interface WorkflowVersionRecord {
  workflowVersionId: string;
  name: string;
  schemaVersion: number;
  digest: string;
  definition: WorkflowDefinition;
  createdAt: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId: string | null;
  edgeId: string | null;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}

export const getAppStatus = () => invoke<AppStatus>("get_app_status");

export const createMockTask = (request: CreateMockTaskRequest) =>
  invoke<RunDetail>("create_mock_task", { request });

export const listRuns = () => invoke<RunSummary[]>("list_runs");

export const getRun = (runId: string) => invoke<RunDetail>("get_run", { runId });

export const cancelRun = (runId: string) => invoke<RunDetail>("cancel_run", { runId });

export const validateWorkflow = (workflow: WorkflowDefinition) =>
  invoke<ValidationReport>("validate_workflow", { workflow });

export const getStandardWorkflow = () =>
  invoke<WorkflowDefinition>("get_standard_workflow");

export const publishWorkflow = (workflow: WorkflowDefinition) =>
  invoke<WorkflowVersionRecord>("publish_workflow", { workflow });

export interface HumanApproval {
  schemaVersion: number;
  candidateCommit: string;
  workflowDigest: string;
  decision: "approved" | "rejected";
  comment: string;
}

export interface DevelopmentRunSnapshot {
  runId: string;
  taskId: string;
  workflowVersionId: string;
  flow: {
    workflowDigest: string;
    maxIterations: number;
    maxActions: number;
    phase: "analysis" | "development" | "tests" | "waiting_infrastructure" | "review" | "human_approval" | "completed" | "exhausted";
    iteration: number;
    actionsUsed: number;
    candidateCommit: string | null;
    feedback: unknown[];
    testHistory: { schemaVersion: number; testedCommit: string; status: "passed" | "failed" | "infrastructure_error"; summary: string; failures: string[] }[];
    reviewHistory: { schemaVersion: number; reviewedCommit: string; verdict: "approved" | "changes_requested"; summary: string; findings: { severity: "blocking" | "warning"; file: string; line: number; message: string }[] }[];
    approvalHistory: HumanApproval[];
    completedCommit: string | null;
  };
}

export const createMockDevelopmentTask = (
  request: Pick<CreateMockTaskRequest, "title" | "description" | "acceptanceCriteria">,
  repositoryPath: string,
  scenario: "pass" | "test_then_review_retry",
) => invoke<DevelopmentRunSnapshot>("create_mock_development_task", { request, repositoryPath, scenario });

export const getDevelopmentRun = (runId: string) =>
  invoke<DevelopmentRunSnapshot>("get_development_run", { runId });

export const submitDevelopmentApproval = (runId: string, approval: HumanApproval) =>
  invoke<DevelopmentRunSnapshot>("submit_development_approval", { runId, approval });
