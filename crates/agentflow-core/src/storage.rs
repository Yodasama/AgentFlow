use std::{path::Path, str::FromStr, time::Duration};

use chrono::Utc;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior, params,
    types::Type,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::domain::{
    ActiveAttempt, ArtifactRecord, AttemptCompletion, AttemptState, CheckpointRecord,
    CreateMockTaskRequest, GoalRecord, MilestoneRecord, MockOutcome, PreparedAttempt,
    ProjectRecord, ResourceLockRecord, RunDetail, RunState, RunSummary, ScheduleRecord,
    StateParseError, StepExecutionState, WorkspaceRecord,
};
use crate::{
    development_flow::{ApprovalDecision, ApprovalRecord, DevelopmentLoop, DevelopmentPhase},
    development_runtime::MockDevelopmentExecution,
    protocol::{LaunchManifest, RUNNER_PROTOCOL_VERSION},
    workflow::{WorkflowDefinition, WorkflowVersionRecord, validate_workflow, workflow_digest},
    workflow_run::{
        CreateDevelopmentRunRequest, DevelopmentRunSnapshot, NodeLaunchSpec,
        WorkflowStepTransition, pending_step,
    },
};

const MIGRATION_1: &str = r#"
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    acceptance_criteria_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    trigger_source TEXT NOT NULL,
    config_snapshot_json TEXT NOT NULL,
    workflow_snapshot_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'waiting_input', 'interrupted',
        'succeeded', 'failed', 'cancelled'
    )),
    waiting_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
) STRICT;

CREATE TABLE step_executions (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    node_id TEXT NOT NULL,
    iteration_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'running', 'waiting_input', 'succeeded', 'failed', 'skipped'
    )),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(run_id, node_id, iteration_key)
) STRICT;

CREATE TABLE attempts (
    id TEXT PRIMARY KEY NOT NULL,
    step_execution_id TEXT NOT NULL REFERENCES step_executions(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    requested_account_id TEXT NOT NULL,
    actual_account_id TEXT,
    state TEXT NOT NULL CHECK (state IN (
        'prepared', 'starting', 'running', 'finalizing',
        'succeeded', 'failed', 'interrupted', 'cancelled'
    )),
    input_digest TEXT NOT NULL,
    runner_token TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE(step_execution_id, attempt_number)
) STRICT;

CREATE TABLE resource_locks (
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    acquired_at TEXT NOT NULL,
    PRIMARY KEY(resource_type, resource_id)
) STRICT;

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT REFERENCES attempts(id),
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    runner_event_seq INTEGER,
    created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX events_attempt_runner_seq_unique
ON events(attempt_id, runner_event_seq)
WHERE attempt_id IS NOT NULL AND runner_event_seq IS NOT NULL;

CREATE INDEX runs_created_at_index ON runs(created_at DESC);
CREATE INDEX attempts_step_execution_index ON attempts(step_execution_id);
CREATE INDEX events_run_index ON events(run_id, id);
"#;

const MIGRATION_2: &str = r#"
CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    git_common_directory TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL CHECK (kind IN ('development', 'review')),
    base_sha TEXT NOT NULL,
    branch_name TEXT,
    path TEXT NOT NULL UNIQUE,
    source_checkpoint_id TEXT REFERENCES checkpoints(id),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, generation, kind)
) STRICT;

CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    base_sha TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    controlled_files_json TEXT NOT NULL,
    marker TEXT NOT NULL UNIQUE,
    no_changes INTEGER NOT NULL CHECK (no_changes IN (0, 1)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    artifact_type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(attempt_id, artifact_type, relative_path)
) STRICT;

CREATE INDEX workspaces_project_index ON workspaces(project_id, created_at);
CREATE INDEX checkpoints_run_index ON checkpoints(run_id, created_at);
CREATE INDEX artifacts_run_index ON artifacts(run_id, created_at);
"#;

const MIGRATION_3: &str = r#"
CREATE TABLE workflow_versions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    candidate_commit TEXT NOT NULL,
    workflow_digest TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT,
    UNIQUE(run_id, candidate_commit, workflow_digest, decision, comment)
) STRICT;

CREATE INDEX approvals_run_index ON approvals(run_id, created_at);
"#;

const MIGRATION_4: &str = r#"
CREATE TABLE workspaces_v4 (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    kind TEXT NOT NULL CHECK (kind IN ('development', 'review')),
    base_sha TEXT NOT NULL,
    branch_name TEXT,
    path TEXT NOT NULL UNIQUE,
    source_checkpoint_id TEXT REFERENCES checkpoints(id),
    created_at TEXT NOT NULL
) STRICT;
INSERT INTO workspaces_v4 SELECT * FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_v4 RENAME TO workspaces;
CREATE UNIQUE INDEX development_workspace_generation ON workspaces(run_id, generation) WHERE kind = 'development';
CREATE UNIQUE INDEX review_workspace_candidate ON workspaces(run_id, generation, source_checkpoint_id) WHERE kind = 'review';
CREATE INDEX workspaces_project_index ON workspaces(project_id, created_at);
"#;

const MIGRATION_5: &str = r#"
CREATE TABLE schedules (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    target_workflow_name TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    overlap_policy TEXT NOT NULL,
    last_run_at TEXT,
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE goals (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('in_progress', 'paused', 'completed')),
    deadline TEXT NOT NULL,
    actions_used INTEGER NOT NULL CHECK (actions_used >= 0),
    actions_budget INTEGER NOT NULL CHECK (actions_budget > 0),
    created_at TEXT NOT NULL
) STRICT;

CREATE TABLE milestones (
    id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    sort_order INTEGER NOT NULL
) STRICT;

