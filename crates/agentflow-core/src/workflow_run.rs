use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    development_flow::{
        ApprovalDecision, ApprovalRecord, DevelopmentFlowError, DevelopmentLoop, DevelopmentPhase,
        HumanApproval, ReviewReport, TestReport, TestStatus,
    },
    storage::{Storage, StorageError},
    workflow::WorkflowVersionRecord,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateDevelopmentRunRequest {
    pub title: String,
    pub description: String,
    pub acceptance_criteria: Vec<String>,
}

/// Constructed by the Rust adapter layer; never exposed as a WebView command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLaunchSpec {
    pub executable_path: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub timeout_seconds: u64,
    pub cancellation_grace_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentRunSnapshot {
    pub run_id: Uuid,
    pub task_id: Uuid,
    pub workflow_version_id: Uuid,
    pub flow: DevelopmentLoop,
}

#[derive(Debug, Clone)]
pub struct WorkflowStepTransition {
    pub node_id: String,
    pub iteration_key: String,
    pub account_id: Option<String>,
    pub result: Value,
    pub step_succeeded: bool,
    pub create_attempt: bool,
    pub complete_step: bool,
    pub approval: Option<ApprovalRecord>,
    pub invalidate_for_candidate: Option<String>,
}

#[derive(Debug, Error)]
pub enum WorkflowRunError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Flow(#[from] DevelopmentFlowError),
    #[error("database mutex is poisoned")]
    PoisonedStorage,
}

#[derive(Clone)]
pub struct DevelopmentRunCoordinator {
    storage: Arc<Mutex<Storage>>,
}

impl DevelopmentRunCoordinator {
    pub fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self { storage }
    }

    pub fn create_run(
        &self,
        request: CreateDevelopmentRunRequest,
        workflow: &WorkflowVersionRecord,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        let flow = DevelopmentLoop::new(
            workflow.digest.clone(),
            workflow.definition.budget.max_iterations,
            workflow.definition.budget.max_steps,
        );
        self.storage
            .lock()
            .map_err(|_| WorkflowRunError::PoisonedStorage)?
            .create_development_run(request, workflow, &flow)
            .map_err(Into::into)
    }

    pub fn load(&self, run_id: Uuid) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.storage
            .lock()
            .map_err(|_| WorkflowRunError::PoisonedStorage)?
            .development_run_snapshot(run_id)
            .map_err(Into::into)
    }

    pub fn complete_analysis(
        &self,
        run_id: Uuid,
        summary: Value,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let step = current_step(flow, Some("mock:analyst"), json!({"summary": summary}));
            flow.complete_analysis(summary)?;
            Ok(step)
        })
    }

    pub fn complete_development(
        &self,
        run_id: Uuid,
        candidate_commit: String,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let step = current_step(
                flow,
                Some("mock:developer"),
                json!({"candidateCommit": candidate_commit}),
            );
            flow.complete_development(candidate_commit)?;
            Ok(step)
        })
    }

    pub fn record_tests(
        &self,
        run_id: Uuid,
        report: TestReport,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let successful = report.status == TestStatus::Passed;
            let mut step = current_step(flow, Some("mock:test-runner"), json!({"report": report}));
            step.step_succeeded = successful;
            flow.record_tests(report)?;
            Ok(step)
        })
    }

    pub fn retry_infrastructure(
        &self,
        run_id: Uuid,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let step = current_step(flow, None, json!({"action": "retry_infrastructure"}));
            flow.retry_infrastructure()?;
            Ok(WorkflowStepTransition {
                create_attempt: false,
                complete_step: false,
                ..step
            })
        })
    }

    pub fn record_review(
        &self,
        run_id: Uuid,
        report: ReviewReport,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let step = current_step(flow, Some("mock:reviewer"), json!({"report": report}));
            flow.record_review(report)?;
            Ok(step)
        })
    }

    pub fn record_approval(
        &self,
        run_id: Uuid,
        approval: HumanApproval,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let record = ApprovalRecord {
                approval_id: Uuid::new_v4(),
                run_id,
                candidate_commit: approval.candidate_commit.clone(),
                workflow_digest: approval.workflow_digest.clone(),
                decision: approval.decision,
                comment: approval.comment.clone(),
                created_at: Utc::now().to_rfc3339(),
                invalidated_at: None,
                invalidation_reason: None,
            };
            let mut step = current_step(flow, None, json!({"approval": approval}));
            step.create_attempt = false;
            step.approval = Some(record);
            flow.record_approval(approval)?;
            Ok(step)
        })
    }

    pub fn candidate_changed(
        &self,
        run_id: Uuid,
        candidate_commit: String,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        self.transition(run_id, |flow| {
            let old_step = current_step(flow, None, json!({"candidateChanged": candidate_commit}));
            flow.candidate_changed(candidate_commit.clone())?;
            Ok(WorkflowStepTransition {
                create_attempt: false,
                step_succeeded: false,
                invalidate_for_candidate: Some(candidate_commit),
                ..old_step
            })
        })
    }

    fn transition(
        &self,
        run_id: Uuid,
        operation: impl FnOnce(
            &mut DevelopmentLoop,
        ) -> Result<WorkflowStepTransition, DevelopmentFlowError>,
    ) -> Result<DevelopmentRunSnapshot, WorkflowRunError> {
        let mut storage = self
            .storage
            .lock()
            .map_err(|_| WorkflowRunError::PoisonedStorage)?;
        let mut snapshot = storage.development_run_snapshot(run_id)?;
        let mut transition = operation(&mut snapshot.flow)?;
        if transition.create_attempt {
            transition.account_id =
                Some(storage.workflow_node_account(run_id, &transition.node_id)?);
        }
        if snapshot.flow.actions_used >= snapshot.flow.max_actions
            && snapshot.flow.phase != DevelopmentPhase::Completed
        {
            snapshot.flow.phase = DevelopmentPhase::Exhausted;
        }
        storage.persist_development_transition(run_id, &transition, &snapshot.flow)?;
        storage.development_run_snapshot(run_id).map_err(Into::into)
    }
}

