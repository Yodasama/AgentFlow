use agentflow_core::{
    development_flow::{HumanApproval, standard_development_workflow},
    development_runtime::{MockDevelopmentScenario, create_mock_development_run},
    domain::{
        AccountStatusSummary, CheckpointRecord, CreateMockTaskRequest, GoalRecord,
        ResourceLockRecord, RunDetail, RunSummary, ScheduleRecord,
    },
    execution::{AppInstanceLock, SchedulerConfig, SchedulerHandle, request_cancellation},
    protocol::RUNNER_PROTOCOL_VERSION,
    storage::Storage,
    workflow::{
        ValidationReport, WorkflowDefinition, WorkflowVersionRecord,
        validate_workflow as validate_definition,
    },
    workflow_run::{
        CreateDevelopmentRunRequest, DevelopmentRunCoordinator, DevelopmentRunSnapshot,
    },
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

struct AppCoreState {
    storage: Arc<Mutex<Storage>>,
    data_directory: PathBuf,
    runner_path: PathBuf,
    _instance_lock: AppInstanceLock,
    scheduler: SchedulerHandle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    app_name: &'static str,
    protocol_version: u32,
    data_directory: String,
    runner_bundled: bool,
    database_ready: bool,
    scheduler_error: Option<String>,
}

#[tauri::command]
fn get_app_status(state: State<'_, AppCoreState>) -> Result<AppStatus, String> {
    Ok(AppStatus {
        app_name: "AgentFlow",
        protocol_version: RUNNER_PROTOCOL_VERSION,
        data_directory: state.data_directory.display().to_string(),
        runner_bundled: state.runner_path.exists(),
        database_ready: true,
        scheduler_error: state.scheduler.last_error(),
    })
}

#[tauri::command]
fn create_mock_task(
    request: CreateMockTaskRequest,
    state: State<'_, AppCoreState>,
) -> Result<RunDetail, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .enqueue_mock_task(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn create_mock_development_task(
    request: CreateDevelopmentRunRequest,
    repository_path: String,
    scenario: MockDevelopmentScenario,
    state: State<'_, AppCoreState>,
) -> Result<DevelopmentRunSnapshot, String> {
    let storage = state.storage.clone();
    let data_directory = state.data_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_mock_development_run(
            &storage,
            &data_directory,
            &PathBuf::from(repository_path),
            request,
            scenario,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_development_run(
    run_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<DevelopmentRunSnapshot, String> {
    DevelopmentRunCoordinator::new(state.storage.clone())
        .load(run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn submit_development_approval(
    run_id: uuid::Uuid,
    approval: HumanApproval,
    state: State<'_, AppCoreState>,
) -> Result<DevelopmentRunSnapshot, String> {
    DevelopmentRunCoordinator::new(state.storage.clone())
        .record_approval(run_id, approval)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_runs(state: State<'_, AppCoreState>) -> Result<Vec<RunSummary>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_runs()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_run(run_id: uuid::Uuid, state: State<'_, AppCoreState>) -> Result<RunDetail, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .get_run(run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_run(run_id: uuid::Uuid, state: State<'_, AppCoreState>) -> Result<RunDetail, String> {
    request_cancellation(&state.storage, &state.data_directory, run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_workflow(workflow: WorkflowDefinition) -> ValidationReport {
    validate_definition(&workflow)
}

#[tauri::command]
fn get_standard_workflow() -> WorkflowDefinition {
    standard_development_workflow()
}

#[tauri::command]
fn publish_workflow(
    workflow: WorkflowDefinition,
    state: State<'_, AppCoreState>,
) -> Result<WorkflowVersionRecord, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .publish_workflow(&workflow)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_workflow_versions(
    state: State<'_, AppCoreState>,
) -> Result<Vec<WorkflowVersionRecord>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_workflow_versions()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_checkpoints(
    run_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<Vec<CheckpointRecord>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_checkpoints(run_id)
        .map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttemptLogs {
    stdout: String,
    stderr: String,
    has_result: bool,
}

#[tauri::command]
fn get_attempt_logs(
    run_id: uuid::Uuid,
    attempt_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<AttemptLogs, String> {
    let dir = state
        .data_directory
        .join("runs")
        .join(run_id.to_string())
        .join("attempts")
        .join(attempt_id.to_string());
    let stdout = std::fs::read_to_string(dir.join("stdout.log")).unwrap_or_default();
    let stderr = std::fs::read_to_string(dir.join("stderr.log")).unwrap_or_default();
    let has_result = dir.join("result.json").is_file();
    Ok(AttemptLogs {
        stdout,
        stderr,
        has_result,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountOverview {
    accounts: Vec<AccountStatusSummary>,
    active_locks: Vec<ResourceLockRecord>,
    global_concurrency_limit: usize,
}

#[tauri::command]
fn get_account_states(state: State<'_, AppCoreState>) -> Result<AccountOverview, String> {
    let storage = state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?;
    let locks = storage
        .list_resource_locks()
        .map_err(|error| error.to_string())?;

    let configured = [
        ("mock-developer", "Mock Developer", "开发 Agent", "Local Mock / Codex 兼容"),
        ("mock-tester", "Mock Tester", "自动化测试", "Local Test Runner"),
        ("mock-reviewer", "Mock Reviewer", "代码审计", "Local Code Reviewer"),
        ("codex-primary", "Codex Primary", "开发专家", "OpenAI Codex CLI"),
        ("claude-primary", "Claude Primary", "架构与评审", "Anthropic Claude CLI"),
    ];

    let mut accounts = Vec::new();
    for (id, name, role, provider) in configured {
        let lock = locks.iter().find(|l| l.resource_type == "account" && l.resource_id == id);
        accounts.push(AccountStatusSummary {
            account_id: id.to_string(),
            display_name: name.to_string(),
            role: role.to_string(),
            is_locked: lock.is_some(),
            locked_by_attempt_id: lock.map(|l| l.attempt_id),
            provider: provider.to_string(),
        });
    }

    Ok(AccountOverview {
        accounts,
        active_locks: locks,
        global_concurrency_limit: 3,
    })
}

#[tauri::command]
fn get_checkpoint_diff(
    checkpoint_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<String, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .get_checkpoint_diff(checkpoint_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_schedules(state: State<'_, AppCoreState>) -> Result<Vec<ScheduleRecord>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_schedules()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_schedule(
    schedule: ScheduleRecord,
    state: State<'_, AppCoreState>,
) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .save_schedule(&schedule)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_schedule(id: String, state: State<'_, AppCoreState>) -> Result<bool, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .toggle_schedule(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_schedule(id: String, state: State<'_, AppCoreState>) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .delete_schedule(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_goals(state: State<'_, AppCoreState>) -> Result<Vec<GoalRecord>, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_goals()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_goal(goal: GoalRecord, state: State<'_, AppCoreState>) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .save_goal(&goal)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_milestone(milestone_id: String, state: State<'_, AppCoreState>) -> Result<bool, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .toggle_milestone(&milestone_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_goal(id: String, state: State<'_, AppCoreState>) -> Result<(), String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .delete_goal(&id)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_directory)?;
            let instance_lock = AppInstanceLock::acquire(&data_directory)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let storage = Storage::open(&data_directory.join("agentflow.sqlite"))
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let storage = Arc::new(Mutex::new(storage));
            let runner_path = resolve_binary("agentflow-runner")?;
            let mock_cli_path = resolve_binary("agentflow-mock-cli")?;
            let scheduler = SchedulerHandle::start(
                Arc::clone(&storage),
                SchedulerConfig {
                    data_directory: data_directory.clone(),
                    runner_path: runner_path.clone(),
                    mock_cli_path,
                    global_limit: 3,
                    timeout_seconds: 30 * 60,
                    cancellation_grace_seconds: 5,
                },
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(AppCoreState {
                storage,
                data_directory,
                runner_path,
                _instance_lock: instance_lock,
                scheduler,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_status,
            create_mock_task,
            create_mock_development_task,
            get_development_run,
            submit_development_approval,
            list_runs,
            get_run,
            cancel_run,
            validate_workflow,
            get_standard_workflow,
            publish_workflow,
            list_workflow_versions,
            list_checkpoints,
            get_attempt_logs,
            get_account_states,
            get_checkpoint_diff,
            list_schedules,
            save_schedule,
            toggle_schedule,
            delete_schedule,
            list_goals,
            save_goal,
            toggle_milestone,
            delete_goal
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AgentFlow");
}

fn resolve_binary(name: &str) -> Result<PathBuf, std::io::Error> {
    let current_executable = std::env::current_exe()?;
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let candidates = [
        current_executable
            .parent()
            .map(|directory| directory.join(name)),
        Some(workspace.join("target").join("debug").join(name)),
        Some(workspace.join("target").join("release").join(name)),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("required bundled binary was not found: {name}"),
            )
        })
}