CREATE INDEX milestones_goal_index ON milestones(goal_id, sort_order);
"#;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    InvalidState(#[from] StateParseError),
    #[error("invalid {entity} transition from {from} to {to}")]
    InvalidTransition {
        entity: &'static str,
        from: String,
        to: String,
    },
    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: Uuid },
    #[error("title and description must not be empty")]
    InvalidTask,
    #[error("runner event sequence is outside SQLite INTEGER range: {0}")]
    InvalidEventSequence(u64),
    #[error("database contains an invalid {entity} identifier: {value}")]
    InvalidIdentifier { entity: &'static str, value: String },
    #[error("integer value is outside SQLite range: {0}")]
    IntegerOutOfRange(u64),
    #[error("workflow definition is invalid: {0}")]
    InvalidWorkflow(String),
    #[error("database migration violates foreign key integrity")]
    MigrationIntegrity,
}

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let mut connection = Connection::open_with_flags(path, flags)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )?;
        migrate(&mut connection)?;
        Ok(Self { connection })
    }

    pub fn create_and_execute_mock_task(
        &mut self,
        request: CreateMockTaskRequest,
    ) -> Result<RunDetail, StorageError> {
        let title = request.title.trim();
        let description = request.description.trim();
        if title.is_empty() || description.is_empty() {
            return Err(StorageError::InvalidTask);
        }

        let task_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let step_id = Uuid::new_v4();
        let attempt_id = Uuid::new_v4();
        let now = timestamp();
        let acceptance_json = serde_json::to_string(&request.acceptance_criteria)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        tx.execute(
            "INSERT INTO tasks(id, title, description, acceptance_criteria_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task_id.to_string(),
                title,
                description,
                acceptance_json,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO runs(
                id, task_id, trigger_source, config_snapshot_json,
                workflow_snapshot_json, state, created_at
             ) VALUES (?1, ?2, 'manual', ?3, ?4, ?5, ?6)",
            params![
                run_id.to_string(),
                task_id.to_string(),
                json!({"adapter": "mock", "accountID": "mock:default"}).to_string(),
                json!({"schemaVersion": 1, "template": "mock-single-step"}).to_string(),
                RunState::Queued.as_str(),
                now,
            ],
        )?;
        insert_event(
            &tx,
            run_id,
            None,
            "run_created",
            json!({"state": "queued"}),
            None,
        )?;
        tx.execute(
            "INSERT INTO step_executions(
                id, run_id, node_id, iteration_key, state, created_at
             ) VALUES (?1, ?2, 'mock-agent', 'iteration-1', ?3, ?4)",
            params![
                step_id.to_string(),
                run_id.to_string(),
                StepExecutionState::Pending.as_str(),
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO attempts(
                id, step_execution_id, attempt_number, requested_account_id,
                actual_account_id, state, input_digest, runner_token, created_at
             ) VALUES (?1, ?2, 1, 'mock:default', 'mock:default', ?3, ?4, ?5, ?6)",
            params![
                attempt_id.to_string(),
                step_id.to_string(),
                AttemptState::Prepared.as_str(),
                format!("mock:{task_id}"),
                Uuid::new_v4().to_string(),
                now,
            ],
        )?;
        for (resource_type, resource_id) in [
            ("account", "mock:default".to_owned()),
            ("workspace", format!("mock:{run_id}")),
        ] {
            tx.execute(
                "INSERT INTO resource_locks(resource_type, resource_id, attempt_id, acquired_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![resource_type, resource_id, attempt_id.to_string(), now],
            )?;
        }

        transition_run(&tx, run_id, RunState::Queued, RunState::Running)?;
        transition_step(
            &tx,
            run_id,
            step_id,
            StepExecutionState::Pending,
            StepExecutionState::Running,
        )?;
        transition_attempt(
            &tx,
            run_id,
            attempt_id,
            AttemptState::Prepared,
            AttemptState::Starting,
            None,
            None,
        )?;
        transition_attempt(
            &tx,
            run_id,
            attempt_id,
            AttemptState::Starting,
            AttemptState::Running,
            None,
            None,
        )?;
        transition_attempt(
            &tx,
            run_id,
            attempt_id,
            AttemptState::Running,
            AttemptState::Finalizing,
            None,
            None,
        )?;

        match request.outcome {
            MockOutcome::Succeeded => {
                transition_attempt(
                    &tx,
                    run_id,
                    attempt_id,
                    AttemptState::Finalizing,
                    AttemptState::Succeeded,
                    Some(json!({"message": "mock step completed"})),
                    None,
                )?;
                transition_step(
                    &tx,
                    run_id,
                    step_id,
                    StepExecutionState::Running,
                    StepExecutionState::Succeeded,
                )?;
                transition_run(&tx, run_id, RunState::Running, RunState::Succeeded)?;
            }
            MockOutcome::Failed => {
                transition_attempt(
                    &tx,
                    run_id,
                    attempt_id,
                    AttemptState::Finalizing,
                    AttemptState::Failed,
                    Some(json!({"message": "mock failure retained for inspection"})),
                    Some("mock_failure"),
                )?;
                transition_step(
                    &tx,
                    run_id,
                    step_id,
                    StepExecutionState::Running,
                    StepExecutionState::Failed,
                )?;
                transition_run(&tx, run_id, RunState::Running, RunState::Failed)?;
            }
        }

        tx.execute(
            "DELETE FROM resource_locks WHERE attempt_id = ?1",
            [attempt_id.to_string()],
        )?;
        tx.commit()?;
        self.get_run(run_id)
    }

    pub fn enqueue_mock_task(
        &mut self,
        request: CreateMockTaskRequest,
    ) -> Result<RunDetail, StorageError> {
        let title = request.title.trim();
        let description = request.description.trim();
        if title.is_empty() || description.is_empty() {
            return Err(StorageError::InvalidTask);
        }

        let task_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let step_id = Uuid::new_v4();
        let now = timestamp();
        let account_id = request
            .account_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("mock:default");
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO tasks(id, title, description, acceptance_criteria_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task_id.to_string(),
                title,
                description,
                serde_json::to_string(&request.acceptance_criteria)?,
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO runs(
                id, task_id, trigger_source, config_snapshot_json,
                workflow_snapshot_json, state, created_at
             ) VALUES (?1, ?2, 'manual', ?3, ?4, ?5, ?6)",
            params![
                run_id.to_string(),
                task_id.to_string(),
                json!({
                    "adapter": "mock",
                    "accountID": account_id,
                    "outcome": request.outcome,
                    "delayMilliseconds": request.delay_milliseconds,
                })
                .to_string(),
                json!({"schemaVersion": 1, "template": "mock-single-step"}).to_string(),
                RunState::Queued.as_str(),
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO step_executions(
                id, run_id, node_id, iteration_key, state, created_at
             ) VALUES (?1, ?2, 'mock-agent', 'iteration-1', ?3, ?4)",
            params![
                step_id.to_string(),
                run_id.to_string(),
                StepExecutionState::Pending.as_str(),
                now,
            ],
        )?;
        insert_event(
            &tx,
            run_id,
            None,
            "run_created",
            json!({"state": RunState::Queued}),
            None,
        )?;
        tx.commit()?;
        self.get_run(run_id)
    }

    pub fn claim_next_mock_attempt(
        &mut self,
        global_limit: u32,
    ) -> Result<Option<PreparedAttempt>, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active_count: u32 = tx.query_row(
            "SELECT COUNT(*) FROM attempts
             WHERE state IN ('prepared', 'starting', 'running', 'finalizing')",
            [],
            |row| row.get(0),
        )?;
        if active_count >= global_limit {
            tx.commit()?;
            return Ok(None);
        }

        let queued = {
            let mut statement = tx.prepare(
                "SELECT r.id, s.id, r.config_snapshot_json
                 FROM runs r
                 JOIN step_executions s ON s.run_id = r.id
                 WHERE r.state = 'queued' AND s.state = 'pending'
                 ORDER BY r.created_at ASC, r.id ASC",
            )?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut candidate = None;
        for (run_id_value, step_id_value, config_json) in queued {
            let config: serde_json::Value = serde_json::from_str(&config_json)?;
            let account_id = config
                .get("accountID")
                .and_then(|value| value.as_str())
                .unwrap_or("mock:default")
                .to_owned();
            let locked: bool = tx.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM resource_locks
                    WHERE resource_type = 'account' AND resource_id = ?1
                 )",
                [&account_id],
                |row| row.get(0),
            )?;
            if !locked {
                candidate = Some((run_id_value, step_id_value, config, account_id));
                break;
            }
        }
        let Some((run_id_value, step_id_value, config, account_id)) = candidate else {
            tx.commit()?;
            return Ok(None);
        };
        let run_id = parse_uuid("run", &run_id_value)?;
        let step_id = parse_uuid("step execution", &step_id_value)?;
        let outcome = serde_json::from_value(
            config
                .get("outcome")
                .cloned()
                .unwrap_or_else(|| json!("succeeded")),
        )?;
        let delay_milliseconds = config
            .get("delayMilliseconds")
            .and_then(|value| value.as_u64());
        let attempt_number: u32 = tx.query_row(
            "SELECT COALESCE(MAX(attempt_number), 0) + 1
             FROM attempts WHERE step_execution_id = ?1",
            [step_id.to_string()],
            |row| row.get(0),
        )?;
        let attempt_id = Uuid::new_v4();
        let execution_token = Uuid::new_v4().to_string();
        let now = timestamp();
        tx.execute(
            "INSERT INTO attempts(
                id, step_execution_id, attempt_number, requested_account_id,
                actual_account_id, state, input_digest, runner_token, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
            params![
                attempt_id.to_string(),
                step_id.to_string(),
                attempt_number,
                account_id,
                AttemptState::Prepared.as_str(),
                format!("mock:{run_id}:{attempt_number}"),
                execution_token,
                now,
            ],
        )?;
        for (resource_type, resource_id) in [
            ("account", account_id.clone()),
            ("workspace", format!("mock:{run_id}")),
        ] {
            tx.execute(
                "INSERT INTO resource_locks(resource_type, resource_id, attempt_id, acquired_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![resource_type, resource_id, attempt_id.to_string(), now],
            )?;
        }
        transition_run(&tx, run_id, RunState::Queued, RunState::Running)?;
        transition_step(
            &tx,
            run_id,
            step_id,
            StepExecutionState::Pending,
            StepExecutionState::Running,
        )?;
        insert_event(
            &tx,
            run_id,
            Some(attempt_id),
            "attempt_prepared",
            json!({"state": AttemptState::Prepared}),
            None,
        )?;
        tx.commit()?;

        Ok(Some(PreparedAttempt {
            run_id,
            step_execution_id: step_id,
            attempt_id,
            execution_token,
            account_id,
            outcome,
            delay_milliseconds,
        }))
    }

    pub fn mark_attempt_starting(&mut self, attempt: &PreparedAttempt) -> Result<(), StorageError> {
        self.transition_attempt_state(
            attempt.run_id,
            attempt.attempt_id,
            AttemptState::Prepared,
            AttemptState::Starting,
        )
    }

    pub fn mark_attempt_running(&mut self, attempt: &ActiveAttempt) -> Result<(), StorageError> {
        if attempt.state == AttemptState::Running {
            return Ok(());
        }
        self.transition_attempt_state(
            attempt.run_id,
            attempt.attempt_id,
            AttemptState::Starting,
            AttemptState::Running,
        )
    }

    pub fn mark_attempt_interrupted(
        &mut self,
        attempt: &ActiveAttempt,
    ) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transition_attempt(
            &tx,
            attempt.run_id,
            attempt.attempt_id,
            attempt.state,
            AttemptState::Interrupted,
            None,
            Some("runner_state_unknown"),
        )?;
        transition_run(
            &tx,
            attempt.run_id,
            RunState::Running,
            RunState::Interrupted,
        )?;
        insert_event(
            &tx,
            attempt.run_id,
            Some(attempt.attempt_id),
            "runner_state_unknown",
            json!({"locksRetained": true}),
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn finalize_attempt(
        &mut self,
        attempt_id: Uuid,
        completion: AttemptCompletion,
    ) -> Result<bool, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT r.id, s.id, r.state, s.state, a.state
                 FROM attempts a
                 JOIN step_executions s ON s.id = a.step_execution_id
                 JOIN runs r ON r.id = s.run_id
                 WHERE a.id = ?1",
                [attempt_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((run_value, step_value, run_state, step_state, attempt_state)) = row else {
            return Err(StorageError::NotFound {
                entity: "attempt",
                id: attempt_id,
            });
        };
        let run_id = parse_uuid("run", &run_value)?;
        let step_id = parse_uuid("step execution", &step_value)?;
        let run_state = RunState::from_str(&run_state)?;
        let step_state = StepExecutionState::from_str(&step_state)?;
        let mut attempt_state = AttemptState::from_str(&attempt_state)?;
        if attempt_state.is_terminal() {
            tx.commit()?;
            return Ok(false);
        }
        if run_state != RunState::Running || step_state != StepExecutionState::Running {
            return Err(StorageError::InvalidTransition {
                entity: "attempt finalization",
                from: format!("run={run_state}, step={step_state}, attempt={attempt_state}"),
                to: "terminal".to_owned(),
            });
        }
        if attempt_state != AttemptState::Finalizing {
            transition_attempt(
                &tx,
                run_id,
                attempt_id,
                attempt_state,
                AttemptState::Finalizing,
                None,
                None,
            )?;
            attempt_state = AttemptState::Finalizing;
        }

        let (attempt_target, step_target, run_target, result, error_code) = match completion {
            AttemptCompletion::Succeeded(result) => (
                AttemptState::Succeeded,
                StepExecutionState::Succeeded,
                RunState::Succeeded,
                result,
                None,
            ),
            AttemptCompletion::Failed { result, error_code } => (
                AttemptState::Failed,
                StepExecutionState::Failed,
                RunState::Failed,
                result,
                Some(error_code),
            ),
            AttemptCompletion::Cancelled(result) => (
                AttemptState::Cancelled,
                StepExecutionState::Failed,
                RunState::Cancelled,
                result,
                Some("cancelled".to_owned()),
            ),
        };
        transition_attempt(
            &tx,
            run_id,
            attempt_id,
            attempt_state,
            attempt_target,
            Some(result),
            error_code.as_deref(),
        )?;
        let workflow_attempt: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE attempt_id = ?1 AND event_type = 'workflow_launch_prepared')",
            [attempt_id.to_string()], |row| row.get(0),
        )?;
        if workflow_attempt && attempt_target == AttemptState::Succeeded {
            // Preserve the running step and its locks until the coordinator atomically
            // consumes the durable result and creates the next node.
            insert_event(
                &tx,
                run_id,
                Some(attempt_id),
                "workflow_result_ready",
                json!({"attemptState": attempt_target, "locksReleased": false}),
                None,
            )?;
            tx.commit()?;
            return Ok(true);
        }
        transition_step(
            &tx,
            run_id,
            step_id,
            StepExecutionState::Running,
            step_target,
        )?;
        transition_run(&tx, run_id, RunState::Running, run_target)?;
        tx.execute(
            "DELETE FROM resource_locks WHERE attempt_id = ?1",
            [attempt_id.to_string()],
        )?;
        insert_event(
            &tx,
            run_id,
            Some(attempt_id),
            "runner_result_imported",
            json!({"attemptState": attempt_target, "locksReleased": true}),
            None,
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn cancel_queued_run(&mut self, run_id: Uuid) -> Result<bool, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT r.state, s.id, s.state
                 FROM runs r
                 JOIN step_executions s ON s.run_id = r.id
                 WHERE r.id = ?1",
                [run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((run_state, step_value, step_state)) = row else {
            return Err(StorageError::NotFound {
                entity: "run",
                id: run_id,
            });
        };
        if RunState::from_str(&run_state)? != RunState::Queued {
            tx.commit()?;
            return Ok(false);
        }
        let step_id = parse_uuid("step execution", &step_value)?;
        let step_state = StepExecutionState::from_str(&step_state)?;
        transition_step(
            &tx,
            run_id,
            step_id,
            step_state,
            StepExecutionState::Skipped,
        )?;
        transition_run(&tx, run_id, RunState::Queued, RunState::Cancelled)?;
        tx.commit()?;
        Ok(true)
    }

    pub fn cancel_idle_development_run(&mut self, run_id: Uuid) -> Result<bool, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (state, config): (String, String) = tx.query_row(
            "SELECT state, config_snapshot_json FROM runs WHERE id = ?1",
            [run_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let state = RunState::from_str(&state)?;
        let config: serde_json::Value = serde_json::from_str(&config)?;
        if state.is_terminal() || config["kind"].as_str() != Some("development_workflow") {
            return Ok(false);
        }
        let unknown_or_live: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM attempts a JOIN step_executions s ON s.id = a.step_execution_id
             WHERE s.run_id = ?1 AND a.state IN ('starting','running','finalizing','interrupted'))",
            [run_id.to_string()], |row| row.get(0))?;
        if unknown_or_live {
            return Ok(false);
        }
        let prepared = {
            let mut statement = tx.prepare("SELECT a.id FROM attempts a JOIN step_executions s ON s.id = a.step_execution_id WHERE s.run_id = ?1 AND a.state = 'prepared'")?;
            statement
                .query_map([run_id.to_string()], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in prepared {
            transition_attempt(
                &tx,
                run_id,
                parse_uuid("attempt", &id)?,
                AttemptState::Prepared,
                AttemptState::Cancelled,
                None,
                Some("cancelled_before_launch"),
            )?;
        }
        let steps = {
            let mut statement = tx.prepare("SELECT id, state FROM step_executions WHERE run_id = ?1 AND state IN ('pending','running','waiting_input')")?;
            statement
                .query_map([run_id.to_string()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (id, state) in steps {
            let from = StepExecutionState::from_str(&state)?;
            let to = if from == StepExecutionState::Pending {
                StepExecutionState::Skipped
            } else {
                StepExecutionState::Failed
            };
            transition_step(&tx, run_id, parse_uuid("step execution", &id)?, from, to)?;
        }
        transition_run(&tx, run_id, state, RunState::Cancelled)?;
        tx.execute("DELETE FROM resource_locks WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN step_executions s ON s.id = a.step_execution_id WHERE s.run_id = ?1)", [run_id.to_string()])?;
        insert_event(
            &tx,
            run_id,
            None,
            "development_cancelled",
            json!({"locksReleased":true}),
            None,
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn active_attempt_for_run(
        &self,
        run_id: Uuid,
    ) -> Result<Option<ActiveAttempt>, StorageError> {
        self.active_attempts().map(|attempts| {
            attempts
                .into_iter()
                .find(|attempt| attempt.run_id == run_id)
        })
    }

    pub fn register_project(
        &mut self,
        root_path: &str,
        git_common_directory: &str,
    ) -> Result<ProjectRecord, StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = tx
            .query_row(
                "SELECT id, root_path, git_common_directory, created_at
                 FROM projects WHERE root_path = ?1",
                [root_path],
                project_from_row,
            )
            .optional()?;
        if let Some(project) = existing {
            tx.commit()?;
            return Ok(project);
        }
        let project = ProjectRecord {
            project_id: Uuid::new_v4(),
            root_path: root_path.to_owned(),
            git_common_directory: git_common_directory.to_owned(),
            created_at: timestamp(),
        };
        tx.execute(
            "INSERT INTO projects(id, root_path, git_common_directory, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                project.project_id.to_string(),
                project.root_path,
                project.git_common_directory,
                project.created_at,
            ],
        )?;
        tx.commit()?;
        Ok(project)
    }

    pub fn insert_workspace(&mut self, workspace: &WorkspaceRecord) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO workspaces(
                id, run_id, project_id, generation, kind, base_sha,
                branch_name, path, source_checkpoint_id, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                workspace.workspace_id.to_string(),
                workspace.run_id.to_string(),
                workspace.project_id.to_string(),
                workspace.generation,
                workspace.kind,
                workspace.base_sha,
                workspace.branch_name,
                workspace.path,
                workspace.source_checkpoint_id.map(|id| id.to_string()),
                workspace.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn workspace(
        &self,
        run_id: Uuid,
        generation: u32,
        kind: &str,
    ) -> Result<Option<WorkspaceRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT id, run_id, project_id, generation, kind, base_sha,
                        branch_name, path, source_checkpoint_id, created_at
                 FROM workspaces
                 WHERE run_id = ?1 AND generation = ?2 AND kind = ?3",
                params![run_id.to_string(), generation, kind],
                workspace_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn checkpoint_by_marker(
        &self,
        marker: &str,
    ) -> Result<Option<CheckpointRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT id, workspace_id, run_id, attempt_id, base_sha, commit_sha,
                        controlled_files_json, marker, no_changes, created_at
                 FROM checkpoints WHERE marker = ?1",
                [marker],
                checkpoint_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn review_workspace(
        &self,
        run_id: Uuid,
        generation: u32,
        checkpoint_id: Uuid,
    ) -> Result<Option<WorkspaceRecord>, StorageError> {
        self.connection.query_row(
            "SELECT id, run_id, project_id, generation, kind, base_sha,
                    branch_name, path, source_checkpoint_id, created_at
             FROM workspaces WHERE run_id = ?1 AND generation = ?2 AND kind = 'review' AND source_checkpoint_id = ?3",
            params![run_id.to_string(), generation, checkpoint_id.to_string()], workspace_from_row,
        ).optional().map_err(Into::into)
    }

    pub fn insert_checkpoint(
        &mut self,
        checkpoint: &CheckpointRecord,
    ) -> Result<CheckpointRecord, StorageError> {
        if let Some(existing) = self.checkpoint_by_marker(&checkpoint.marker)? {
            return Ok(existing);
        }
        self.connection.execute(
            "INSERT INTO checkpoints(
                id, workspace_id, run_id, attempt_id, base_sha, commit_sha,
                controlled_files_json, marker, no_changes, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                checkpoint.checkpoint_id.to_string(),
                checkpoint.workspace_id.to_string(),
                checkpoint.run_id.to_string(),
                checkpoint.attempt_id.to_string(),
                checkpoint.base_sha,
                checkpoint.commit_sha,
                serde_json::to_string(&checkpoint.controlled_files)?,
                checkpoint.marker,
                checkpoint.no_changes,
                checkpoint.created_at,
            ],
        )?;
        Ok(checkpoint.clone())
    }

    pub fn replace_artifacts(
        &mut self,
        run_id: Uuid,
        attempt_id: Uuid,
        artifacts: &[ArtifactRecord],
    ) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM artifacts WHERE run_id = ?1 AND attempt_id = ?2",
            params![run_id.to_string(), attempt_id.to_string()],
        )?;
        for artifact in artifacts {
            let byte_size = i64::try_from(artifact.byte_size)
                .map_err(|_| StorageError::IntegerOutOfRange(artifact.byte_size))?;
            tx.execute(
                "INSERT INTO artifacts(
                    id, run_id, attempt_id, artifact_type, relative_path,
                    byte_size, content_hash, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    artifact.artifact_id.to_string(),
                    artifact.run_id.to_string(),
                    artifact.attempt_id.to_string(),
                    artifact.artifact_type,
                    artifact.relative_path,
                    byte_size,
                    artifact.content_hash,
                    artifact.created_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn artifacts_for_run(&self, run_id: Uuid) -> Result<Vec<ArtifactRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, run_id, attempt_id, artifact_type, relative_path,
                    byte_size, content_hash, created_at
             FROM artifacts WHERE run_id = ?1 ORDER BY relative_path",
        )?;
        let rows = statement.query_map([run_id.to_string()], artifact_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn publish_workflow(
        &mut self,
        definition: &WorkflowDefinition,
    ) -> Result<WorkflowVersionRecord, StorageError> {
        let validation = validate_workflow(definition);
        if !validation.valid {
            return Err(StorageError::InvalidWorkflow(
                validation
                    .issues
                    .iter()
                    .map(|issue| issue.code.as_str())
                    .collect::<Vec<_>>()
                    .join(", "),
            ));
        }
        let digest = workflow_digest(definition)?;
        if let Some(existing) = self
            .connection
            .query_row(
                "SELECT id, name, schema_version, digest, definition_json, created_at
                 FROM workflow_versions WHERE digest = ?1",
                [&digest],
                workflow_version_from_row,
            )
            .optional()?
        {
            return Ok(existing);
        }
        let record = WorkflowVersionRecord {
            workflow_version_id: Uuid::new_v4(),
            name: definition.name.clone(),
            schema_version: definition.schema_version,
            digest,
            definition: definition.clone(),
            created_at: timestamp(),
        };
        self.connection.execute(
            "INSERT INTO workflow_versions(
                id, name, schema_version, digest, definition_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.workflow_version_id.to_string(),
                record.name,
                record.schema_version,
                record.digest,
                serde_json::to_string(&record.definition)?,
                record.created_at,
            ],
        )?;
        Ok(record)
    }

    pub fn list_workflow_versions(&self) -> Result<Vec<WorkflowVersionRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, schema_version, digest, definition_json, created_at
             FROM workflow_versions
             ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], workflow_version_from_row)?;
        let mut versions = Vec::new();
        for row in rows {
            versions.push(row?);
        }
        Ok(versions)
    }

    pub fn list_checkpoints(&self, run_id: Uuid) -> Result<Vec<CheckpointRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, run_id, attempt_id, base_sha, commit_sha,
                    controlled_files_json, marker, no_changes, created_at
             FROM checkpoints
             WHERE run_id = ?1
             ORDER BY created_at ASC",
        )?;
        let rows = statement.query_map([run_id.to_string()], checkpoint_from_row)?;
        let mut checkpoints = Vec::new();
        for row in rows {
            checkpoints.push(row?);
        }
        Ok(checkpoints)
    }

    pub fn list_resource_locks(&self) -> Result<Vec<ResourceLockRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT resource_type, resource_id, attempt_id, acquired_at
             FROM resource_locks
             ORDER BY acquired_at ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let attempt_str: String = row.get(2)?;
            let attempt_id = parse_uuid("resource lock attempt", &attempt_str)
                .map_err(|error| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error)))?;
            Ok(ResourceLockRecord {
                resource_type: row.get(0)?,
                resource_id: row.get(1)?,
                attempt_id,
                acquired_at: row.get(3)?,
            })
        })?;
        let mut locks = Vec::new();
        for row in rows {
            locks.push(row?);
        }
        Ok(locks)
    }

    pub fn get_checkpoint_diff(&self, checkpoint_id: Uuid) -> Result<String, StorageError> {
        let (workspace_path, commit_sha): (String, String) = self.connection.query_row(
            "SELECT w.path, c.commit_sha
             FROM checkpoints c
             JOIN workspaces w ON w.id = c.workspace_id
             WHERE c.id = ?1",
            [checkpoint_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let path = std::path::PathBuf::from(&workspace_path);
        if !path.exists() {
            return Ok(format!("工作区目录暂未保留或已清理: {workspace_path} (Commit: {commit_sha})"));
        }

        let output = std::process::Command::new("git")
            .current_dir(&path)
            .args(["show", "--stat", "--patch", &commit_sha])
            .output();

        match output {
            Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
            Ok(out) => Ok(format!("git show 异常: {}", String::from_utf8_lossy(&out.stderr))),
            Err(err) => Ok(format!("执行 git 命令失败: {err}")),
        }
    }

    pub fn list_schedules(&self) -> Result<Vec<ScheduleRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, cron, timezone, target_workflow_name, active, overlap_policy, last_run_at, created_at
             FROM schedules ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let active_int: i32 = row.get(5)?;
            Ok(ScheduleRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                cron: row.get(2)?,
                timezone: row.get(3)?,
                target_workflow_name: row.get(4)?,
                active: active_int == 1,
                overlap_policy: row.get(6)?,
                last_run_at: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;
        let mut list = Vec::new();
        for row in rows {
            list.push(row?);
        }
        Ok(list)
    }

    pub fn save_schedule(&self, schedule: &ScheduleRecord) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO schedules(id, name, cron, timezone, target_workflow_name, active, overlap_policy, last_run_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                cron = excluded.cron,
                timezone = excluded.timezone,
                target_workflow_name = excluded.target_workflow_name,
                active = excluded.active,
                overlap_policy = excluded.overlap_policy,
                last_run_at = excluded.last_run_at",
            params![
                schedule.id,
                schedule.name,
                schedule.cron,
                schedule.timezone,
                schedule.target_workflow_name,
                if schedule.active { 1 } else { 0 },
                schedule.overlap_policy,
                schedule.last_run_at,
                schedule.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn toggle_schedule(&self, id: &str) -> Result<bool, StorageError> {
        let current_active: i32 = self.connection.query_row(
            "SELECT active FROM schedules WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        let new_active = if current_active == 1 { 0 } else { 1 };
        self.connection.execute(
            "UPDATE schedules SET active = ?1 WHERE id = ?2",
            params![new_active, id],
        )?;
        Ok(new_active == 1)
    }

    pub fn delete_schedule(&self, id: &str) -> Result<(), StorageError> {
        self.connection.execute("DELETE FROM schedules WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn list_goals(&self) -> Result<Vec<GoalRecord>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, description, status, deadline, actions_used, actions_budget, created_at
             FROM goals ORDER BY created_at ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, u32>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;

        let mut goals = Vec::new();
        for row in rows {
            let (id, title, description, status, deadline, actions_used, actions_budget, created_at) = row?;
            let mut m_stmt = self.connection.prepare(
                "SELECT id, goal_id, title, completed, sort_order
                 FROM milestones WHERE goal_id = ?1 ORDER BY sort_order ASC",
            )?;
            let m_rows = m_stmt.query_map([&id], |m_row| {
                let completed_int: i32 = m_row.get(3)?;
                Ok(MilestoneRecord {
                    id: m_row.get(0)?,
                    goal_id: m_row.get(1)?,
                    title: m_row.get(2)?,
                    completed: completed_int == 1,
                    sort_order: m_row.get(4)?,
                })
            })?;
            let mut milestones = Vec::new();
            for m in m_rows {
                milestones.push(m?);
            }
            goals.push(GoalRecord {
                id,
                title,
                description,
                status,
                deadline,
                actions_used,
                actions_budget,
                created_at,
                milestones,
            });
        }
        Ok(goals)
    }

    pub fn save_goal(&self, goal: &GoalRecord) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO goals(id, title, description, status, deadline, actions_used, actions_budget, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                status = excluded.status,
                deadline = excluded.deadline,
                actions_used = excluded.actions_used,
                actions_budget = excluded.actions_budget",
            params![
                goal.id,
                goal.title,
                goal.description,
                goal.status,
                goal.deadline,
                goal.actions_used,
                goal.actions_budget,
                goal.created_at,
            ],
        )?;

        for (index, m) in goal.milestones.iter().enumerate() {
            self.connection.execute(
                "INSERT INTO milestones(id, goal_id, title, completed, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                    title = excluded.title,
                    completed = excluded.completed,
                    sort_order = excluded.sort_order",
                params![
                    m.id,
                    goal.id,
                    m.title,
                    if m.completed { 1 } else { 0 },
                    index as i32,
                ],
            )?;
        }
        Ok(())
    }

    pub fn toggle_milestone(&self, milestone_id: &str) -> Result<bool, StorageError> {
        let completed: i32 = self.connection.query_row(
            "SELECT completed FROM milestones WHERE id = ?1",
            [milestone_id],
            |row| row.get(0),
        )?;
        let new_completed = if completed == 1 { 0 } else { 1 };
        self.connection.execute(
            "UPDATE milestones SET completed = ?1 WHERE id = ?2",
            params![new_completed, milestone_id],
        )?;
        Ok(new_completed == 1)
    }

    pub fn delete_goal(&self, id: &str) -> Result<(), StorageError> {
        self.connection.execute("DELETE FROM goals WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn record_approval(
        &mut self,
        approval: &ApprovalRecord,
    ) -> Result<ApprovalRecord, StorageError> {
        self.connection.execute(
            "INSERT OR IGNORE INTO approvals(
                id, run_id, candidate_commit, workflow_digest, decision,
                comment, created_at, invalidated_at, invalidation_reason
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                approval.approval_id.to_string(),
                approval.run_id.to_string(),
                approval.candidate_commit,
                approval.workflow_digest,
                approval.decision.as_str(),
                approval.comment,
                approval.created_at,
                approval.invalidated_at,
                approval.invalidation_reason,
            ],
        )?;
        self.connection
            .query_row(
                "SELECT id, run_id, candidate_commit, workflow_digest, decision,
                    comment, created_at, invalidated_at, invalidation_reason
             FROM approvals
             WHERE run_id = ?1 AND candidate_commit = ?2 AND workflow_digest = ?3
               AND decision = ?4 AND comment = ?5",
                params![
                    approval.run_id.to_string(),
                    approval.candidate_commit,
                    approval.workflow_digest,
                    approval.decision.as_str(),
                    approval.comment,
                ],
                approval_from_row,
            )
            .map_err(Into::into)
    }

    pub fn invalidate_approvals_for_candidate_change(
        &mut self,
        run_id: Uuid,
        current_candidate: &str,
    ) -> Result<u32, StorageError> {
        let changed = self.connection.execute(
            "UPDATE approvals
             SET invalidated_at = ?1, invalidation_reason = 'candidate_changed'
             WHERE run_id = ?2 AND candidate_commit <> ?3 AND invalidated_at IS NULL",
            params![timestamp(), run_id.to_string(), current_candidate],
        )?;
        u32::try_from(changed).map_err(|_| StorageError::IntegerOutOfRange(changed as u64))
    }

    pub fn valid_approval(
        &self,
        run_id: Uuid,
        candidate_commit: &str,
        workflow_digest: &str,
    ) -> Result<Option<ApprovalRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT id, run_id, candidate_commit, workflow_digest, decision,
                        comment, created_at, invalidated_at, invalidation_reason
                 FROM approvals
                 WHERE run_id = ?1 AND candidate_commit = ?2 AND workflow_digest = ?3
                   AND decision = 'approved' AND invalidated_at IS NULL
                 ORDER BY created_at DESC LIMIT 1",
                params![run_id.to_string(), candidate_commit, workflow_digest],
                approval_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn create_development_run(
        &mut self,
        request: CreateDevelopmentRunRequest,
        workflow: &WorkflowVersionRecord,
        flow: &DevelopmentLoop,
    ) -> Result<DevelopmentRunSnapshot, StorageError> {
        let title = request.title.trim();
        let description = request.description.trim();
        if title.is_empty() || description.is_empty() {
            return Err(StorageError::InvalidTask);
        }
        let task_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let now = timestamp();
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO tasks(id, title, description, acceptance_criteria_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                task_id.to_string(),
                title,
                description,
                serde_json::to_string(&request.acceptance_criteria)?,
                now,
            ],
        )?;
        tx.execute(
            "INSERT INTO runs(
                id, task_id, trigger_source, config_snapshot_json,
                workflow_snapshot_json, state, created_at, started_at
             ) VALUES (?1, ?2, 'manual', ?3, ?4, 'running', ?5, ?5)",
            params![
                run_id.to_string(),
                task_id.to_string(),
                json!({
                    "kind": "development_workflow",
                    "workflowVersionID": workflow.workflow_version_id,
                    "workflowDigest": workflow.digest,
                    "roleBindings": workflow.definition.role_bindings,
                })
                .to_string(),
                serde_json::to_string(&workflow.definition)?,
                now,
            ],
        )?;
        insert_event(
            &tx,
            run_id,
            None,
            "run_created",
            json!({"state": RunState::Running, "workflowVersionID": workflow.workflow_version_id}),
            None,
        )?;
        insert_event(
            &tx,
            run_id,
            None,
            "development_flow_state",
            serde_json::to_value(flow)?,
            None,
        )?;
        ensure_pending_workflow_step(&tx, run_id, flow)?;
        tx.commit()?;
        Ok(DevelopmentRunSnapshot {
            run_id,
            task_id,
            workflow_version_id: workflow.workflow_version_id,
            flow: flow.clone(),
        })
    }

    pub fn development_run_snapshot(
        &self,
        run_id: Uuid,
    ) -> Result<DevelopmentRunSnapshot, StorageError> {
        let row = self
            .connection
            .query_row(
                "SELECT r.task_id, r.config_snapshot_json,
                        (SELECT payload_json FROM events e
                         WHERE e.run_id = r.id AND e.event_type = 'development_flow_state'
                         ORDER BY e.id DESC LIMIT 1)
                 FROM runs r WHERE r.id = ?1",
                [run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((task_value, config_json, flow_json)) = row else {
            return Err(StorageError::NotFound {
                entity: "development run",
                id: run_id,
            });
        };
        let config: serde_json::Value = serde_json::from_str(&config_json)?;
        let workflow_version = config
            .get("workflowVersionID")
            .and_then(|value| value.as_str())
            .ok_or_else(|| StorageError::InvalidIdentifier {
                entity: "workflow version",
                value: config_json.clone(),
            })?;
        let flow_json = flow_json.ok_or_else(|| StorageError::NotFound {
            entity: "development flow state",
            id: run_id,
        })?;
        Ok(DevelopmentRunSnapshot {
            run_id,
            task_id: parse_uuid("task", &task_value)?,
            workflow_version_id: parse_uuid("workflow version", workflow_version)?,
            flow: serde_json::from_str(&flow_json)?,
        })
    }

    pub fn persist_development_transition(
        &mut self,
        run_id: Uuid,
        transition: &WorkflowStepTransition,
        flow: &DevelopmentLoop,
    ) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transition.complete_step {
            let (step_value, state_value) = tx
                .query_row(
                    "SELECT id, state FROM step_executions
                     WHERE run_id = ?1 AND node_id = ?2 AND iteration_key = ?3",
                    params![
                        run_id.to_string(),
                        transition.node_id,
                        transition.iteration_key,
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::NotFound {
                    entity: "workflow step",
                    id: run_id,
                })?;
            let step_id = parse_uuid("step execution", &step_value)?;
            let step_state = StepExecutionState::from_str(&state_value)?;
            if !transition.step_succeeded && !transition.create_attempt {
                match step_state {
                    StepExecutionState::Pending => transition_step(
                        &tx,
                        run_id,
                        step_id,
                        StepExecutionState::Pending,
                        StepExecutionState::Skipped,
                    )?,
                    StepExecutionState::WaitingInput => {
                        transition_step(
                            &tx,
                            run_id,
                            step_id,
                            StepExecutionState::WaitingInput,
                            StepExecutionState::Failed,
                        )?;
                    }
                    _ => {
                        return Err(StorageError::InvalidTransition {
                            entity: "workflow step",
                            from: step_state.to_string(),
                            to: StepExecutionState::Skipped.to_string(),
                        });
                    }
                }
            } else {
                match step_state {
                    StepExecutionState::Pending => transition_step(
                        &tx,
                        run_id,
                        step_id,
                        StepExecutionState::Pending,
                        StepExecutionState::Running,
                    )?,
                    StepExecutionState::WaitingInput => transition_step(
                        &tx,
                        run_id,
                        step_id,
                        StepExecutionState::WaitingInput,
                        StepExecutionState::Running,
                    )?,
                    StepExecutionState::Running if transition.create_attempt => {}
                    _ => {
                        return Err(StorageError::InvalidTransition {
                            entity: "workflow step",
                            from: step_state.to_string(),
                            to: StepExecutionState::Running.to_string(),
                        });
                    }
                }
                let attempt_id = if transition.create_attempt {
                    Some(verified_workflow_attempt(&tx, run_id, step_id, transition)?)
                } else {
                    None
                };
                transition_step(
                    &tx,
                    run_id,
                    step_id,
                    StepExecutionState::Running,
                    if transition.step_succeeded {
                        StepExecutionState::Succeeded
                    } else {
                        StepExecutionState::Failed
                    },
                )?;
                insert_event(
                    &tx,
                    run_id,
                    attempt_id,
                    "workflow_node_completed",
                    json!({
                        "nodeID": transition.node_id,
                        "iterationKey": transition.iteration_key,
                        "result": transition.result,
                    }),
                    None,
                )?;
                if let Some(attempt_id) = attempt_id {
                    tx.execute(
                        "DELETE FROM resource_locks WHERE attempt_id = ?1",
                        [attempt_id.to_string()],
                    )?;
                }
            }
        }
        if let Some(approval) = &transition.approval {
            insert_approval(&tx, approval)?;
        }
        if let Some(candidate) = &transition.invalidate_for_candidate {
            tx.execute(
                "UPDATE approvals
                 SET invalidated_at = ?1, invalidation_reason = 'candidate_changed'
                 WHERE run_id = ?2 AND candidate_commit <> ?3 AND invalidated_at IS NULL",
                params![timestamp(), run_id.to_string(), candidate],
            )?;
        }
        synchronize_development_run_state(&tx, run_id, flow.phase)?;
        insert_event(
            &tx,
            run_id,
            None,
            "development_flow_state",
            serde_json::to_value(flow)?,
            None,
        )?;
        ensure_pending_workflow_step(&tx, run_id, flow)?;
        tx.commit()?;
        Ok(())
    }

    pub fn workflow_node_account(
        &self,
        run_id: Uuid,
        node_id: &str,
    ) -> Result<String, StorageError> {
        let definition: String = self.connection.query_row(
            "SELECT workflow_snapshot_json FROM runs WHERE id = ?1",
            [run_id.to_string()],
            |row| row.get(0),
        )?;
        let definition: WorkflowDefinition = serde_json::from_str(&definition)?;
        let node = definition
            .nodes
            .iter()
            .find(|node| node.id == node_id)
            .ok_or_else(|| StorageError::InvalidWorkflow("missing workflow node".into()))?;
        if node.kind == crate::workflow::NodeKind::Command {
            return Ok(format!("command:{run_id}:{node_id}"));
        }
        node.role
            .as_ref()
            .and_then(|role| definition.role_bindings.get(role))
            .cloned()
            .ok_or_else(|| StorageError::InvalidWorkflow("missing node account binding".into()))
    }

    pub fn enable_mock_development_execution(
        &mut self,
        run_id: Uuid,
        execution: &MockDevelopmentExecution,
    ) -> Result<(), StorageError> {
        let snapshot = self.development_run_snapshot(run_id)?;
        if snapshot.flow.phase != DevelopmentPhase::Analysis || snapshot.flow.actions_used != 0 {
            return Err(StorageError::InvalidWorkflow(
                "automatic execution must be configured before analysis".into(),
            ));
        }
        let stored_workspace =
            self.workspace(run_id, execution.workspace.generation, "development")?;
        if execution.workspace.run_id != run_id
            || stored_workspace.as_ref() != Some(&execution.workspace)
        {
            return Err(StorageError::InvalidWorkflow(
                "execution workspace is not owned by this run".into(),
            ));
        }
        let encoded: String = self.connection.query_row(
            "SELECT workflow_snapshot_json FROM runs WHERE id = ?1",
            [run_id.to_string()],
            |row| row.get(0),
        )?;
        let definition: WorkflowDefinition = serde_json::from_str(&encoded)?;
        let mut supported = crate::development_flow::standard_development_workflow();
        supported.name = definition.name.clone();
        supported.role_bindings = definition.role_bindings.clone();
        supported.budget = definition.budget;
        if definition != supported
            || definition
                .role_bindings
                .values()
                .any(|account| !account.starts_with("mock:"))
        {
            return Err(StorageError::InvalidWorkflow("automatic mock execution requires the standard template and explicit mock accounts".into()));
        }
        let config = serde_json::to_value(execution)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<String> = tx.query_row("SELECT payload_json FROM events WHERE run_id = ?1 AND event_type = 'mock_development_enabled'",
            [run_id.to_string()], |row| row.get(0)).optional()?;
        if let Some(previous) = previous {
            if serde_json::from_str::<serde_json::Value>(&previous)? != config {
                return Err(StorageError::InvalidWorkflow(
                    "execution configuration is immutable".into(),
                ));
            }
        } else {
            insert_event(&tx, run_id, None, "mock_development_enabled", config, None)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn automatic_development_runs(
        &self,
    ) -> Result<Vec<(Uuid, MockDevelopmentExecution)>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT r.id, e.payload_json FROM runs r JOIN events e ON e.run_id = r.id
             WHERE r.state = 'running' AND e.event_type = 'mock_development_enabled'
             ORDER BY r.created_at, r.id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (run, config) = row?;
            Ok((parse_uuid("run", &run)?, serde_json::from_str(&config)?))
        })
        .collect()
    }

    pub fn checkpoint_for_candidate(
        &self,
        run_id: Uuid,
        candidate: &str,
    ) -> Result<Option<CheckpointRecord>, StorageError> {
        self.connection
            .query_row(
                "SELECT id, workspace_id, run_id, attempt_id, base_sha, commit_sha,
                    controlled_files_json, marker, no_changes, created_at
             FROM checkpoints WHERE run_id = ?1 AND commit_sha = ?2 ORDER BY rowid DESC LIMIT 1",
                params![run_id.to_string(), candidate],
                checkpoint_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn interrupt_development_run(
        &mut self,
        run_id: Uuid,
        reason: &str,
    ) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: String = tx.query_row(
            "SELECT state FROM runs WHERE id = ?1",
            [run_id.to_string()],
            |row| row.get(0),
        )?;
        if state == RunState::Running.as_str() {
            transition_run(&tx, run_id, RunState::Running, RunState::Interrupted)?;
            tx.execute(
                "UPDATE runs SET waiting_reason = ?1 WHERE id = ?2",
                params![reason, run_id.to_string()],
            )?;
            insert_event(
                &tx,
                run_id,
                None,
                "development_execution_interrupted",
                json!({"reason":reason,"locksRetained":true}),
                None,
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn prepare_development_attempt(
        &mut self,
        run_id: Uuid,
        spec: &NodeLaunchSpec,
        data_directory: &Path,
        global_limit: u32,
    ) -> Result<Option<PreparedAttempt>, StorageError> {
        let snapshot = self.development_run_snapshot(run_id)?;
        let (node, iteration, waiting) = pending_step(&snapshot.flow).ok_or_else(|| {
            StorageError::InvalidWorkflow("workflow has no executable node".into())
        })?;
        if waiting {
            return Err(StorageError::InvalidWorkflow(
                "approval requires human input".into(),
            ));
        }
        let account = self.workflow_node_account(run_id, &node)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let step: Option<String> = tx
            .query_row(
                "SELECT s.id FROM step_executions s JOIN runs r ON r.id = s.run_id
             WHERE s.run_id = ?1 AND s.node_id = ?2 AND s.iteration_key = ?3
               AND s.state = 'pending' AND r.state = 'running'",
                params![run_id.to_string(), node, iteration],
                |row| row.get(0),
            )
            .optional()?;
        let Some(step) = step else {
            return Ok(None);
        };
        let workspace_resource = spec
            .working_directory
            .to_str()
            .ok_or_else(|| StorageError::InvalidWorkflow("workspace path is not UTF-8".into()))?;
        let busy: bool = tx.query_row(
            "SELECT (SELECT COUNT(*) FROM attempts WHERE state IN ('prepared','starting','running','finalizing')) >= ?1
             OR EXISTS(SELECT 1 FROM resource_locks WHERE
                 (resource_type = 'account' AND resource_id = ?2)
                 OR (resource_type = 'workspace' AND resource_id = ?3))",
            params![global_limit, account, workspace_resource], |row| row.get(0),
        )?;
        if busy {
            return Ok(None);
        }
        let step_id = parse_uuid("step execution", &step)?;
        let attempt_id = Uuid::new_v4();
        let token = Uuid::new_v4().to_string();
        let directory = data_directory
            .join("runs")
            .join(run_id.to_string())
            .join("attempts")
            .join(attempt_id.to_string());
        let manifest = LaunchManifest {
            schema_version: RUNNER_PROTOCOL_VERSION,
            attempt_id,
            execution_token: token.clone(),
            executable_path: spec.executable_path.clone(),
            arguments: spec.arguments.clone(),
            working_directory: spec.working_directory.clone(),
            environment: spec.environment.clone(),
            stdout_path: directory.join("stdout.log"),
            stderr_path: directory.join("stderr.log"),
            identity_path: directory.join("identity.json"),
            heartbeat_path: directory.join("heartbeat.json"),
            cancellation_path: directory.join("control/cancel.json"),
            result_path: directory.join("result.json"),
            timeout_seconds: spec.timeout_seconds,
            cancellation_grace_seconds: spec.cancellation_grace_seconds,
        };
        manifest
            .validate()
            .map_err(|error| StorageError::InvalidWorkflow(error.to_string()))?;
        let encoded = serde_json::to_string(&manifest)?;
        let digest = format!("{:x}", Sha256::digest(encoded.as_bytes()));
        let now = timestamp();
        tx.execute(
            "INSERT INTO attempts(id, step_execution_id, attempt_number, requested_account_id,
             actual_account_id, state, input_digest, runner_token, created_at)
             VALUES (?1, ?2, 1, ?3, ?3, 'prepared', ?4, ?5, ?6)",
            params![attempt_id.to_string(), step, account, digest, token, now],
        )?;
        for (kind, resource) in [
            ("account", account.as_str()),
            ("workspace", workspace_resource),
        ] {
            tx.execute("INSERT INTO resource_locks(resource_type, resource_id, attempt_id, acquired_at) VALUES (?1, ?2, ?3, ?4)",
                params![kind, resource, attempt_id.to_string(), now])?;
        }
        insert_event(
            &tx,
            run_id,
            Some(attempt_id),
            "workflow_launch_prepared",
            serde_json::to_value(&manifest)?,
            None,
        )?;
        transition_step(
            &tx,
            run_id,
            step_id,
            StepExecutionState::Pending,
            StepExecutionState::Running,
        )?;
        tx.commit()?;
        Ok(Some(PreparedAttempt {
            run_id,
            step_execution_id: step_id,
            attempt_id,
            execution_token: token,
            account_id: account,
            outcome: MockOutcome::Succeeded,
            delay_milliseconds: None,
        }))
    }

    pub fn workflow_launch(
        &self,
        attempt_id: Uuid,
    ) -> Result<Option<LaunchManifest>, StorageError> {
        let value: Option<String> = self.connection.query_row(
            "SELECT payload_json FROM events WHERE attempt_id = ?1 AND event_type = 'workflow_launch_prepared' ORDER BY id DESC LIMIT 1",
            [attempt_id.to_string()], |row| row.get(0),
        ).optional()?;
        value
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn active_attempts(&self) -> Result<Vec<ActiveAttempt>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT r.id, s.id, a.id, a.runner_token, a.state,
                    r.config_snapshot_json, a.created_at
             FROM attempts a
             JOIN step_executions s ON s.id = a.step_execution_id
             JOIN runs r ON r.id = s.run_id
             WHERE a.state IN ('prepared', 'starting', 'running', 'finalizing')
             ORDER BY a.created_at ASC, a.id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (run, step, attempt, token, state, config, created_at) = row?;
            let config: serde_json::Value = serde_json::from_str(&config)?;
            let outcome = serde_json::from_value(
                config
                    .get("outcome")
                    .cloned()
                    .unwrap_or_else(|| json!("succeeded")),
            )?;
            let delay_milliseconds = config
                .get("delayMilliseconds")
                .and_then(|value| value.as_u64());
            Ok(ActiveAttempt {
                run_id: parse_uuid("run", &run)?,
                step_execution_id: parse_uuid("step execution", &step)?,
                attempt_id: parse_uuid("attempt", &attempt)?,
                execution_token: token,
                state: AttemptState::from_str(&state)?,
                outcome,
                delay_milliseconds,
                created_at,
            })
        })
        .collect()
    }

    pub fn list_runs(&self) -> Result<Vec<RunSummary>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT r.id, r.task_id, t.title, t.description, r.state, a.state,
                    r.created_at, r.finished_at
             FROM runs r
             JOIN tasks t ON t.id = r.task_id
             JOIN step_executions s ON s.id = (
                 SELECT current.id FROM step_executions current WHERE current.run_id = r.id
                 ORDER BY (current.state IN ('running', 'waiting_input', 'pending')) DESC,
                          current.rowid DESC LIMIT 1
             )
             LEFT JOIN attempts a ON a.step_execution_id = s.id
               AND a.attempt_number = (
                   SELECT MAX(a2.attempt_number) FROM attempts a2
                   WHERE a2.step_execution_id = s.id
               )
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT 50",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;

        rows.map(|row| {
            let (
                run_id,
                task_id,
                title,
                description,
                run_state,
                attempt_state,
                created_at,
                finished_at,
            ) = row?;
            Ok(RunSummary {
                run_id: parse_uuid("run", &run_id)?,
                task_id: parse_uuid("task", &task_id)?,
                title,
                description,
                run_state: RunState::from_str(&run_state)?,
                attempt_state: attempt_state
                    .map(|state| AttemptState::from_str(&state))
                    .transpose()?,
                created_at,
                finished_at,
            })
        })
        .collect()
    }

    pub fn get_run(&self, run_id: Uuid) -> Result<RunDetail, StorageError> {
        let row = self
            .connection
            .query_row(
                "SELECT r.id, r.task_id, s.id, a.id, t.title, t.description,
                        t.acceptance_criteria_json, r.state, s.state, a.state,
                        a.attempt_number, a.result_json, a.error_code,
                        r.created_at, r.finished_at,
                        json_extract(r.config_snapshot_json, '$.kind'), r.waiting_reason
                 FROM runs r
                 JOIN tasks t ON t.id = r.task_id
                 JOIN step_executions s ON s.id = (
                     SELECT current.id FROM step_executions current WHERE current.run_id = r.id
                     ORDER BY (current.state IN ('running', 'waiting_input', 'pending')) DESC,
                              current.rowid DESC LIMIT 1
                 )
                 LEFT JOIN attempts a ON a.step_execution_id = s.id
                   AND a.attempt_number = (
                       SELECT MAX(a2.attempt_number) FROM attempts a2
                       WHERE a2.step_execution_id = s.id
                   )
                 WHERE r.id = ?1",
                [run_id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<u32>>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, Option<String>>(14)?,
                        row.get::<_, Option<String>>(15)?,
                        row.get::<_, Option<String>>(16)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            run_id_value,
            task_id,
            step_id,
            attempt_id,
            title,
            description,
            acceptance_json,
            run_state,
            step_state,
            attempt_state,
            attempt_number,
            result_json,
            error_code,
            created_at,
            finished_at,
            workflow_kind,
            waiting_reason,
        )) = row
        else {
            return Err(StorageError::NotFound {
                entity: "run",
                id: run_id,
            });
        };

        Ok(RunDetail {
            workflow_kind,
            waiting_reason,
            run_id: parse_uuid("run", &run_id_value)?,
            task_id: parse_uuid("task", &task_id)?,
            step_execution_id: parse_uuid("step execution", &step_id)?,
            attempt_id: attempt_id
                .map(|value| parse_uuid("attempt", &value))
                .transpose()?,
            title,
            description,
            acceptance_criteria: serde_json::from_str(&acceptance_json)?,
            run_state: RunState::from_str(&run_state)?,
            step_state: StepExecutionState::from_str(&step_state)?,
            attempt_state: attempt_state
                .map(|state| AttemptState::from_str(&state))
                .transpose()?,
            attempt_number,
            result: result_json
                .map(|value| serde_json::from_str(&value))
                .transpose()?,
            error_code,
            created_at,
            finished_at,
        })
    }

    pub fn import_runner_event(
        &mut self,
        run_id: Uuid,
        attempt_id: Uuid,
        sequence: u64,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Result<bool, StorageError> {
        let sequence_value =
            i64::try_from(sequence).map_err(|_| StorageError::InvalidEventSequence(sequence))?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO events(
                run_id, attempt_id, event_type, payload_json, runner_event_seq, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run_id.to_string(),
                attempt_id.to_string(),
                event_type,
                payload.to_string(),
                sequence_value,
                timestamp(),
            ],
        )? == 1;
        tx.commit()?;
        Ok(inserted)
    }

    pub fn transition_attempt_state(
        &mut self,
        run_id: Uuid,
        attempt_id: Uuid,
        from: AttemptState,
        to: AttemptState,
    ) -> Result<(), StorageError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transition_attempt(&tx, run_id, attempt_id, from, to, None, None)?;
        tx.commit()?;
        Ok(())
    }

    #[cfg(test)]
    fn count_events(&self, attempt_id: Uuid, sequence: u64) -> Result<u32, StorageError> {
        let sequence_value =
            i64::try_from(sequence).map_err(|_| StorageError::InvalidEventSequence(sequence))?;
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM events WHERE attempt_id = ?1 AND runner_event_seq = ?2",
            params![attempt_id.to_string(), sequence_value],
            |row| row.get(0),
        )?)
    }
}