fn current_step(
    flow: &DevelopmentLoop,
    account_id: Option<&str>,
    result: Value,
) -> WorkflowStepTransition {
    WorkflowStepTransition {
        node_id: phase_node(flow.phase).to_owned(),
        iteration_key: format!("iteration-{}-action-{}", flow.iteration, flow.actions_used),
        account_id: account_id.map(str::to_owned),
        result,
        step_succeeded: true,
        create_attempt: account_id.is_some(),
        complete_step: true,
        approval: None,
        invalidate_for_candidate: None,
    }
}

pub fn pending_step(flow: &DevelopmentLoop) -> Option<(String, String, bool)> {
    let node_id = match flow.phase {
        DevelopmentPhase::Analysis
        | DevelopmentPhase::Development
        | DevelopmentPhase::Tests
        | DevelopmentPhase::Review
        | DevelopmentPhase::HumanApproval => phase_node(flow.phase),
        DevelopmentPhase::WaitingInfrastructure
        | DevelopmentPhase::Completed
        | DevelopmentPhase::Exhausted => return None,
    };
    Some((
        node_id.to_owned(),
        format!("iteration-{}-action-{}", flow.iteration, flow.actions_used),
        flow.phase == DevelopmentPhase::HumanApproval,
    ))
}

fn phase_node(phase: DevelopmentPhase) -> &'static str {
    match phase {
        DevelopmentPhase::Analysis => "analysis",
        DevelopmentPhase::Development => "development",
        DevelopmentPhase::Tests | DevelopmentPhase::WaitingInfrastructure => "tests",
        DevelopmentPhase::Review => "review",
        DevelopmentPhase::HumanApproval => "approval",
        DevelopmentPhase::Completed => "end",
        DevelopmentPhase::Exhausted => "exhausted",
    }
}

