use agentflow_core::{
    development_flow::{HumanApproval, standard_development_workflow},
    development_runtime::{MockDevelopmentScenario, create_mock_development_run},
    domain::{
        AccountStatusSummary, CheckpointRecord, CreateMockTaskRequest, GoalRecord,
        ResourceLockRecord, RunDetail, RunSummary, ScheduleRecord,
    },
    execution::{AppInstanceLock, SchedulerConfig, SchedulerHandle, request_cancellation},
    protocol::RUNNER_PROTOCOL_VERSION,
    storage::{CliUsageRecord, Storage},
    workflow::{
        TaskWorkflowRecord, ValidationReport, WorkflowDefinition, WorkflowVersionRecord,
        starter_task_workflow, validate_workflow as validate_definition,
    },
    workflow_run::{
        CreateDevelopmentRunRequest, DevelopmentRunCoordinator, DevelopmentRunSnapshot,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
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
fn create_task_workflow_draft(
    request: CreateDevelopmentRunRequest,
    state: State<'_, AppCoreState>,
) -> Result<RunDetail, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .create_task_workflow_draft(request, &starter_task_workflow(), serde_json::json!({}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_task_workflow(
    run_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<TaskWorkflowRecord, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .task_workflow(run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_task_workflow(
    run_id: uuid::Uuid,
    workflow: WorkflowDefinition,
    layout: serde_json::Value,
    state: State<'_, AppCoreState>,
) -> Result<TaskWorkflowRecord, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .save_task_workflow(run_id, &workflow, layout)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_task_workflow(
    run_id: uuid::Uuid,
    state: State<'_, AppCoreState>,
) -> Result<TaskWorkflowRecord, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .start_task_workflow(run_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn submit_task_workflow_approval(
    run_id: uuid::Uuid,
    approved: bool,
    state: State<'_, AppCoreState>,
) -> Result<TaskWorkflowRecord, String> {
    state
        .storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .submit_task_workflow_approval(run_id, approved)
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
        (
            "mock-developer",
            "Mock Developer",
            "开发 Agent",
            "Local Mock / Codex 兼容",
        ),
        (
            "mock-tester",
            "Mock Tester",
            "自动化测试",
            "Local Test Runner",
        ),
        (
            "mock-reviewer",
            "Mock Reviewer",
            "代码审计",
            "Local Code Reviewer",
        ),
        (
            "codex-primary",
            "Codex Primary",
            "开发专家",
            "OpenAI Codex CLI",
        ),
        (
            "claude-primary",
            "Claude Primary",
            "架构与评审",
            "Anthropic Claude CLI",
        ),
    ];

    let mut accounts = Vec::new();
    for (id, name, role, provider) in configured {
        let lock = locks
            .iter()
            .find(|l| l.resource_type == "account" && l.resource_id == id);
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
fn save_schedule(schedule: ScheduleRecord, state: State<'_, AppCoreState>) -> Result<(), String> {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedCliAgent {
    pub id: String,
    pub name: String,
    pub executable_path: Option<String>,
    pub available: bool,
    pub version: Option<String>,
    pub account_email: Option<String>,
    pub custom_home: Option<String>,
    pub is_authenticated: bool,
}

fn get_agy_account_email(home_dir: &std::path::Path) -> Option<String> {
    let accounts_json = home_dir.join(".gemini/google_accounts.json");
    if accounts_json.is_file() {
        if let Ok(content) = std::fs::read_to_string(accounts_json) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(active) = val.get("active").and_then(|a| a.as_str()) {
                    if !active.trim().is_empty() {
                        return Some(active.to_string());
                    }
                }
            }
        }
    }
    None
}

fn has_agy_credentials(home_dir: &std::path::Path) -> bool {
    get_agy_account_email(home_dir).is_some()
        || home_dir
            .join(".gemini/antigravity-cli/antigravity-oauth-token")
            .is_file()
}

fn which_in_path(cmd: &str) -> Option<PathBuf> {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
            None
        })
}

#[tauri::command]
fn detect_local_cli_agents() -> Vec<DetectedCliAgent> {
    let mut agents = Vec::new();
    let home = std::env::var("HOME").ok().map(PathBuf::from);

    // Common agy binary path
    let agy_candidates = [
        home.as_ref().map(|h| h.join(".local/bin/agy")),
        Some(PathBuf::from("/usr/local/bin/agy")),
        Some(PathBuf::from("/opt/homebrew/bin/agy")),
    ];
    let agy_path = agy_candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .or_else(|| which_in_path("agy"));
    let agy_avail = agy_path.is_some();
    let agy_path_str = agy_path.as_ref().map(|p| p.to_string_lossy().to_string());

    // 1. Google agy Account 1 (Main / Default HOME)
    let email_1 = home.as_ref().and_then(|h| get_agy_account_email(h));
    let is_auth_1 = home.as_ref().is_some_and(|path| has_agy_credentials(path));
    agents.push(DetectedCliAgent {
        id: "agy-1".to_string(),
        name: "Google agy (账号 1 - 主账号)".to_string(),
        executable_path: agy_path_str.clone(),
        available: agy_avail,
        version: if agy_avail {
            Some(email_1.as_deref().unwrap_or("默认系统环境").to_string())
        } else {
            None
        },
        account_email: email_1,
        custom_home: None,
        is_authenticated: is_auth_1,
    });

    // 2. Google agy Account 2
    let home_acc2 = home.as_ref().map(|h| h.join(".agy-accounts/account2"));
    let email_2 = home_acc2.as_ref().and_then(|h| get_agy_account_email(h));
    let is_auth_2 = home_acc2
        .as_ref()
        .is_some_and(|path| has_agy_credentials(path));
    agents.push(DetectedCliAgent {
        id: "agy-2".to_string(),
        name: "Google agy (账号 2)".to_string(),
        executable_path: agy_path_str.clone(),
        available: agy_avail,
        version: if agy_avail {
            Some(
                email_2
                    .as_deref()
                    .unwrap_or("未登录 · 需在终端登录")
                    .to_string(),
            )
        } else {
            None
        },
        account_email: email_2,
        custom_home: Some("~/.agy-accounts/account2".to_string()),
        is_authenticated: is_auth_2,
    });

    // 3. Google agy Account 3
    let home_acc3 = home.as_ref().map(|h| h.join(".agy-accounts/account3"));
    let email_3 = home_acc3.as_ref().and_then(|h| get_agy_account_email(h));
    let is_auth_3 = home_acc3
        .as_ref()
        .is_some_and(|path| has_agy_credentials(path));
    agents.push(DetectedCliAgent {
        id: "agy-3".to_string(),
        name: "Google agy (账号 3)".to_string(),
        executable_path: agy_path_str,
        available: agy_avail,
        version: if agy_avail {
            Some(
                email_3
                    .as_deref()
                    .unwrap_or("未登录 · 需在终端登录")
                    .to_string(),
            )
        } else {
            None
        },
        account_email: email_3,
        custom_home: Some("~/.agy-accounts/account3".to_string()),
        is_authenticated: is_auth_3,
    });

    // 4. OpenAI Codex CLI (codex)
    let codex_candidates = [
        home.as_ref().map(|h| h.join(".local/bin/codex")),
        Some(PathBuf::from("/usr/local/bin/codex")),
        Some(PathBuf::from("/opt/homebrew/bin/codex")),
    ];
    let codex_path = codex_candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .or_else(|| which_in_path("codex"));
    let codex_version = codex_path.as_ref().and_then(|p| {
        std::process::Command::new(p)
            .arg("--version")
            .output()
            .ok()
            .and_then(|out| {
                if out.status.success() {
                    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
                } else {
                    None
                }
            })
    });
    let codex_avail = codex_path.is_some();
    agents.push(DetectedCliAgent {
        id: "codex".to_string(),
        name: "OpenAI Codex CLI (codex)".to_string(),
        executable_path: codex_path.map(|p| p.to_string_lossy().to_string()),
        available: codex_avail,
        version: codex_version.or_else(|| {
            if codex_avail {
                Some("已就绪".to_string())
            } else {
                None
            }
        }),
        account_email: None,
        custom_home: None,
        is_authenticated: codex_avail,
    });

    agents
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentExecutionResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub conversation_id: Option<String>,
    pub usage: Option<CliTokenUsage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTokenUsage {
    #[serde(alias = "input_tokens")]
    pub input_tokens: u64,
    #[serde(alias = "output_tokens")]
    pub output_tokens: u64,
    #[serde(alias = "thinking_tokens")]
    pub thinking_tokens: u64,
    #[serde(alias = "cache_read_tokens")]
    pub cache_read_tokens: u64,
    #[serde(alias = "total_tokens")]
    pub total_tokens: u64,
}

#[derive(Deserialize)]
struct AgyCliJsonResult {
    #[serde(default)]
    conversation_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    response: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    usage: Option<CliTokenUsage>,
}


#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgyQuotaBucket {
    id: String,
    window: String,
    #[serde(alias = "remaining_fraction")]
    remaining_fraction: f64,
    #[serde(alias = "reset_time")]
    reset_time: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgyQuotaGroup {
    name: String,
    buckets: Vec<AgyQuotaBucket>,
}

#[derive(Deserialize)]
struct AgyQuotaCommandData {
    groups: Vec<AgyQuotaGroup>,
}

#[derive(Deserialize)]
struct AgyQuotaCommand {
    name: String,
    data: AgyQuotaCommandData,
}

#[derive(Deserialize)]
struct AgyQuotaResponse {
    status: String,
    command: AgyQuotaCommand,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliAgentRequest {
    provider_id: String,
    prompt: String,
    model: String,
    reasoning_effort: String,
    working_directory: String,
}

struct CliInvocation {
    program: PathBuf,
    arguments: Vec<String>,
    working_directory: PathBuf,
    custom_home: Option<PathBuf>,
}

#[tauri::command]
fn open_cli_login(provider_id: String) -> Result<(), String> {
    let (program, custom_home) = resolve_cli_provider(&provider_id)?;
    if !provider_id.starts_with("provider-cli-agy-") {
        return Err("该 provider 不支持终端登录".to_owned());
    }
    let command = match custom_home {
        Some(home) => format!("HOME={} {}", shell_quote(&home), shell_quote(&program)),
        None => shell_quote(&program),
    };
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("tell application \"Terminal\" to do script \"{escaped}\"");
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("打开系统终端失败: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn run_cli_agent(
    request: CliAgentRequest,
    state: State<'_, AppCoreState>,
) -> Result<CliAgentExecutionResult, String> {
    let storage = Arc::clone(&state.storage);
    tauri::async_runtime::spawn_blocking(move || {
        let provider_id = request.provider_id.clone();
        let model = request.model.clone();
        let invocation = build_cli_invocation(request)?;
        let mut cmd = std::process::Command::new(&invocation.program);
        cmd.args(&invocation.arguments)
            .current_dir(&invocation.working_directory);

        let sys_home = std::env::var("HOME").unwrap_or_default();
        let existing_path = std::env::var("PATH").unwrap_or_default();
        let full_path =
            format!("{sys_home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:{existing_path}");
        cmd.env("PATH", full_path);

        if let Some(home) = invocation.custom_home {
            cmd.env("HOME", home);
        }
        if provider_id.starts_with("provider-cli-agy-") {
            cmd.env("SSH_CONNECTION", "127.0.0.1 50000 127.0.0.1 22");
        }

        let output = cmd
            .output()
            .map_err(|err| format!("启动受限 CLI provider 失败: {err}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if provider_id.starts_with("provider-cli-agy-") {
            if let Ok(parsed) = serde_json::from_str::<AgyCliJsonResult>(&stdout) {
                if parsed.status == "SUCCESS" {
                    if let Some(usage) = &parsed.usage {
                        let _ = storage
                            .lock()
                            .map_err(|_| "database mutex is poisoned".to_owned())
                            .and_then(|guard| {
                                guard.record_cli_usage(&CliUsageRecord {
                                    provider_id: provider_id.clone(),
                                    model: model.clone(),
                                    input_tokens: usage.input_tokens,
                                    output_tokens: usage.output_tokens,
                                    thinking_tokens: usage.thinking_tokens,
                                    cache_read_tokens: usage.cache_read_tokens,
                                    total_tokens: usage.total_tokens,
                                    created_at: chrono::Utc::now().to_rfc3339(),
                                })
                                .map_err(|error| format!("保存 agy Token 用量失败: {error}"))
                            });
                    }
                    return Ok(CliAgentExecutionResult {
                        success: true,
                        exit_code: output.status.code(),
                        stdout: parsed.response,
                        stderr,
                        conversation_id: Some(parsed.conversation_id),
                        usage: parsed.usage,
                    });
                } else {
                    let err_detail = parsed
                        .error
                        .filter(|e| !e.is_empty())
                        .unwrap_or(parsed.status);
                    let friendly_msg = if err_detail.contains("authentication failed")
                        || err_detail.contains("timed out")
                        || err_detail.contains("not logged in")
                    {
                        format!(
                            "[CLI 执行错误] 账号认证失败 ({err_detail})。\n该账号登录凭据已过期或未授权，请在设置中通过【终端登录】重新授权该账号。"
                        )
                    } else {
                        format!("[CLI 执行错误] agy 执行异常: {err_detail}")
                    };
                    return Ok(CliAgentExecutionResult {
                        success: false,
                        exit_code: Some(1),
                        stdout: friendly_msg,
                        stderr,
                        conversation_id: None,
                        usage: None,
                    });
                }
            }
        }

        Ok(CliAgentExecutionResult {
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout,
            stderr,
            conversation_id: None,
            usage: None,
        })
    })
    .await
    .map_err(|err| format!("CLI 异步执行异常: {err}"))?
}

fn build_cli_invocation(request: CliAgentRequest) -> Result<CliInvocation, String> {
    let prompt = request.prompt.trim();
    if prompt.is_empty() || prompt.len() > 100_000 {
        return Err("Prompt 不能为空且不能超过 100000 字节".to_owned());
    }
    let working_directory = PathBuf::from(request.working_directory.trim())
        .canonicalize()
        .map_err(|error| format!("工作区不可访问: {error}"))?;
    if !working_directory.is_dir() {
        return Err("工作区必须是目录".to_owned());
    }
    let (program, custom_home) = resolve_cli_provider(&request.provider_id)?;
    let arguments = cli_arguments(
        &request.provider_id,
        prompt,
        &request.model,
        &request.reasoning_effort,
        &working_directory,
    )?;
    Ok(CliInvocation {
        program,
        arguments,
        working_directory,
        custom_home,
    })
}

fn cli_arguments(
    provider_id: &str,
    prompt: &str,
    model: &str,
    reasoning_effort: &str,
    working_directory: &std::path::Path,
) -> Result<Vec<String>, String> {
    if provider_id == "provider-cli-codex" {
        let model = allowed_codex_model(model)?;
        Ok(vec![
            "exec".to_owned(),
            prompt.to_owned(),
            "--sandbox".to_owned(),
            "workspace-write".to_owned(),
            "--approve-for-me".to_owned(),
            "-C".to_owned(),
            working_directory.to_string_lossy().into_owned(),
            "-m".to_owned(),
            model.to_owned(),
        ])
    } else {
        if !matches!(
            provider_id,
            "provider-cli-agy-1" | "provider-cli-agy-2" | "provider-cli-agy-3"
        ) {
            return Err("不支持的 CLI provider".to_owned());
        }
        let model = allowed_agy_model(model);
        let effort = match reasoning_effort {
            "深度" | "强劲" | "极致" => "high",
            "轻度" | "快速" => "low",
            _ => "medium",
        };
        Ok(vec![
            "-p".to_owned(),
            prompt.to_owned(),
            "--sandbox".to_owned(),
            "--mode".to_owned(),
            "accept-edits".to_owned(),
            "--model".to_owned(),
            model.to_owned(),
            "--effort".to_owned(),
            effort.to_owned(),
            "--output-format".to_owned(),
            "json".to_owned(),
        ])
    }
}

fn resolve_cli_provider(provider_id: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    let system_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "无法解析用户 HOME".to_owned())?;
    let (binary, custom_home) = match provider_id {
        "provider-cli-agy-1" => ("agy", None),
        "provider-cli-agy-2" => ("agy", Some(system_home.join(".agy-accounts/account2"))),
        "provider-cli-agy-3" => ("agy", Some(system_home.join(".agy-accounts/account3"))),
        "provider-cli-codex" => ("codex", None),
        _ => return Err("不支持的 CLI provider".to_owned()),
    };
    let program = find_supported_cli(binary, &system_home)
        .ok_or_else(|| format!("未找到受支持的 CLI: {binary}"))?;
    Ok((program, custom_home))
}

fn find_supported_cli(binary: &str, home: &Path) -> Option<PathBuf> {
    [
        home.join(".local/bin").join(binary),
        PathBuf::from("/usr/local/bin").join(binary),
        PathBuf::from("/opt/homebrew/bin").join(binary),
    ]
    .into_iter()
    .find(|path| path.is_file())
    .or_else(|| which_in_path(binary))
}

fn allowed_codex_model(model: &str) -> Result<&'static str, String> {
    match model {
        "GPT-6 Astra" => Ok("gpt-6-astra"),
        "GPT-5.6 Sol" => Ok("gpt-5.6-sol"),
        "GPT-5.6 Terra" => Ok("gpt-5.6-terra"),
        "GPT-5.6 Luna" => Ok("gpt-5.6-luna"),
        "GPT-5.5" => Ok("gpt-5.5"),
        _ => Err("不支持的 Codex 模型".to_owned()),
    }
}

fn allowed_agy_model(model: &str) -> &'static str {
    const MODELS: &[&str] = &[
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.7-flash-high",
        "gemini-3.7-flash-medium",
        "gemini-3.7-flash-low",
        "gemini-3.6-flash-high",
        "gemini-3.6-flash-medium",
        "gemini-3.6-flash-low",
        "gemini-3.1-pro-high",
        "gemini-3.1-pro-low",
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium",
    ];
    MODELS
        .iter()
        .copied()
        .find(|candidate| *candidate == model)
        .unwrap_or("gemini-3.8-flash-high")
}

fn shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceInfo {
    pub is_git: bool,
    pub current_branch: Option<String>,
    pub branches: Vec<String>,
    pub uncommitted_count: usize,
}

#[tauri::command]
fn get_git_workspace_info(path: String) -> GitWorkspaceInfo {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return GitWorkspaceInfo {
            is_git: false,
            current_branch: None,
            branches: Vec::new(),
            uncommitted_count: 0,
        };
    }

    let branch_out = std::process::Command::new("git")
        .args(["-C", &path, "branch", "--show-current"])
        .output();

    let current_branch = branch_out.ok().and_then(|out| {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() { Some(s) } else { None }
        } else {
            None
        }
    });

    if current_branch.is_none() {
        return GitWorkspaceInfo {
            is_git: false,
            current_branch: None,
            branches: Vec::new(),
            uncommitted_count: 0,
        };
    }

    let list_out = std::process::Command::new("git")
        .args(["-C", &path, "branch", "--format=%(refname:short)"])
        .output();
    let branches = list_out
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let status_out = std::process::Command::new("git")
        .args(["-C", &path, "status", "--porcelain"])
        .output();
    let uncommitted_count = status_out
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.trim().is_empty())
                .count()
        })
        .unwrap_or(0);

    GitWorkspaceInfo {
        is_git: true,
        current_branch,
        branches,
        uncommitted_count,
    }
}