fn migrate(connection: &mut Connection) -> Result<(), StorageError> {
    // Rebuilding workspaces preserves IDs referenced by checkpoints. Foreign keys
    // are checked before commit and re-enabled even when migration rolls back.
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    let result = migrate_transaction(connection);
    let restored = connection.pragma_update(None, "foreign_keys", "ON");
    result?;
    restored?;
    Ok(())
}

fn migrate_transaction(connection: &mut Connection) -> Result<(), StorageError> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            applied_at TEXT NOT NULL
         ) STRICT;",
    )?;
    let current: u32 = tx.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if current < 1 {
        tx.execute_batch(MIGRATION_1)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            [timestamp()],
        )?;
    }
    if current < 2 {
        tx.execute_batch(MIGRATION_2)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?1)",
            [timestamp()],
        )?;
    }
    if current < 3 {
        tx.execute_batch(MIGRATION_3)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?1)",
            [timestamp()],
        )?;
    }
    if current < 4 {
        tx.execute_batch(MIGRATION_4)?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (4, ?1)",
            [timestamp()],
        )?;
        if tx
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
        {
            return Err(StorageError::MigrationIntegrity);
        }
    }
    if current < 5 {
        tx.execute_batch(MIGRATION_5)?;
        let now = timestamp();
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (5, ?1)",
            [&now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO schedules(id, name, cron, timezone, target_workflow_name, active, overlap_policy, last_run_at, created_at)
             VALUES ('sched-1', '每日全量代码架构与安全性巡检', '每天 02:00', 'Asia/Shanghai (本机时区)', 'Claude 3.5 Sonnet (极高推理)', 1, 'skip', '2026-09-17 02:00:00', ?1),
                    ('sched-2', '每两小时系统自检与 SQLite WAL 对账', '每 2 小时', 'Asia/Shanghai (本机时区)', 'GPT-4o (快速响应)', 1, 'skip', '2026-09-18 08:00:00', ?1)",
            [&now],
        )?;
        let _ = tx.execute(
            "UPDATE schedules SET cron = '每天 02:00', target_workflow_name = 'Claude 3.5 Sonnet (极高推理)' WHERE id = 'sched-1' AND cron LIKE '%0 2 * * *%'",
            [],
        );
        let _ = tx.execute(
            "UPDATE schedules SET cron = '每 2 小时', target_workflow_name = 'GPT-4o (快速响应)' WHERE id = 'sched-2' AND cron LIKE '%0 */2 * * *%'",
            [],
        );
        tx.execute(
            "INSERT OR IGNORE INTO goals(id, title, description, status, deadline, actions_used, actions_budget, created_at)
             VALUES ('goal-1', '构建端到端高可靠 Agent 本地开发闭环', '实现通过本地独立 runner 驱动 Agent 完成任务分析、代码修改、真实 Git Checkpoint 生成、自动化测试与 Review 返工。', 'in_progress', '2026-10-01', 14, 50, ?1),
                    ('goal-2', '本地 Agent 故障恢复矩阵与数据自愈', '模拟宿主进程 SIGKILL、睡眠唤醒、磁盘写满与断网，保证事务对账与零双开。', 'in_progress', '2026-10-15', 8, 30, ?1)",
            [&now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO milestones(id, goal_id, title, completed, sort_order)
             VALUES ('m-1', 'goal-1', 'Git Worktree 隔离与 Checkpoint 幂等留痕 (P5)', 1, 1),
                    ('m-2', 'goal-1', '独立 Runner 进程、双流重定向与超时控制 (P3)', 1, 2),
                    ('m-3', 'goal-1', '工作流不可变版本与人工审批机制 (P6)', 1, 3),
                    ('m-4', 'goal-1', 'React Flow 可视化工作流设计器 (P9)', 1, 4),
                    ('m-5', 'goal-1', '真实 Codex / Claude CLI 生产适配器对接 (P4)', 0, 5),
                    ('m-21', 'goal-2', 'prepared 阶段宿主异常退出自动恢复测试', 1, 1),
                    ('m-22', 'goal-2', '未知状态保留资源锁与防重复领取', 1, 2),
                    ('m-23', 'goal-2', '崩溃恢复控制中心与手动强制干预', 0, 3)",
            [],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        project_id: uuid_from_row(row, 0)?,
        root_path: row.get(1)?,
        git_common_directory: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn workspace_from_row(row: &Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    let source_checkpoint = row.get::<_, Option<String>>(8)?;
    Ok(WorkspaceRecord {
        workspace_id: uuid_from_row(row, 0)?,
        run_id: uuid_from_row(row, 1)?,
        project_id: uuid_from_row(row, 2)?,
        generation: row.get(3)?,
        kind: row.get(4)?,
        base_sha: row.get(5)?,
        branch_name: row.get(6)?,
        path: row.get(7)?,
        source_checkpoint_id: source_checkpoint
            .map(|value| uuid_from_text(8, &value))
            .transpose()?,
        created_at: row.get(9)?,
    })
}

fn checkpoint_from_row(row: &Row<'_>) -> rusqlite::Result<CheckpointRecord> {
    let controlled_files = row.get::<_, String>(6)?;
    Ok(CheckpointRecord {
        checkpoint_id: uuid_from_row(row, 0)?,
        workspace_id: uuid_from_row(row, 1)?,
        run_id: uuid_from_row(row, 2)?,
        attempt_id: uuid_from_row(row, 3)?,
        base_sha: row.get(4)?,
        commit_sha: row.get(5)?,
        controlled_files: serde_json::from_str(&controlled_files).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(6, Type::Text, Box::new(error))
        })?,
        marker: row.get(7)?,
        no_changes: row.get(8)?,
        created_at: row.get(9)?,
    })
}

fn artifact_from_row(row: &Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    let byte_size = row.get::<_, i64>(5)?;
    Ok(ArtifactRecord {
        artifact_id: uuid_from_row(row, 0)?,
        run_id: uuid_from_row(row, 1)?,
        attempt_id: uuid_from_row(row, 2)?,
        artifact_type: row.get(3)?,
        relative_path: row.get(4)?,
        byte_size: u64::try_from(byte_size).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(5, Type::Integer, Box::new(error))
        })?,
        content_hash: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn workflow_version_from_row(row: &Row<'_>) -> rusqlite::Result<WorkflowVersionRecord> {
    let definition_json = row.get::<_, String>(4)?;
    Ok(WorkflowVersionRecord {
        workflow_version_id: uuid_from_row(row, 0)?,
        name: row.get(1)?,
        schema_version: row.get(2)?,
        digest: row.get(3)?,
        definition: serde_json::from_str(&definition_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(4, Type::Text, Box::new(error))
        })?,
        created_at: row.get(5)?,
    })
}

fn approval_from_row(row: &Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    let decision = match row.get::<_, String>(4)?.as_str() {
        "approved" => ApprovalDecision::Approved,
        "rejected" => ApprovalDecision::Rejected,
        value => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("invalid approval decision: {value}"),
                )),
            ));
        }
    };
    Ok(ApprovalRecord {
        approval_id: uuid_from_row(row, 0)?,
        run_id: uuid_from_row(row, 1)?,
        candidate_commit: row.get(2)?,
        workflow_digest: row.get(3)?,
        decision,
        comment: row.get(5)?,
        created_at: row.get(6)?,
        invalidated_at: row.get(7)?,
        invalidation_reason: row.get(8)?,
    })
}

