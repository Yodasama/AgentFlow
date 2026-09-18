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

export interface CheckpointRecord {
  checkpointId: string;
  workspaceId: string;
  runId: string;
  attemptId: string;
  baseSha: string;
  commitSha: string;
  controlledFiles: string[];
  marker: string;
  noChanges: boolean;
  createdAt: string;
}

export interface AttemptLogs {
  stdout: string;
  stderr: string;
  hasResult: boolean;
}

export interface AccountStatusSummary {
  accountId: string;
  displayName: string;
  role: string;
  isLocked: boolean;
  lockedByAttemptId: string | null;
  provider: string;
}

export interface ResourceLockRecord {
  resourceType: string;
  resourceId: string;
  attemptId: string;
  acquiredAt: string;
}

export interface AccountOverview {
  accounts: AccountStatusSummary[];
  activeLocks: ResourceLockRecord[];
  globalConcurrencyLimit: number;
}

export const listWorkflowVersions = () =>
  invoke<WorkflowVersionRecord[]>("list_workflow_versions");

export const listCheckpoints = (runId: string) =>
  invoke<CheckpointRecord[]>("list_checkpoints", { runId });

export const getAttemptLogs = (runId: string, attemptId: string) =>
  invoke<AttemptLogs>("get_attempt_logs", { runId, attemptId });

export const getAccountStates = () =>
  invoke<AccountOverview>("get_account_states");

export const getCheckpointDiff = (checkpointId: string) =>
  invoke<string>("get_checkpoint_diff", { checkpointId });

export interface ScheduleRecord {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  targetWorkflowName: string;
  active: boolean;
  overlapPolicy: string;
  lastRunAt: string | null;
  createdAt: string;
}

export interface MilestoneRecord {
  id: string;
  goalId: string;
  title: string;
  completed: boolean;
  sortOrder: number;
}

export interface GoalRecord {
  id: string;
  title: string;
  description: string;
  status: "in_progress" | "paused" | "completed";
  deadline: string;
  actionsUsed: number;
  actionsBudget: number;
  createdAt: string;
  milestones: MilestoneRecord[];
}

export const listSchedules = () =>
  invoke<ScheduleRecord[]>("list_schedules");

export const saveSchedule = (schedule: ScheduleRecord) =>
  invoke<void>("save_schedule", { schedule });

export const toggleSchedule = (id: string) =>
  invoke<boolean>("toggle_schedule", { id });

export const deleteSchedule = (id: string) =>
  invoke<void>("delete_schedule", { id });

export const listGoals = () =>
  invoke<GoalRecord[]>("list_goals");

export const saveGoal = (goal: GoalRecord) =>
  invoke<void>("save_goal", { goal });

export const toggleMilestone = (milestoneId: string) =>
  invoke<boolean>("toggle_milestone", { milestoneId });

export const deleteGoal = (id: string) =>
  invoke<void>("delete_goal", { id });

export interface DetectedCliAgent {
  id: string;
  name: string;
  executablePath: string | null;
  available: boolean;
  version: string | null;
}

export interface CliAgentExecutionResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const detectLocalCliAgents = () =>
  invoke<DetectedCliAgent[]>("detect_local_cli_agents");

export const runCliAgent = (
  program: string,
  argumentsList: string[],
  workingDirectory?: string | null,
) =>
  invoke<CliAgentExecutionResult>("run_cli_agent", {
    program,
    arguments: argumentsList,
    workingDirectory: workingDirectory || null,
  });
