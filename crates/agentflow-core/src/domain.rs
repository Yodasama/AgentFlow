use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

macro_rules! string_state {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = StateParseError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(StateParseError {
                        state_type: stringify!($name),
                        value: value.to_owned(),
                    }),
                }
            }
        }
    };
}

string_state!(RunState {
    Queued => "queued",
    Running => "running",
    WaitingInput => "waiting_input",
    Interrupted => "interrupted",
    Succeeded => "succeeded",
    Failed => "failed",
    Cancelled => "cancelled",
});

impl RunState {
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Queued, Self::Running | Self::Cancelled)
                | (
                    Self::Running,
                    Self::WaitingInput
                        | Self::Interrupted
                        | Self::Succeeded
                        | Self::Failed
                        | Self::Cancelled
                )
                | (
                    Self::WaitingInput,
                    Self::Running | Self::Interrupted | Self::Cancelled
                )
                | (Self::Interrupted, Self::Running | Self::Cancelled)
        )
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

string_state!(StepExecutionState {
    Pending => "pending",
    Running => "running",
    WaitingInput => "waiting_input",
    Succeeded => "succeeded",
    Failed => "failed",
    Skipped => "skipped",
});

impl StepExecutionState {
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Pending, Self::Running | Self::Skipped)
                | (
                    Self::Running,
                    Self::WaitingInput | Self::Succeeded | Self::Failed
                )
                | (Self::WaitingInput, Self::Running | Self::Failed)
        )
    }
}

string_state!(AttemptState {
    Prepared => "prepared",
    Starting => "starting",
    Running => "running",
    Finalizing => "finalizing",
    Succeeded => "succeeded",
    Failed => "failed",
    Interrupted => "interrupted",
    Cancelled => "cancelled",
});

impl AttemptState {
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Prepared, Self::Starting | Self::Cancelled)
                | (
                    Self::Starting,
                    Self::Running | Self::Finalizing | Self::Interrupted | Self::Cancelled
                )
                | (
                    Self::Running,
                    Self::Finalizing | Self::Interrupted | Self::Cancelled
                )
                | (
                    Self::Finalizing,
                    Self::Succeeded | Self::Failed | Self::Interrupted | Self::Cancelled
                )
        )
    }

    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Interrupted | Self::Cancelled
        )
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("unknown {state_type} value: {value}")]
pub struct StateParseError {
    state_type: &'static str,
    value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MockOutcome {
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateMockTaskRequest {
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
    pub outcome: MockOutcome,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub delay_milliseconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub workflow_kind: Option<String>,
    pub run_id: Uuid,
    pub task_id: Uuid,
    pub title: String,
    pub description: String,
    pub run_state: RunState,
    pub attempt_state: Option<AttemptState>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub workflow_kind: Option<String>,
    pub waiting_reason: Option<String>,
    pub run_id: Uuid,
    pub task_id: Uuid,
    pub step_execution_id: Uuid,
    pub attempt_id: Option<Uuid>,
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
    pub run_state: RunState,
    pub step_state: StepExecutionState,
    pub attempt_state: Option<AttemptState>,
    pub attempt_number: Option<u32>,
    pub result: Option<serde_json::Value>,
    pub error_code: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedAttempt {
    pub run_id: Uuid,
    pub step_execution_id: Uuid,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub account_id: String,
    pub outcome: MockOutcome,
    pub delay_milliseconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveAttempt {
    pub run_id: Uuid,
    pub step_execution_id: Uuid,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub state: AttemptState,
    pub outcome: MockOutcome,
    pub delay_milliseconds: Option<u64>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptCompletion {
    Succeeded(serde_json::Value),
    Failed {
        result: serde_json::Value,
        error_code: String,
    },
    Cancelled(serde_json::Value),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub project_id: Uuid,
    pub root_path: String,
    pub git_common_directory: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub project_id: Uuid,
    pub generation: u32,
    pub kind: String,
    pub base_sha: String,
    pub branch_name: Option<String>,
    pub path: String,
    pub source_checkpoint_id: Option<Uuid>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRecord {
    pub checkpoint_id: Uuid,
    pub workspace_id: Uuid,
    pub run_id: Uuid,
    pub attempt_id: Uuid,
    pub base_sha: String,
    pub commit_sha: String,
    pub controlled_files: Vec<String>,
    pub marker: String,
    pub no_changes: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub artifact_id: Uuid,
    pub run_id: Uuid,
    pub attempt_id: Uuid,
    pub artifact_type: String,
    pub relative_path: String,
    pub byte_size: u64,
    pub content_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLockRecord {
    pub resource_type: String,
    pub resource_id: String,
    pub attempt_id: Uuid,
    pub acquired_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatusSummary {
    pub account_id: String,
    pub display_name: String,
    pub role: String,
    pub is_locked: bool,
    pub locked_by_attempt_id: Option<Uuid>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub id: String,
    pub name: String,
    pub cron: String,
    pub timezone: String,
    pub target_workflow_name: String,
    pub active: bool,
    pub overlap_policy: String,
    pub last_run_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneRecord {
    pub id: String,
    pub goal_id: String,
    pub title: String,
    pub completed: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalRecord {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub deadline: String,
    pub actions_used: u32,
    pub actions_budget: u32,
    pub created_at: String,
    pub milestones: Vec<MilestoneRecord>,
}