fn uuid_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    uuid_from_text(index, &row.get::<_, String>(index)?)
}

fn uuid_from_text(index: usize, value: &str) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn verified_workflow_attempt(
    tx: &Transaction<'_>,
    _run_id: Uuid,
    step_id: Uuid,
    transition: &WorkflowStepTransition,
) -> Result<Uuid, StorageError> {
    let evidence: Option<(String, String)> = tx
        .query_row(
            "SELECT id, result_json FROM attempts
         WHERE step_execution_id = ?1 AND state = 'succeeded'
           AND actual_account_id = ?2 AND result_json IS NOT NULL
         ORDER BY attempt_number DESC LIMIT 1",
            params![step_id.to_string(), transition.account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (id, result) = evidence.ok_or_else(|| {
        StorageError::InvalidWorkflow(
            "workflow completion requires a persisted runner result".into(),
        )
    })?;
    let evidence: serde_json::Value = serde_json::from_str(&result)?;
    let matches = if transition.node_id == "development" {
        let candidate = transition
            .result
            .get("candidateCommit")
            .and_then(|value| value.as_str())
            .ok_or_else(|| StorageError::InvalidWorkflow("missing checkpoint commit".into()))?;
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM checkpoints WHERE attempt_id = ?1 AND commit_sha = ?2)",
            params![id, candidate],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        evidence.pointer("/output/result") == Some(&transition.result)
    };
    if !matches {
        return Err(StorageError::InvalidWorkflow(
            "workflow result does not match execution evidence".into(),
        ));
    }
    parse_uuid("attempt", &id)
}

fn insert_approval(tx: &Transaction<'_>, approval: &ApprovalRecord) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO approvals(id, run_id, candidate_commit, workflow_digest, decision,
             comment, created_at, invalidated_at, invalidation_reason)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            approval.approval_id.to_string(),
            approval.run_id.to_string(),
            approval.candidate_commit,
            approval.workflow_digest,
            approval.decision.as_str(),
            approval.comment,
            approval.created_at,
            approval.invalidated_at,
            approval.invalidation_reason
        ],
    )?;
    Ok(())
}