#[tauri::command]
fn checkout_git_branch(path: String, branch: String, create: bool) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(&path).arg("checkout");
    if create {
        cmd.arg("-b");
    }
    cmd.arg(&branch);
    let output = cmd.output().map_err(|e| format!("git 命令执行失败: {e}"))?;
    if output.status.success() {
        Ok(format!("成功切换至分支 {branch}"))
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
async fn pick_directory() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"请选择项目工作区文件夹\")")
            .output();

        match output {
            Ok(out) => {
                if out.status.success() {
                    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let clean_path = path.trim_end_matches('/').to_string();
                    if !clean_path.is_empty() {
                        Ok(Some(clean_path))
                    } else {
                        Ok(None)
                    }
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(format!("调起 Finder 失败: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TokenUsageSummary {
    lifetime_tokens: Option<u64>,
    peak_daily_tokens: Option<u64>,
    longest_running_turn_sec: Option<u64>,
    current_streak_days: Option<u64>,
    longest_streak_days: Option<u64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateLimitWindow {
    used_percent: f64,
    window_duration_mins: u64,
    resets_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditBalance {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexUsageStats {
    available: bool,
    error: Option<String>,
    plan_type: Option<String>,
    summary: TokenUsageSummary,
    daily_usage: std::collections::HashMap<String, u64>,
    primary: Option<RateLimitWindow>,
    secondary: Option<RateLimitWindow>,
    credits: Option<CreditBalance>,
    refreshed_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderUsageStatus {
    provider_id: String,
    name: String,
    available: bool,
    error: Option<String>,
    total_tokens: u64,
    daily_usage: std::collections::HashMap<String, u64>,
    latest_usage: Option<CliTokenUsage>,
    latest_model: Option<String>,
    latest_at: Option<String>,
    quota_groups: Vec<AgyQuotaGroup>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealCliTokenStats {
    codex: CodexUsageStats,
    agy_accounts: Vec<ProviderUsageStatus>,
}

fn find_codex_executable() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    [
        home.map(|path| path.join(".local/bin/codex")),
        Some(PathBuf::from("/usr/local/bin/codex")),
        Some(PathBuf::from("/opt/homebrew/bin/codex")),
    ]
    .into_iter()
    .flatten()
    .find(|path| path.is_file())
    .or_else(|| which_in_path("codex"))
}

fn json_rpc_result<'a>(
    messages: &'a [serde_json::Value],
    id: u64,
) -> Option<&'a serde_json::Value> {
    messages
        .iter()
        .find(|message| message.get("id").and_then(serde_json::Value::as_u64) == Some(id))
        .and_then(|message| message.get("result"))
}

fn parse_rate_limit_window(value: Option<&serde_json::Value>) -> Option<RateLimitWindow> {
    let value = value?;
    Some(RateLimitWindow {
        used_percent: value.get("usedPercent")?.as_f64()?,
        window_duration_mins: value.get("windowDurationMins")?.as_u64()?,
        resets_at: value.get("resetsAt")?.as_u64()?,
    })
}

fn read_codex_app_server() -> Result<Vec<serde_json::Value>, String> {
    let executable = find_codex_executable().ok_or_else(|| "未找到 Codex CLI".to_string())?;
    let mut child = Command::new(executable)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 Codex app-server: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Codex stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Codex stdout".to_string())?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = sender.send(value);
            }
        }
    });

    let initialize = serde_json::json!({
        "method": "initialize",
        "id": 0,
        "params": { "clientInfo": { "name": "agentflow", "title": "AgentFlow", "version": env!("CARGO_PKG_VERSION") } }
    });
    writeln!(stdin, "{initialize}").map_err(|error| error.to_string())?;
    let initialized = receiver
        .recv_timeout(Duration::from_secs(8))
        .map_err(|_| "Codex app-server 初始化超时".to_string())?;
    if initialized.get("id").and_then(serde_json::Value::as_u64) != Some(0) {
        let _ = child.kill();
        return Err("Codex app-server 初始化失败".to_string());
    }

    for request in [
        serde_json::json!({ "method": "initialized", "params": {} }),
        serde_json::json!({ "method": "account/read", "id": 1, "params": { "refreshToken": false } }),
        serde_json::json!({ "method": "account/rateLimits/read", "id": 2 }),
        serde_json::json!({ "method": "account/usage/read", "id": 3 }),
    ] {
        writeln!(stdin, "{request}").map_err(|error| error.to_string())?;
    }
    stdin.flush().map_err(|error| error.to_string())?;

    let mut messages = vec![initialized];
    while ![1, 2, 3]
        .iter()
        .all(|id| json_rpc_result(&messages, *id).is_some())
    {
        match receiver.recv_timeout(Duration::from_secs(10)) {
            Ok(message) => messages.push(message),
            Err(_) => {
                let _ = child.kill();
                return Err("读取 Codex 官方用量接口超时".to_string());
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(messages)
}

fn read_agy_quota(provider_id: &str) -> Result<Vec<AgyQuotaGroup>, String> {
    let (program, custom_home) = resolve_cli_provider(provider_id)?;
    let system_home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "无法解析用户 HOME".to_string())?;
    let credential_home = custom_home.as_deref().unwrap_or(&system_home);
    if !has_agy_credentials(credential_home) {
        return Err("该 agy 账号没有可用的本地凭据".to_string());
    }
    let mut command = Command::new(program);
    command.args([
        "--print",
        "/usage",
        "--output-format",
        "json",
        "--sandbox",
        "--mode",
        "plan",
        "--print-timeout",
        "60s",
    ]);
    if let Some(home) = custom_home {
        command.env("HOME", home);
    }
    // Set SSH_CONNECTION so agy enters headless mode, bypasses macOS Keychain lookup,
    // and reads directly from the isolated antigravity-oauth-token file.
    command.env("SSH_CONNECTION", "127.0.0.1 50000 127.0.0.1 22");
    let output = command
        .output()
        .map_err(|error| format!("无法读取 agy 配额: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let response: AgyQuotaResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("agy /usage 返回格式无效: {error}"))?;
    if response.status != "SUCCESS" || response.command.name != "usage" {
        return Err("agy /usage 未返回成功状态".to_string());
    }
    Ok(response.command.data.groups)
}

#[tauri::command]
fn open_native_view(target: String) -> Result<String, String> {
    match target.as_str() {
        "codex" | "codex_app" => {
            let home = std::env::var("HOME").unwrap_or_default();
            let codex_bin = format!("{home}/.local/bin/codex");
            if std::path::Path::new(&codex_bin).exists() {
                let _ = std::process::Command::new(&codex_bin).arg("app").spawn();
                Ok("已启动官方 Codex 桌面应用".to_string())
            } else {
                let _ = std::process::Command::new("open")
                    .args(["-a", "ChatGPT"])
                    .spawn();
                Ok("已唤起官方 ChatGPT / Codex 应用".to_string())
            }
        }
        "deepseek" | "deepseek_web" => {
            std::process::Command::new("open")
                .arg("https://platform.deepseek.com/usage")
                .spawn()
                .map_err(|e| format!("打开网页失败: {e}"))?;
            Ok("已在浏览器打开 DeepSeek 官方用量中心".to_string())
        }
        "openai" | "openai_web" => {
            std::process::Command::new("open")
                .arg("https://platform.openai.com/usage")
                .spawn()
                .map_err(|e| format!("打开网页失败: {e}"))?;
            Ok("已在浏览器打开 OpenAI 官方用量中心".to_string())
        }
        "siliconflow" | "siliconflow_web" => {
            std::process::Command::new("open")
                .arg("https://cloud.siliconflow.cn/me/models")
                .spawn()
                .map_err(|e| format!("打开网页失败: {e}"))?;
            Ok("已在浏览器打开 SiliconFlow 官方控制台".to_string())
        }
        "agy_1" => {
            open_cli_login("provider-cli-agy-1".to_string())?;
            Ok("已在终端打开 Google agy (账号 1)".to_string())
        }
        "agy_2" => {
            open_cli_login("provider-cli-agy-2".to_string())?;
            Ok("已在终端打开 Google agy (账号 2)".to_string())
        }
        "agy_3" => {
            open_cli_login("provider-cli-agy-3".to_string())?;
            Ok("已在终端打开 Google agy (账号 3)".to_string())
        }
        url if url.starts_with("http://") || url.starts_with("https://") => {
            std::process::Command::new("open")
                .arg(url)
                .spawn()
                .map_err(|e| format!("打开 URL 失败: {e}"))?;
            Ok("已在浏览器打开目标页面".to_string())
        }
        other => Err(format!("未知调用目标: {other}")),
    }
}

#[tauri::command]
async fn get_real_cli_token_stats(
    state: State<'_, AppCoreState>,
) -> Result<RealCliTokenStats, String> {
    let storage = Arc::clone(&state.storage);
    let data_directory = state.data_directory.clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_real_cli_token_stats(storage, &data_directory)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn get_cached_cli_token_stats(
    state: State<'_, AppCoreState>,
) -> Result<Option<RealCliTokenStats>, String> {
    let path = state.data_directory.join("cli-token-stats.json");
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(serde_json::from_str(&content).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let records = state
                .storage
                .lock()
                .map_err(|_| "database mutex is poisoned".to_owned())?
                .list_cli_usage()
                .map_err(|storage_error| storage_error.to_string())?;
            Ok(Some(local_cli_token_stats(&records)))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn local_cli_token_stats(records: &[CliUsageRecord]) -> RealCliTokenStats {
    let account = |provider_id: &str, name: &str| {
        let mut daily_usage = std::collections::HashMap::new();
        for record in records
            .iter()
            .filter(|record| record.provider_id == provider_id)
        {
            let date = record.created_at.chars().take(10).collect::<String>();
            *daily_usage.entry(date).or_insert(0) += record.total_tokens;
        }
        ProviderUsageStatus {
            provider_id: provider_id.to_string(),
            name: name.to_string(),
            available: false,
            error: Some("正在后台更新配额".to_string()),
            total_tokens: 0,
            daily_usage,
            latest_usage: None,
            latest_model: None,
            latest_at: None,
            quota_groups: Vec::new(),
        }
    };
    RealCliTokenStats {
        codex: CodexUsageStats {
            available: false,
            error: Some("正在后台更新配额".to_string()),
            plan_type: None,
            summary: TokenUsageSummary::default(),
            daily_usage: std::collections::HashMap::new(),
            primary: None,
            secondary: None,
            credits: None,
            refreshed_at: chrono::Utc::now().to_rfc3339(),
        },
        agy_accounts: vec![
            account("provider-cli-agy-1", "Google agy (账号 1 - 主账号)"),
            account("provider-cli-agy-2", "Google agy (账号 2)"),
            account("provider-cli-agy-3", "Google agy (账号 3)"),
        ],
    }
}

fn read_real_cli_token_stats(
    storage: Arc<Mutex<Storage>>,
    data_directory: &Path,
) -> Result<RealCliTokenStats, String> {
    let refreshed_at = chrono::Utc::now().to_rfc3339();
    let codex = match read_codex_app_server() {
        Ok(messages) => {
            let account = json_rpc_result(&messages, 1).and_then(|result| result.get("account"));
            let rate_limits =
                json_rpc_result(&messages, 2).and_then(|result| result.get("rateLimits"));
            let usage = json_rpc_result(&messages, 3);
            let summary_value = usage
                .and_then(|value| value.get("summary"))
                .cloned()
                .unwrap_or_default();
            let number = |name: &str| summary_value.get(name).and_then(serde_json::Value::as_u64);
            let mut daily_usage = std::collections::HashMap::new();
            if let Some(buckets) = usage
                .and_then(|value| value.get("dailyUsageBuckets"))
                .and_then(serde_json::Value::as_array)
            {
                for bucket in buckets {
                    if let (Some(date), Some(tokens)) = (
                        bucket.get("startDate").and_then(serde_json::Value::as_str),
                        bucket.get("tokens").and_then(serde_json::Value::as_u64),
                    ) {
                        daily_usage.insert(date.to_string(), tokens);
                    }
                }
            }
            let credits = rate_limits
                .and_then(|value| value.get("credits"))
                .map(|value| CreditBalance {
                    has_credits: value
                        .get("hasCredits")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    unlimited: value
                        .get("unlimited")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    balance: value
                        .get("balance")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                });
            CodexUsageStats {
                available: usage.is_some(),
                error: usage
                    .is_none()
                    .then(|| "Codex 官方接口未返回 Token 用量".to_string()),
                plan_type: rate_limits
                    .and_then(|value| value.get("planType"))
                    .or_else(|| account.and_then(|value| value.get("planType")))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                summary: TokenUsageSummary {
                    lifetime_tokens: number("lifetimeTokens"),
                    peak_daily_tokens: number("peakDailyTokens"),
                    longest_running_turn_sec: number("longestRunningTurnSec"),
                    current_streak_days: number("currentStreakDays"),
                    longest_streak_days: number("longestStreakDays"),
                },
                daily_usage,
                primary: parse_rate_limit_window(
                    rate_limits.and_then(|value| value.get("primary")),
                ),
                secondary: parse_rate_limit_window(
                    rate_limits.and_then(|value| value.get("secondary")),
                ),
                credits,
                refreshed_at: refreshed_at.clone(),
            }
        }
        Err(error) => CodexUsageStats {
            available: false,
            error: Some(error),
            plan_type: None,
            summary: TokenUsageSummary::default(),
            daily_usage: std::collections::HashMap::new(),
            primary: None,
            secondary: None,
            credits: None,
            refreshed_at: refreshed_at.clone(),
        },
    };
    let records = storage
        .lock()
        .map_err(|_| "database mutex is poisoned".to_owned())?
        .list_cli_usage()
        .map_err(|error| error.to_string())?;
    let quota_handles = [
        "provider-cli-agy-1",
        "provider-cli-agy-2",
        "provider-cli-agy-3",
    ]
    .into_iter()
    .map(|provider_id| {
        (
            provider_id,
            std::thread::spawn(move || read_agy_quota(provider_id)),
        )
    })
    .collect::<Vec<_>>();
    let quota_results = quota_handles
        .into_iter()
        .map(|(provider_id, handle)| {
            let result = handle
                .join()
                .unwrap_or_else(|_| Err("agy 配额读取线程异常退出".to_string()));
            (provider_id, result)
        })
        .collect::<std::collections::HashMap<_, _>>();
    let agy_account = |provider_id: &'static str, name: &'static str| {
        let matching = records
            .iter()
            .filter(|record| record.provider_id == provider_id)
            .collect::<Vec<_>>();
        let mut daily_usage = std::collections::HashMap::new();
        for record in &matching {
            let date = record.created_at.chars().take(10).collect::<String>();
            *daily_usage.entry(date).or_insert(0) += record.total_tokens;
        }
        let latest = matching.first();
        let quota_result = quota_results.get(provider_id);
        let quota_groups = quota_result
            .and_then(|result| result.as_ref().ok())
            .cloned()
            .unwrap_or_default();
        ProviderUsageStatus {
            provider_id: provider_id.to_string(),
            name: name.to_string(),
            available: !quota_groups.is_empty(),
            error: quota_result
                .and_then(|result| result.as_ref().err())
                .map(|_| "无法读取该账号的 agy 官方配额，请检查登录状态".to_string()),
            total_tokens: matching.iter().map(|record| record.total_tokens).sum(),
            daily_usage,
            latest_usage: latest.map(|record| CliTokenUsage {
                input_tokens: record.input_tokens,
                output_tokens: record.output_tokens,
                thinking_tokens: record.thinking_tokens,
                cache_read_tokens: record.cache_read_tokens,
                total_tokens: record.total_tokens,
            }),
            latest_model: latest.map(|record| record.model.clone()),
            latest_at: latest.map(|record| record.created_at.clone()),
            quota_groups,
        }
    };
    let stats = RealCliTokenStats {
        codex,
        agy_accounts: vec![
            agy_account("provider-cli-agy-1", "Google agy (账号 1 - 主账号)"),
            agy_account("provider-cli-agy-2", "Google agy (账号 2)"),
            agy_account("provider-cli-agy-3", "Google agy (账号 3)"),
        ],
    };
    if let Ok(content) = serde_json::to_vec(&stats) {
        let temporary = data_directory.join("cli-token-stats.json.tmp");
        let destination = data_directory.join("cli-token-stats.json");
        if std::fs::write(&temporary, content).is_ok() {
            let _ = std::fs::rename(temporary, destination);
        }
    }
    Ok(stats)
}

#[tauri::command]
fn fetch_external_url(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("仅支持 http:// 或 https:// 链接".to_string());
    }
    let output = Command::new("curl")
        .arg("-sSL")
        .arg("--max-time")
        .arg("15")
        .arg(&url)
        .output()
        .map_err(|e| format!("执行网络请求失败: {}", e))?;

    if !output.status.success() {
        return Err(format!("下载失败，状态码: {:?}", output.status.code()));
    }

    let body = String::from_utf8_lossy(&output.stdout).to_string();
    if body.trim().is_empty() {
        return Err("下载内容为空或链接无法访问".to_string());
    }
    Ok(body)
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
            create_task_workflow_draft,
            get_task_workflow,
            save_task_workflow,
            start_task_workflow,
            submit_task_workflow_approval,
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
            delete_goal,
            detect_local_cli_agents,
            run_cli_agent,
            open_cli_login,
            get_git_workspace_info,
            checkout_git_branch,
            pick_directory,
            open_native_view,
            get_cached_cli_token_stats,
            get_real_cli_token_stats,
            fetch_external_url
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

#[cfg(test)]
mod desktop_command_tests {
    use super::*;

    #[test]
    fn cli_arguments_are_provider_owned_and_sandboxed() {
        let workspace = PathBuf::from("/tmp/agentflow fixture");
        let codex = cli_arguments(
            "provider-cli-codex",
            "inspect",
            "GPT-5.5",
            "深度",
            &workspace,
        )
        .unwrap();
        assert!(
            codex
                .windows(2)
                .any(|pair| pair == ["--sandbox", "workspace-write"])
        );
        assert!(codex.iter().any(|argument| argument == "--approve-for-me"));
        let agy = cli_arguments(
            "provider-cli-agy-2",
            "inspect",
            "gemini-3.8-flash-low",
            "深度",
            &workspace,
        )
        .unwrap();
        assert!(agy.iter().any(|argument| argument == "--sandbox"));
        assert!(
            agy.windows(2)
                .any(|pair| pair == ["--output-format", "json"])
        );
        for arguments in [&codex, &agy] {
            assert!(
                !arguments
                    .iter()
                    .any(|argument| argument.contains("dangerously"))
            );
        }
        assert!(cli_arguments("/bin/sh", "inspect", "GPT-5.5", "深度", &workspace).is_err());
    }

    #[test]
    fn model_allowlists_reject_arbitrary_cli_flags() {
        assert!(allowed_codex_model("--danger-full-access").is_err());
        assert_eq!(allowed_agy_model("--dangerously-skip-permissions"), "gemini-3.8-flash-high");
    }

    #[test]
    fn finds_cli_in_user_local_bin_without_relying_on_path() {
        let home = tempfile::tempdir().unwrap();
        let local_bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&local_bin).unwrap();
        let executable = local_bin.join("agy");
        std::fs::write(&executable, "fixture").unwrap();

        assert_eq!(find_supported_cli("agy", home.path()), Some(executable));
    }

    #[test]
    fn parses_official_rate_limit_window_without_estimating_a_limit() {
        let value = serde_json::json!({
            "usedPercent": 29,
            "windowDurationMins": 300,
            "resetsAt": 1_789_884_165_u64
        });
        let window = parse_rate_limit_window(Some(&value)).unwrap();
        assert_eq!(window.used_percent, 29.0);
        assert_eq!(window.window_duration_mins, 300);
        assert_eq!(window.resets_at, 1_789_884_165);
        assert!(parse_rate_limit_window(Some(&serde_json::json!({}))).is_none());
    }

    #[test]
    fn parses_exact_agy_json_usage() {
        let result: AgyCliJsonResult = serde_json::from_value(serde_json::json!({
            "conversation_id": "conversation-1",
            "status": "SUCCESS",
            "response": "OK\n",
            "usage": {
                "input_tokens": 13396,
                "output_tokens": 1,
                "thinking_tokens": 0,
                "cache_read_tokens": 0,
                "total_tokens": 13397
            }
        }))
        .unwrap();
        assert_eq!(result.response, "OK\n");
        assert_eq!(result.usage.as_ref().unwrap().total_tokens, 13_397);
    }

    #[test]
    fn detects_agy_file_credentials_without_reading_the_token() {
        let directory = tempfile::tempdir().unwrap();
        let credential_directory = directory.path().join(".gemini/antigravity-cli");
        std::fs::create_dir_all(&credential_directory).unwrap();
        assert!(!has_agy_credentials(directory.path()));
        std::fs::write(
            credential_directory.join("antigravity-oauth-token"),
            "opaque",
        )
        .unwrap();
        assert!(has_agy_credentials(directory.path()));
    }

    #[test]
    fn parses_agy_five_hour_and_weekly_quota() {
        let response: AgyQuotaResponse = serde_json::from_value(serde_json::json!({
            "status": "SUCCESS",
            "command": {
                "name": "usage",
                "data": {
                    "groups": [{
                        "name": "Gemini Models",
                        "buckets": [
                            { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.58, "reset_time": "2026-09-23T02:33:59Z" },
                            { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.99, "reset_time": "2026-09-20T07:37:26Z" }
                        ]
                    }]
                }
            }
        }))
        .unwrap();
        let buckets = &response.command.data.groups[0].buckets;
        assert_eq!(buckets[0].window, "weekly");
        assert_eq!(buckets[0].remaining_fraction, 0.58);
        assert_eq!(buckets[1].window, "5h");
        assert_eq!(buckets[1].remaining_fraction, 0.99);
    }
}
