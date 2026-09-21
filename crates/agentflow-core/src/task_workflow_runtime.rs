use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use serde_json::{Map, Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    domain::{AttemptState, StepExecutionState},
    execution::SchedulerConfig,
    storage::{Storage, StorageError},
    workflow::{NodeKind, TaskWorkflowExecutionState, WorkflowDefinition, WorkflowExecutionError},
    workflow_run::NodeLaunchSpec,
};

#[derive(Debug, Error)]
pub enum TaskWorkflowRuntimeError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Workflow(#[from] WorkflowExecutionError),
    #[error("database mutex is poisoned")]
    PoisonedStorage,
}

pub fn advance_task_workflows(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
) -> Result<(), TaskWorkflowRuntimeError> {
    let runs = storage
        .lock()
        .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
        .running_task_workflows()?;
    for (run_id, definition, state) in runs {
        advance_one(storage, config, run_id, &definition, state)?;
    }
    Ok(())
}

fn advance_one(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
    run_id: Uuid,
    definition: &WorkflowDefinition,
    mut state: TaskWorkflowExecutionState,
) -> Result<(), TaskWorkflowRuntimeError> {
    if state.cursor.completed {
        storage
            .lock()
            .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
            .complete_task_workflow(run_id)?;
        return Ok(());
    }
    let node = definition
        .nodes
        .iter()
        .find(|node| node.id == state.cursor.current_node_id)
        .ok_or_else(|| WorkflowExecutionError::MissingNode(state.cursor.current_node_id.clone()))?;
    match node.kind {
        NodeKind::Start | NodeKind::Condition => {
            state.cursor.advance(definition, &state.facts)?;
            storage
                .lock()
                .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                .persist_task_workflow_state(run_id, &state)?;
        }
        NodeKind::End => {
            storage
                .lock()
                .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                .complete_task_workflow(run_id)?;
        }
        NodeKind::HumanApproval => {
            let iteration = iteration_key(&state);
            storage
                .lock()
                .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                .ensure_task_workflow_step(run_id, &node.id, &iteration, true)?;
        }
        NodeKind::Agent | NodeKind::Command => {
            let iteration = iteration_key(&state);
            let step = storage
                .lock()
                .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                .task_workflow_step(run_id, &node.id, &iteration)?;
            match step {
                None => {
                    storage
                        .lock()
                        .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                        .ensure_task_workflow_step(run_id, &node.id, &iteration, false)?;
                }
                Some(step) if step.step_state == StepExecutionState::Pending => {
                    let detail = storage
                        .lock()
                        .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                        .get_run(run_id)?;
                    let account = node
                        .role
                        .as_ref()
                        .and_then(|role| definition.role_bindings.get(role))
                        .cloned()
                        .unwrap_or_else(|| "mock:default".to_owned());
                    let payload = json!({
                        "nodeId":node.id,
                        "label":node.label,
                        "task":{"title":detail.title,"description":detail.description,
                            "acceptanceCriteria":detail.acceptance_criteria},
                        "facts":state.facts,
                    });
                    let working_directory = config
                        .data_directory
                        .join("workspaces")
                        .join(run_id.to_string());
                    let spec = NodeLaunchSpec {
                        executable_path: config.mock_cli_path.clone(),
                        arguments: vec![
                            "workflow-result".to_owned(),
                            json!({
                                "nodeId":node.id,"status":"succeeded","output":payload
                            })
                            .to_string(),
                        ],
                        working_directory,
                        environment: BTreeMap::from([(
                            "PATH".to_owned(),
                            "/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
                        )]),
                        timeout_seconds: config.timeout_seconds,
                        cancellation_grace_seconds: config.cancellation_grace_seconds,
                    };
                    storage
                        .lock()
                        .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                        .prepare_task_workflow_attempt(
                            run_id,
                            &node.id,
                            &iteration,
                            &account,
                            &spec,
                            &config.data_directory,
                            config.global_limit,
                        )?;
                }
                Some(step)
                    if step.step_state == StepExecutionState::Running
                        && step.attempt_state == Some(AttemptState::Succeeded) =>
                {
                    record_result(
                        &mut state.facts,
                        &node.id,
                        step.result.clone().unwrap_or(Value::Null),
                    );
                    state.cursor.advance(definition, &state.facts)?;
                    storage
                        .lock()
                        .map_err(|_| TaskWorkflowRuntimeError::PoisonedStorage)?
                        .consume_task_workflow_result(run_id, &step, &state)?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn iteration_key(state: &TaskWorkflowExecutionState) -> String {
    format!("step-{}", state.cursor.steps_executed)
}

fn record_result(facts: &mut Value, node_id: &str, result: Value) {
    if !facts.is_object() {
        *facts = Value::Object(Map::new());
    }
    let object = facts
        .as_object_mut()
        .expect("facts normalized to an object");
    object.insert(
        "last".to_owned(),
        json!({"nodeId":node_id,"status":"succeeded","result":result}),
    );
    let nodes = object
        .entry("nodes")
        .or_insert_with(|| Value::Object(Map::new()));
    if !nodes.is_object() {
        *nodes = Value::Object(Map::new());
    }
    nodes
        .as_object_mut()
        .expect("nodes normalized to an object")
        .insert(
            node_id.to_owned(),
            json!({"status":"succeeded","result":result}),
        );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::{AttemptCompletion, MockOutcome, PreparedAttempt, RunState},
        workflow::starter_task_workflow,
        workflow_run::CreateDevelopmentRunRequest,
    };
    use std::path::PathBuf;

    #[test]
    fn task_workflow_is_edited_inside_a_draft_then_prepares_its_first_canvas_node() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("agentflow.sqlite");
        let mut storage = Storage::open(&database).unwrap();
        let draft = storage
            .create_task_workflow_draft(
                CreateDevelopmentRunRequest {
                    title: "任务级工作流".to_owned(),
                    description: "先编辑，再执行".to_owned(),
                    acceptance_criteria: vec!["按图完成".to_owned()],
                },
                &starter_task_workflow(),
                json!({"execute":{"x":280,"y":40}}),
            )
            .unwrap();
        assert_eq!(draft.run_state, crate::domain::RunState::WaitingInput);
        let saved = storage
            .save_task_workflow(
                draft.run_id,
                &starter_task_workflow(),
                json!({"execute":{"x":320,"y":80}}),
            )
            .unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.status, "draft");
        let started = storage.start_task_workflow(draft.run_id).unwrap();
        assert_eq!(started.status, "published");
        assert!(
            storage
                .save_task_workflow(draft.run_id, &starter_task_workflow(), json!({}),)
                .is_err()
        );

        let shared = Arc::new(Mutex::new(storage));
        let config = SchedulerConfig {
            data_directory: directory.path().to_path_buf(),
            runner_path: PathBuf::from("/usr/bin/true"),
            mock_cli_path: PathBuf::from("/usr/bin/true"),
            global_limit: 1,
            timeout_seconds: 30,
            cancellation_grace_seconds: 1,
        };
        advance_task_workflows(&shared, &config).unwrap();
        advance_task_workflows(&shared, &config).unwrap();
        advance_task_workflows(&shared, &config).unwrap();
        let attempts = shared.lock().unwrap().active_attempts().unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].state, AttemptState::Prepared);
        let prepared = PreparedAttempt {
            run_id: attempts[0].run_id,
            step_execution_id: attempts[0].step_execution_id,
            attempt_id: attempts[0].attempt_id,
            execution_token: attempts[0].execution_token.clone(),
            account_id: "mock:default".to_owned(),
            outcome: MockOutcome::Succeeded,
            delay_milliseconds: None,
        };
        shared
            .lock()
            .unwrap()
            .mark_attempt_starting(&prepared)
            .unwrap();
        let running = shared.lock().unwrap().active_attempts().unwrap().remove(0);
        shared
            .lock()
            .unwrap()
            .mark_attempt_running(&running)
            .unwrap();
        shared
            .lock()
            .unwrap()
            .finalize_attempt(
                running.attempt_id,
                AttemptCompletion::Succeeded(json!({"output":{"status":"succeeded"}})),
            )
            .unwrap();
        advance_task_workflows(&shared, &config).unwrap();
        advance_task_workflows(&shared, &config).unwrap();
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .get_run(draft.run_id)
                .unwrap()
                .run_state,
            RunState::Succeeded
        );
    }
}