fn synchronize_development_run_state(
    tx: &Transaction<'_>,
    run_id: Uuid,
    phase: DevelopmentPhase,
) -> Result<(), StorageError> {
    let value: String = tx.query_row(
        "SELECT state FROM runs WHERE id = ?1",
        [run_id.to_string()],
        |row| row.get(0),
    )?;
    let mut current = RunState::from_str(&value)?;
    let target = match phase {
        DevelopmentPhase::HumanApproval | DevelopmentPhase::WaitingInfrastructure => {
            RunState::WaitingInput
        }
        DevelopmentPhase::Completed => RunState::Succeeded,
        DevelopmentPhase::Exhausted => RunState::Failed,
        _ => RunState::Running,
    };
    if current == RunState::WaitingInput && target != RunState::WaitingInput {
        transition_run(tx, run_id, current, RunState::Running)?;
        current = RunState::Running;
    }
    if current != target {
        transition_run(tx, run_id, current, target)?;
    }
    Ok(())
}

fn ensure_pending_workflow_step(
    tx: &Transaction<'_>,
    run_id: Uuid,
    flow: &DevelopmentLoop,
) -> Result<(), StorageError> {
    let Some((node_id, iteration_key, waiting)) = pending_step(flow) else {
        return Ok(());
    };
    let step_id = Uuid::new_v4();
    let inserted = tx.execute(
        "INSERT INTO step_executions(id, run_id, node_id, iteration_key, state, created_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
         ON CONFLICT(run_id, node_id, iteration_key) DO NOTHING",
        params![
            step_id.to_string(),
            run_id.to_string(),
            node_id,
            iteration_key,
            timestamp()
        ],
    )?;
    if inserted == 1 && waiting {
        transition_step(
            tx,
            run_id,
            step_id,
            StepExecutionState::Pending,
            StepExecutionState::Running,
        )?;
        transition_step(
            tx,
            run_id,
            step_id,
            StepExecutionState::Running,
            StepExecutionState::WaitingInput,
        )?;
    }
    Ok(())
}