pub fn approved_human_input(
    candidate_commit: String,
    workflow_digest: String,
    comment: String,
) -> HumanApproval {
    HumanApproval {
        schema_version: 1,
        candidate_commit,
        workflow_digest,
        decision: ApprovalDecision::Approved,
        comment,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::development_flow::standard_development_workflow;

    #[test]
    fn cancellation_between_nodes_stops_the_run_without_launching_an_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("workflow.sqlite")).unwrap();
        let version = storage
            .publish_workflow(&standard_development_workflow())
            .unwrap();
        let storage = Arc::new(Mutex::new(storage));
        let coordinator = DevelopmentRunCoordinator::new(storage.clone());
        let run = coordinator
            .create_run(
                CreateDevelopmentRunRequest {
                    title: "Cancel pending workflow".into(),
                    description: "No node should start".into(),
                    acceptance_criteria: vec![],
                },
                &version,
            )
            .unwrap()
            .run_id;
        let detail =
            crate::execution::request_cancellation(&storage, directory.path(), run).unwrap();
        assert_eq!(detail.run_state, crate::domain::RunState::Cancelled);
        assert!(
            storage
                .lock()
                .unwrap()
                .active_attempts()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn cancellation_releases_prepared_locks_but_retains_unknown_execution_locks() {
        for unknown in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let mut storage = Storage::open(&directory.path().join("workflow.sqlite")).unwrap();
            let version = storage
                .publish_workflow(&standard_development_workflow())
                .unwrap();
            let storage = Arc::new(Mutex::new(storage));
            let coordinator = DevelopmentRunCoordinator::new(storage.clone());
            let request = CreateDevelopmentRunRequest {
                title: "Cancellation lock fixture".into(),
                description: "Preserve unknown execution ownership".into(),
                acceptance_criteria: vec![],
            };
            let run = coordinator
                .create_run(request.clone(), &version)
                .unwrap()
                .run_id;
            let spec = NodeLaunchSpec {
                executable_path: "/bin/echo".into(),
                arguments: vec![],
                working_directory: directory.path().into(),
                environment: BTreeMap::new(),
                timeout_seconds: 10,
                cancellation_grace_seconds: 1,
            };
            {
                let mut storage = storage.lock().unwrap();
                let attempt = storage
                    .prepare_development_attempt(run, &spec, directory.path(), 3)
                    .unwrap()
                    .unwrap();
                if unknown {
                    storage.mark_attempt_starting(&attempt).unwrap();
                    let active = storage.active_attempts().unwrap().pop().unwrap();
                    storage.mark_attempt_interrupted(&active).unwrap();
                }
            }
            let detail =
                crate::execution::request_cancellation(&storage, directory.path(), run).unwrap();
            assert_eq!(
                detail.run_state,
                if unknown {
                    crate::domain::RunState::Interrupted
                } else {
                    crate::domain::RunState::Cancelled
                }
            );
            let other = coordinator.create_run(request, &version).unwrap().run_id;
            let claimed = storage
                .lock()
                .unwrap()
                .prepare_development_attempt(other, &spec, directory.path(), 3)
                .unwrap();
            assert_eq!(claimed.is_some(), !unknown);
        }
    }

    #[test]
    fn exhausted_action_budget_is_persisted_without_scheduling_another_node() {
        let directory = tempfile::tempdir().unwrap();
        let mut storage = Storage::open(&directory.path().join("workflow.sqlite")).unwrap();
        let mut definition = standard_development_workflow();
        definition.budget.max_steps = 1;
        let version = storage.publish_workflow(&definition).unwrap();
        let shared = Arc::new(Mutex::new(storage));
        let coordinator = DevelopmentRunCoordinator::new(shared.clone());
        let run = coordinator
            .create_run(
                CreateDevelopmentRunRequest {
                    title: "Budget fixture".into(),
                    description: "Only one action is permitted".into(),
                    acceptance_criteria: vec![],
                },
                &version,
            )
            .unwrap()
            .run_id;
        let spec = NodeLaunchSpec {
            executable_path: "/bin/echo".into(),
            arguments: vec![],
            working_directory: directory.path().into(),
            environment: BTreeMap::new(),
            timeout_seconds: 10,
            cancellation_grace_seconds: 1,
        };
        {
            let mut storage = shared.lock().unwrap();
            let attempt = storage
                .prepare_development_attempt(run, &spec, directory.path(), 3)
                .unwrap()
                .unwrap();
            storage.mark_attempt_starting(&attempt).unwrap();
            // Unit fixture for the result-import boundary; process execution is covered
            // separately by the verify_workflow example.
            storage
                .finalize_attempt(
                    attempt.attempt_id,
                    crate::domain::AttemptCompletion::Succeeded(
                        json!({"output":{"result":{"summary":"fixture"}}}),
                    ),
                )
                .unwrap();
        }
        let snapshot = coordinator
            .complete_analysis(run, json!("fixture"))
            .unwrap();
        assert_eq!(snapshot.flow.phase, DevelopmentPhase::Exhausted);
        assert_eq!(
            shared.lock().unwrap().get_run(run).unwrap().run_state,
            crate::domain::RunState::Failed
        );
        assert!(
            shared
                .lock()
                .unwrap()
                .prepare_development_attempt(run, &spec, directory.path(), 3)
                .is_err()
        );
    }

    #[test]
    fn reopen_preserves_pending_workflow_and_rejects_unevidenced_completion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflow.sqlite");
        let mut storage = Storage::open(&path).unwrap();
        let version = storage
            .publish_workflow(&standard_development_workflow())
            .unwrap();
        let storage = Arc::new(Mutex::new(storage));
        let coordinator = DevelopmentRunCoordinator::new(storage.clone());
        let initial = coordinator
            .create_run(
                CreateDevelopmentRunRequest {
                    title: "Persistent workflow".into(),
                    description: "Require runner evidence before advancing".into(),
                    acceptance_criteria: vec!["No fabricated attempts".into()],
                },
                &version,
            )
            .unwrap();
        assert!(
            coordinator
                .complete_analysis(initial.run_id, json!("unverified"))
                .is_err()
        );
        assert_eq!(coordinator.load(initial.run_id).unwrap(), initial);
        assert!(
            storage
                .lock()
                .unwrap()
                .active_attempts()
                .unwrap()
                .is_empty()
        );
        drop(coordinator);
        drop(storage);
        let reopened = Storage::open(&path).unwrap();
        assert_eq!(
            reopened.development_run_snapshot(initial.run_id).unwrap(),
            initial
        );
    }
}
