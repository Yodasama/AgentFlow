use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    development_flow::DevelopmentPhase,
    domain::{AttemptState, StepExecutionState, WorkspaceRecord},
    execution::SchedulerConfig,
    git_workspace::{GitWorkspaceError, GitWorkspaceService},
    storage::{Storage, StorageError},
    workflow_run::{
        CreateDevelopmentRunRequest, DevelopmentRunCoordinator, DevelopmentRunSnapshot,
        NodeLaunchSpec, WorkflowRunError,
    },
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MockDevelopmentScenario {
    Pass,
    TestThenReviewRetry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockDevelopmentExecution {
    pub workspace: WorkspaceRecord,
    pub scenario: MockDevelopmentScenario,
}

pub fn create_mock_development_run(
    storage: &Arc<Mutex<Storage>>,
    data_directory: &Path,
    repository_path: &Path,
    request: CreateDevelopmentRunRequest,
    scenario: MockDevelopmentScenario,
) -> Result<DevelopmentRunSnapshot, DevelopmentRuntimeError> {
    let git = GitWorkspaceService::new(data_directory.into());
    let (project, preflight, version) = {
        let mut storage = storage
            .lock()
            .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?;
        let (project, preflight) = git.register_project(&mut storage, repository_path)?;
        let version =
            storage.publish_workflow(&crate::development_flow::standard_development_workflow())?;
        (project, preflight, version)
    };
    let coordinator = DevelopmentRunCoordinator::new(storage.clone());
    let snapshot = coordinator.create_run(request, &version)?;
    let configured = (|| -> Result<(), DevelopmentRuntimeError> {
        let mut storage = storage
            .lock()
            .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?;
        let workspace = git.create_development_workspace(
            &mut storage,
            &project,
            snapshot.run_id,
            &preflight.base_sha,
            1,
            None,
        )?;
        storage.enable_mock_development_execution(
            snapshot.run_id,
            &MockDevelopmentExecution {
                workspace,
                scenario,
            },
        )?;
        Ok(())
    })();
    if let Err(error) = configured {
        storage
            .lock()
            .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?
            .interrupt_development_run(snapshot.run_id, &error.to_string())?;
        return Err(error);
    }
    Ok(coordinator.load(snapshot.run_id)?)
}

#[derive(Debug, Error)]
pub enum DevelopmentRuntimeError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Workflow(#[from] WorkflowRunError),
    #[error(transparent)]
    Git(#[from] GitWorkspaceError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("database mutex is poisoned")]
    PoisonedStorage,
    #[error("workflow execution evidence is incomplete: {0}")]
    MissingEvidence(&'static str),
}

/// Only explicitly enabled mock workflows are dispatched here. Real account
/// bindings require their own adapter and are never substituted with this one.
pub fn advance_mock_development_runs(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
) -> Result<(), DevelopmentRuntimeError> {
    let enabled = storage
        .lock()
        .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?
        .automatic_development_runs()?;
    let coordinator = DevelopmentRunCoordinator::new(storage.clone());
    let git = GitWorkspaceService::new(config.data_directory.clone());
    let mut first_error = None;
    for (run_id, execution) in enabled {
        if let Err(error) = advance_run(storage, config, &coordinator, &git, run_id, &execution) {
            storage
                .lock()
                .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?
                .interrupt_development_run(run_id, &error.to_string())?;
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn advance_run(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
    coordinator: &DevelopmentRunCoordinator,
    git: &GitWorkspaceService,
    run_id: Uuid,
    execution: &MockDevelopmentExecution,
) -> Result<(), DevelopmentRuntimeError> {
    let snapshot = coordinator.load(run_id)?;
    let detail = storage
        .lock()
        .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?
        .get_run(run_id)?;
    if detail.step_state == StepExecutionState::Running
        && detail.attempt_state == Some(AttemptState::Succeeded)
    {
        let attempt_id = detail
            .attempt_id
            .ok_or(DevelopmentRuntimeError::MissingEvidence("attempt id"))?;
        let payload = detail
            .result
            .as_ref()
            .and_then(|value| value.pointer("/output/result"))
            .ok_or(DevelopmentRuntimeError::MissingEvidence(
                "structured node output",
            ))?;
        match snapshot.flow.phase {
            DevelopmentPhase::Analysis => {
                let summary = payload
                    .get("summary")
                    .ok_or(DevelopmentRuntimeError::MissingEvidence("analysis summary"))?;
                coordinator.complete_analysis(run_id, summary.clone())?;
            }
            DevelopmentPhase::Development => {
                let checkpoint = git.create_checkpoint(
                    &mut *storage
                        .lock()
                        .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?,
                    &execution.workspace,
                    attempt_id,
                    &["agentflow-fixture.txt".into()],
                )?;
                coordinator.complete_development(run_id, checkpoint.commit_sha)?;
            }
            DevelopmentPhase::Tests => {
                coordinator.record_tests(
                    run_id,
                    serde_json::from_value(
                        payload
                            .get("report")
                            .ok_or(DevelopmentRuntimeError::MissingEvidence("test report"))?
                            .clone(),
                    )?,
                )?;
            }
            DevelopmentPhase::Review => {
                coordinator.record_review(
                    run_id,
                    serde_json::from_value(
                        payload
                            .get("report")
                            .ok_or(DevelopmentRuntimeError::MissingEvidence("review report"))?
                            .clone(),
                    )?,
                )?;
            }
            _ => return Err(DevelopmentRuntimeError::MissingEvidence("executable phase")),
        }
        return Ok(());
    }
    if detail.step_state != StepExecutionState::Pending {
        return Ok(());
    }
    let working_directory = if snapshot.flow.phase == DevelopmentPhase::Review {
        let candidate = snapshot
            .flow
            .candidate_commit
            .as_deref()
            .ok_or(DevelopmentRuntimeError::MissingEvidence("candidate SHA"))?;
        let mut storage = storage
            .lock()
            .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?;
        let checkpoint = storage.checkpoint_for_candidate(run_id, candidate)?.ok_or(
            DevelopmentRuntimeError::MissingEvidence("candidate checkpoint"),
        )?;
        PathBuf::from(
            git.create_review_workspace(&mut storage, &execution.workspace, &checkpoint)?
                .path,
        )
    } else {
        PathBuf::from(&execution.workspace.path)
    };
    let input = json!({
        "schemaVersion":1, "phase":snapshot.flow.phase, "iteration":snapshot.flow.iteration,
        "candidateCommit":snapshot.flow.candidate_commit, "feedback":snapshot.flow.feedback,
        "task":{"title":detail.title,"description":detail.description,"acceptanceCriteria":detail.acceptance_criteria},
        "scenario":execution.scenario,
    });
    let spec = NodeLaunchSpec {
        executable_path: config.mock_cli_path.clone(),
        arguments: vec!["workflow-node".into(), input.to_string()],
        working_directory,
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into())]),
        timeout_seconds: config.timeout_seconds,
        cancellation_grace_seconds: config.cancellation_grace_seconds,
    };
    storage
        .lock()
        .map_err(|_| DevelopmentRuntimeError::PoisonedStorage)?
        .prepare_development_attempt(run_id, &spec, &config.data_directory, config.global_limit)?;
    Ok(())
}