fn transition_run(
    tx: &Transaction<'_>,
    run_id: Uuid,
    from: RunState,
    to: RunState,
) -> Result<(), StorageError> {
    if !from.can_transition_to(to) {
        return Err(invalid_transition("run", from, to));
    }
    let now = timestamp();
    let changed = tx.execute(
        "UPDATE runs SET state = ?1,
             started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?2 ELSE started_at END,
             finished_at = CASE WHEN ?1 IN ('succeeded', 'failed', 'cancelled') THEN ?2 ELSE finished_at END
         WHERE id = ?3 AND state = ?4",
        params![to.as_str(), now, run_id.to_string(), from.as_str()],
    )?;
    ensure_transition(changed, "run", run_id, from, to)?;
    insert_event(
        tx,
        run_id,
        None,
        "run_state_changed",
        json!({"from": from, "to": to}),
        None,
    )
}

fn transition_step(
    tx: &Transaction<'_>,
    run_id: Uuid,
    step_id: Uuid,
    from: StepExecutionState,
    to: StepExecutionState,
) -> Result<(), StorageError> {
    if !from.can_transition_to(to) {
        return Err(invalid_transition("step execution", from, to));
    }
    let now = timestamp();
    let changed = tx.execute(
        "UPDATE step_executions SET state = ?1,
             started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?2 ELSE started_at END,
             finished_at = CASE WHEN ?1 IN ('succeeded', 'failed', 'skipped') THEN ?2 ELSE finished_at END
         WHERE id = ?3 AND state = ?4",
        params![to.as_str(), now, step_id.to_string(), from.as_str()],
    )?;
    ensure_transition(changed, "step execution", step_id, from, to)?;
    insert_event(
        tx,
        run_id,
        None,
        "step_state_changed",
        json!({"stepExecutionID": step_id, "from": from, "to": to}),
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn transition_attempt(
    tx: &Transaction<'_>,
    run_id: Uuid,
    attempt_id: Uuid,
    from: AttemptState,
    to: AttemptState,
    result: Option<serde_json::Value>,
    error_code: Option<&str>,
) -> Result<(), StorageError> {
    if !from.can_transition_to(to) {
        return Err(invalid_transition("attempt", from, to));
    }
    let now = timestamp();
    let result_json = result.map(|value| value.to_string());
    let changed = tx.execute(
        "UPDATE attempts SET state = ?1,
             result_json = COALESCE(?2, result_json),
             error_code = COALESCE(?3, error_code),
             started_at = CASE WHEN ?1 = 'running' AND started_at IS NULL THEN ?4 ELSE started_at END,
             finished_at = CASE WHEN ?1 IN ('succeeded', 'failed', 'interrupted', 'cancelled') THEN ?4 ELSE finished_at END
         WHERE id = ?5 AND state = ?6",
        params![
            to.as_str(),
            result_json,
            error_code,
            now,
            attempt_id.to_string(),
            from.as_str(),
        ],
    )?;
    ensure_transition(changed, "attempt", attempt_id, from, to)?;
    insert_event(
        tx,
        run_id,
        Some(attempt_id),
        "attempt_state_changed",
        json!({"from": from, "to": to}),
        None,
    )
}

fn insert_event(
    tx: &Transaction<'_>,
    run_id: Uuid,
    attempt_id: Option<Uuid>,
    event_type: &str,
    payload: serde_json::Value,
    runner_event_seq: Option<i64>,
) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO events(
            run_id, attempt_id, event_type, payload_json, runner_event_seq, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            run_id.to_string(),
            attempt_id.map(|id| id.to_string()),
            event_type,
            payload.to_string(),
            runner_event_seq,
            timestamp(),
        ],
    )?;
    Ok(())
}

fn ensure_transition<F: ToString, T: ToString>(
    changed: usize,
    entity: &'static str,
    id: Uuid,
    from: F,
    to: T,
) -> Result<(), StorageError> {
    if changed == 1 {
        Ok(())
    } else {
        Err(StorageError::InvalidTransition {
            entity,
            from: format!("{} ({id})", from.to_string()),
            to: to.to_string(),
        })
    }
}

fn invalid_transition<F: ToString, T: ToString>(
    entity: &'static str,
    from: F,
    to: T,
) -> StorageError {
    StorageError::InvalidTransition {
        entity,
        from: from.to_string(),
        to: to.to_string(),
    }
}

fn parse_uuid(entity: &'static str, value: &str) -> Result<Uuid, StorageError> {
    Uuid::parse_str(value).map_err(|_| StorageError::InvalidIdentifier {
        entity,
        value: value.to_owned(),
    })
}

fn timestamp() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(outcome: MockOutcome) -> CreateMockTaskRequest {
        CreateMockTaskRequest {
            title: "Mock task".into(),
            description: "Persist one mock execution".into(),
            acceptance_criteria: vec!["result remains after reopen".into()],
            outcome,
            account_id: None,
            delay_milliseconds: None,
        }
    }

    fn request_for_account(account_id: &str) -> CreateMockTaskRequest {
        CreateMockTaskRequest {
            account_id: Some(account_id.to_owned()),
            ..request(MockOutcome::Succeeded)
        }
    }

    #[test]
    fn configures_connection_and_applies_migration_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agentflow.sqlite");
        let storage = Storage::open(&path).unwrap();

        let foreign_keys: u32 = storage
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let journal_mode: String = storage
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let busy_timeout: u32 = storage
            .connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        let migration_count: u32 = storage
            .connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode, "wal");
        assert_eq!(busy_timeout, 5_000);
        assert_eq!(migration_count, 5);
        drop(storage);

        let reopened = Storage::open(&path).unwrap();
        let migration_count: u32 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 5);
    }

    #[test]
    fn multistep_run_is_listed_once_and_detail_selects_current_step() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let run = storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        storage
            .connection
            .execute(
                "UPDATE step_executions SET state = 'succeeded' WHERE run_id = ?1",
                [run.run_id.to_string()],
            )
            .unwrap();
        let current = Uuid::new_v4();
        storage
            .connection
            .execute(
                "INSERT INTO step_executions(id, run_id, node_id, iteration_key, state, created_at)
             VALUES (?1, ?2, 'next-node', 'iteration-2', 'pending', ?3)",
                params![current.to_string(), run.run_id.to_string(), timestamp()],
            )
            .unwrap();
        assert_eq!(storage.list_runs().unwrap().len(), 1);
        assert_eq!(
            storage.get_run(run.run_id).unwrap().step_execution_id,
            current
        );
    }

    #[test]
    fn migration_four_preserves_existing_workspace_checkpoint_references() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection.execute_batch(MIGRATION_2).unwrap();
        connection.execute_batch(MIGRATION_3).unwrap();
        connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES(1,'fixture'),(2,'fixture'),(3,'fixture'); PRAGMA foreign_keys = ON;").unwrap();
        let mut storage = Storage { connection };
        let run = storage
            .create_and_execute_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let project = storage
            .register_project("/fixture/source", "/fixture/source/.git")
            .unwrap();
        let development = WorkspaceRecord {
            workspace_id: Uuid::new_v4(),
            run_id: run.run_id,
            project_id: project.project_id,
            generation: 1,
            kind: "development".into(),
            base_sha: "base".into(),
            branch_name: Some("fixture".into()),
            path: "/fixture/development".into(),
            source_checkpoint_id: None,
            created_at: timestamp(),
        };
        storage.insert_workspace(&development).unwrap();
        let checkpoint = CheckpointRecord {
            checkpoint_id: Uuid::new_v4(),
            workspace_id: development.workspace_id,
            run_id: run.run_id,
            attempt_id: run.attempt_id.unwrap(),
            base_sha: "base".into(),
            commit_sha: "candidate".into(),
            controlled_files: vec![],
            marker: "legacy-marker".into(),
            no_changes: false,
            created_at: timestamp(),
        };
        storage.insert_checkpoint(&checkpoint).unwrap();
        let review = WorkspaceRecord {
            workspace_id: Uuid::new_v4(),
            kind: "review".into(),
            branch_name: None,
            path: "/fixture/review".into(),
            source_checkpoint_id: Some(checkpoint.checkpoint_id),
            ..development.clone()
        };
        storage.insert_workspace(&review).unwrap();
        drop(storage);
        let mut reopened = Storage::open(&path).unwrap();
        assert_eq!(
            reopened.workspace(run.run_id, 1, "development").unwrap(),
            Some(development.clone())
        );
        assert_eq!(
            reopened
                .review_workspace(run.run_id, 1, checkpoint.checkpoint_id)
                .unwrap(),
            Some(review)
        );
        assert_eq!(
            reopened.checkpoint_by_marker("legacy-marker").unwrap(),
            Some(checkpoint)
        );
        assert!(
            reopened
                .connection
                .prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query([])
                .unwrap()
                .next()
                .unwrap()
                .is_none()
        );
        assert!(
            reopened
                .insert_workspace(&WorkspaceRecord {
                    workspace_id: Uuid::new_v4(),
                    path: "/fixture/duplicate".into(),
                    ..development
                })
                .is_err()
        );
        let enabled: bool = reopened
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert!(enabled);
    }

    #[test]
    fn migration_four_rolls_back_when_legacy_references_are_invalid() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection.execute_batch(MIGRATION_2).unwrap();
        connection.execute_batch(MIGRATION_3).unwrap();
        connection.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
            INSERT INTO schema_migrations VALUES(1,'fixture'),(2,'fixture'),(3,'fixture');
            PRAGMA foreign_keys = OFF;
            INSERT INTO workspaces(id,run_id,project_id,generation,kind,base_sha,path,created_at)
            VALUES('orphan','missing-run','missing-project',1,'development','base','/fixture/orphan','fixture');").unwrap();
        assert!(matches!(
            migrate(&mut connection),
            Err(StorageError::MigrationIntegrity)
        ));
        let version: u32 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 3);
        let path: String = connection
            .query_row(
                "SELECT path FROM workspaces WHERE id = 'orphan'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(path, "/fixture/orphan");
        let enabled: bool = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert!(enabled);
    }

    #[test]
    fn mock_run_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("agentflow.sqlite");
        let detail = {
            let mut storage = Storage::open(&path).unwrap();
            storage
                .create_and_execute_mock_task(request(MockOutcome::Succeeded))
                .unwrap()
        };

        let reopened = Storage::open(&path).unwrap();
        let stored = reopened.get_run(detail.run_id).unwrap();
        assert_eq!(stored.run_state, RunState::Succeeded);
        assert_eq!(stored.attempt_state, Some(AttemptState::Succeeded));
        assert_eq!(reopened.list_runs().unwrap().len(), 1);
    }

    #[test]
    fn duplicate_runner_event_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let detail = storage
            .create_and_execute_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let attempt_id = detail.attempt_id.unwrap();

        assert!(
            storage
                .import_runner_event(
                    detail.run_id,
                    attempt_id,
                    1,
                    "output",
                    json!({"line": "one"}),
                )
                .unwrap()
        );
        assert!(
            !storage
                .import_runner_event(
                    detail.run_id,
                    attempt_id,
                    1,
                    "output",
                    json!({"line": "duplicate"}),
                )
                .unwrap()
        );
        assert_eq!(storage.count_events(attempt_id, 1).unwrap(), 1);
    }

    #[test]
    fn terminal_attempt_cannot_become_success() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let detail = storage
            .create_and_execute_mock_task(request(MockOutcome::Failed))
            .unwrap();
        let attempt_id = detail.attempt_id.unwrap();

        let error = storage
            .transition_attempt_state(
                detail.run_id,
                attempt_id,
                AttemptState::Failed,
                AttemptState::Succeeded,
            )
            .unwrap_err();
        assert!(matches!(error, StorageError::InvalidTransition { .. }));
        assert_eq!(
            storage.get_run(detail.run_id).unwrap().attempt_state,
            Some(AttemptState::Failed)
        );
    }

    #[test]
    fn unique_constraint_rejects_duplicate_attempt_number() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let detail = storage
            .create_and_execute_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let attempt_id = detail.attempt_id.unwrap();

        let error = storage
            .connection
            .execute(
                "INSERT INTO attempts(
                    id, step_execution_id, attempt_number, requested_account_id,
                    actual_account_id, state, input_digest, runner_token, created_at
                 ) SELECT ?1, step_execution_id, attempt_number, requested_account_id,
                          actual_account_id, state, input_digest, ?2, created_at
                   FROM attempts WHERE id = ?3",
                params![
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    attempt_id.to_string(),
                ],
            )
            .unwrap_err();
        assert!(matches!(error, rusqlite::Error::SqliteFailure(_, _)));
        assert_eq!(
            storage.get_run(detail.run_id).unwrap().attempt_number,
            Some(1)
        );
    }

    #[test]
    fn queued_run_has_no_attempt_until_it_is_claimed() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let queued = storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();

        assert_eq!(queued.run_state, RunState::Queued);
        assert_eq!(queued.step_state, StepExecutionState::Pending);
        assert_eq!(queued.attempt_id, None);
        assert_eq!(queued.attempt_state, None);

        let claimed = storage.claim_next_mock_attempt(3).unwrap().unwrap();
        assert_eq!(claimed.run_id, queued.run_id);
        let running = storage.get_run(queued.run_id).unwrap();
        assert_eq!(running.run_state, RunState::Running);
        assert_eq!(running.step_state, StepExecutionState::Running);
        assert_eq!(running.attempt_state, Some(AttemptState::Prepared));
        assert_eq!(running.attempt_number, Some(1));
    }

    #[test]
    fn claim_holds_account_and_workspace_and_serializes_same_account() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();

        let claimed = storage.claim_next_mock_attempt(3).unwrap().unwrap();
        let lock_count: u32 = storage
            .connection
            .query_row(
                "SELECT COUNT(*) FROM resource_locks WHERE attempt_id = ?1",
                [claimed.attempt_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(lock_count, 2);
        assert!(storage.claim_next_mock_attempt(3).unwrap().is_none());
    }

    #[test]
    fn claim_respects_global_limit_across_distinct_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        for account in ["mock:one", "mock:two", "mock:three", "mock:four"] {
            storage
                .enqueue_mock_task(request_for_account(account))
                .unwrap();
        }

        let claimed = (0..3)
            .map(|_| storage.claim_next_mock_attempt(3).unwrap().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(claimed.len(), 3);
        assert_ne!(claimed[0].account_id, claimed[1].account_id);
        assert_ne!(claimed[1].account_id, claimed[2].account_id);
        assert!(storage.claim_next_mock_attempt(3).unwrap().is_none());
    }

    #[test]
    fn finalization_is_idempotent_and_releases_locks() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let prepared = storage.claim_next_mock_attempt(3).unwrap().unwrap();
        storage.mark_attempt_starting(&prepared).unwrap();
        let active = storage
            .active_attempt_for_run(prepared.run_id)
            .unwrap()
            .unwrap();
        storage.mark_attempt_running(&active).unwrap();

        assert!(
            storage
                .finalize_attempt(
                    prepared.attempt_id,
                    AttemptCompletion::Succeeded(json!({"status": "succeeded"})),
                )
                .unwrap()
        );
        assert!(
            !storage
                .finalize_attempt(
                    prepared.attempt_id,
                    AttemptCompletion::Succeeded(json!({"status": "succeeded"})),
                )
                .unwrap()
        );
        let detail = storage.get_run(prepared.run_id).unwrap();
        assert_eq!(detail.run_state, RunState::Succeeded);
        assert_eq!(detail.step_state, StepExecutionState::Succeeded);
        assert_eq!(detail.attempt_state, Some(AttemptState::Succeeded));
        let lock_count: u32 = storage
            .connection
            .query_row("SELECT COUNT(*) FROM resource_locks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lock_count, 0);
    }

    #[test]
    fn unknown_runner_state_keeps_resource_locks() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let prepared = storage.claim_next_mock_attempt(3).unwrap().unwrap();
        storage.mark_attempt_starting(&prepared).unwrap();
        let active = storage
            .active_attempt_for_run(prepared.run_id)
            .unwrap()
            .unwrap();

        storage.mark_attempt_interrupted(&active).unwrap();

        let detail = storage.get_run(prepared.run_id).unwrap();
        assert_eq!(detail.run_state, RunState::Interrupted);
        assert_eq!(detail.attempt_state, Some(AttemptState::Interrupted));
        let lock_count: u32 = storage
            .connection
            .query_row("SELECT COUNT(*) FROM resource_locks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(lock_count, 2);
    }

    #[test]
    fn queued_run_can_be_cancelled_without_creating_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let queued = storage
            .enqueue_mock_task(request(MockOutcome::Succeeded))
            .unwrap();

        assert!(storage.cancel_queued_run(queued.run_id).unwrap());
        assert!(!storage.cancel_queued_run(queued.run_id).unwrap());
        let cancelled = storage.get_run(queued.run_id).unwrap();
        assert_eq!(cancelled.run_state, RunState::Cancelled);
        assert_eq!(cancelled.step_state, StepExecutionState::Skipped);
        assert_eq!(cancelled.attempt_id, None);
    }

    #[test]
    fn workflow_versions_are_immutable_and_stale_approvals_are_invalidated() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("agentflow.sqlite")).unwrap();
        let definition = crate::development_flow::standard_development_workflow();
        let first = storage.publish_workflow(&definition).unwrap();
        let repeated = storage.publish_workflow(&definition).unwrap();
        assert_eq!(first.workflow_version_id, repeated.workflow_version_id);
        assert_eq!(first.digest, repeated.digest);

        let mut changed = definition.clone();
        changed.name = "changed layout version".into();
        let second = storage.publish_workflow(&changed).unwrap();
        assert_ne!(first.workflow_version_id, second.workflow_version_id);
        assert_ne!(first.digest, second.digest);

        let run = storage
            .create_and_execute_mock_task(request(MockOutcome::Succeeded))
            .unwrap();
        let approval = ApprovalRecord {
            approval_id: Uuid::new_v4(),
            run_id: run.run_id,
            candidate_commit: "candidate-one".into(),
            workflow_digest: first.digest.clone(),
            decision: ApprovalDecision::Approved,
            comment: "approved".into(),
            created_at: timestamp(),
            invalidated_at: None,
            invalidation_reason: None,
        };
        let stored = storage.record_approval(&approval).unwrap();
        let duplicate = storage.record_approval(&approval).unwrap();
        assert_eq!(stored.approval_id, duplicate.approval_id);
        assert!(
            storage
                .valid_approval(run.run_id, "candidate-one", &first.digest)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            storage
                .invalidate_approvals_for_candidate_change(run.run_id, "candidate-two")
                .unwrap(),
            1
        );
        assert!(
            storage
                .valid_approval(run.run_id, "candidate-one", &first.digest)
                .unwrap()
                .is_none()
        );
    }
}
