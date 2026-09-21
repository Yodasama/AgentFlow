use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use fs2::FileExt;
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    development_runtime::{DevelopmentRuntimeError, advance_mock_development_runs},
    domain::{
        ActiveAttempt, AttemptCompletion, AttemptState, MockOutcome, PreparedAttempt, RunDetail,
    },
    protocol::{
        CancellationRequest, LaunchManifest, RUNNER_PROTOCOL_VERSION, RunnerIdentity, RunnerResult,
        TerminationReason, read_json, write_json_atomically,
    },
    storage::{Storage, StorageError},
    task_workflow_runtime::{TaskWorkflowRuntimeError, advance_task_workflows},
};

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_STRUCTURED_OUTPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub data_directory: PathBuf,
    pub runner_path: PathBuf,
    pub mock_cli_path: PathBuf,
    pub global_limit: u32,
    pub timeout_seconds: u64,
    pub cancellation_grace_seconds: u64,
}

impl SchedulerConfig {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        for (name, path) in [
            ("data directory", &self.data_directory),
            ("runner", &self.runner_path),
            ("mock CLI", &self.mock_cli_path),
        ] {
            if !path.is_absolute() {
                return Err(ExecutionError::InvalidConfiguration(format!(
                    "{name} path must be absolute: {}",
                    path.display()
                )));
            }
        }
        if self.global_limit == 0 {
            return Err(ExecutionError::InvalidConfiguration(
                "global limit must be greater than zero".to_owned(),
            ));
        }
        if self.timeout_seconds == 0 {
            return Err(ExecutionError::InvalidConfiguration(
                "timeout must be greater than zero".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum ExecutionError {
    #[error("execution I/O error: {0}")]
    Io(#[from] io::Error),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Development(#[from] DevelopmentRuntimeError),
    #[error(transparent)]
    TaskWorkflow(#[from] TaskWorkflowRuntimeError),
    #[error("scheduler configuration is invalid: {0}")]
    InvalidConfiguration(String),
    #[error("runner identity is invalid for attempt {0}")]
    InvalidIdentity(Uuid),
    #[error("runner result is invalid for attempt {0}")]
    InvalidResult(Uuid),
    #[error("database mutex is poisoned")]
    PoisonedStorage,
}

pub struct AppInstanceLock {
    _file: File,
}

impl AppInstanceLock {
    pub fn acquire(data_directory: &Path) -> Result<Self, ExecutionError> {
        fs::create_dir_all(data_directory)?;
        let path = data_directory.join("agentflow.instance.lock");
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        file.try_lock_exclusive().map_err(|error| {
            ExecutionError::InvalidConfiguration(format!(
                "another AgentFlow instance already owns the data directory: {error}"
            ))
        })?;
        file.set_len(0)?;
        writeln!(file, "{}", std::process::id())?;
        file.sync_all()?;
        Ok(Self { _file: file })
    }
}

pub struct SchedulerHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl SchedulerHandle {
    pub fn start(
        storage: Arc<Mutex<Storage>>,
        config: SchedulerConfig,
    ) -> Result<Self, ExecutionError> {
        config.validate()?;
        fs::create_dir_all(&config.data_directory)?;
        let stop = Arc::new(AtomicBool::new(false));
        let last_error = Arc::new(Mutex::new(None));
        let thread_stop = Arc::clone(&stop);
        let thread_error = Arc::clone(&last_error);
        let join = thread::Builder::new()
            .name("agentflow-scheduler".to_owned())
            .spawn(move || {
                if let Err(error) = reconcile_startup(&storage, &config) {
                    record_error(&thread_error, error);
                }
                while !thread_stop.load(Ordering::Relaxed) {
                    if let Err(error) = scheduler_tick(&storage, &config) {
                        record_error(&thread_error, error);
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            })?;
        Ok(Self {
            stop,
            join: Some(join),
            last_error,
        })
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|value| value.clone())
    }
}

impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

pub fn request_cancellation(
    storage: &Arc<Mutex<Storage>>,
    data_directory: &Path,
    run_id: Uuid,
) -> Result<RunDetail, ExecutionError> {
    let active = {
        let mut storage = storage
            .lock()
            .map_err(|_| ExecutionError::PoisonedStorage)?;
        if storage.cancel_queued_run(run_id)? || storage.cancel_idle_development_run(run_id)? {
            return storage.get_run(run_id).map_err(Into::into);
        }
        storage.active_attempt_for_run(run_id)?
    };
    if let Some(attempt) = active {
        let cancellation_path = attempt_paths(data_directory, &attempt).cancellation;
        write_json_atomically(
            &CancellationRequest {
                schema_version: RUNNER_PROTOCOL_VERSION,
                attempt_id: attempt.attempt_id,
                execution_token: attempt.execution_token,
            },
            &cancellation_path,
        )?;
    }
    storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .get_run(run_id)
        .map_err(Into::into)
}

fn scheduler_tick(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
) -> Result<(), ExecutionError> {
    observe_active_attempts(storage, config)?;
    advance_mock_development_runs(storage, config)?;
    advance_task_workflows(storage, config)?;
    let pending = storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .active_attempts()?;
    for attempt in pending
        .into_iter()
        .filter(|attempt| attempt.state == AttemptState::Prepared)
    {
        dispatch_prepared(storage, config, prepared_from_active(&attempt))?;
    }
    loop {
        let prepared = storage
            .lock()
            .map_err(|_| ExecutionError::PoisonedStorage)?
            .claim_next_mock_attempt(config.global_limit)?;
        let Some(prepared) = prepared else {
            break;
        };
        dispatch_prepared(storage, config, prepared)?;
    }
    Ok(())
}

fn reconcile_startup(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
) -> Result<(), ExecutionError> {
    let attempts = storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .active_attempts()?;
    for attempt in attempts {
        if attempt.state == AttemptState::Prepared {
            dispatch_prepared(storage, config, prepared_from_active(&attempt))?;
            continue;
        }
        let paths = attempt_paths(&config.data_directory, &attempt);
        if paths.result.exists() {
            import_result(storage, &attempt, &paths)?;
            continue;
        }
        match read_matching_identity(&attempt, &paths.identity) {
            Ok(identity) if process_is_alive(identity.runner_pid) => {
                mark_running_if_needed(storage, &attempt)?;
            }
            _ => {
                storage
                    .lock()
                    .map_err(|_| ExecutionError::PoisonedStorage)?
                    .mark_attempt_interrupted(&attempt)?;
            }
        }
    }
    Ok(())
}

fn observe_active_attempts(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
) -> Result<(), ExecutionError> {
    let attempts = storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .active_attempts()?;
    for attempt in attempts {
        let paths = attempt_paths(&config.data_directory, &attempt);
        if paths.result.exists() {
            import_result(storage, &attempt, &paths)?;
        } else if attempt.state == AttemptState::Starting && paths.identity.exists() {
            read_matching_identity(&attempt, &paths.identity)?;
            mark_running_if_needed(storage, &attempt)?;
        }
    }
    Ok(())
}

fn dispatch_prepared(
    storage: &Arc<Mutex<Storage>>,
    config: &SchedulerConfig,
    attempt: PreparedAttempt,
) -> Result<(), ExecutionError> {
    let paths = attempt_paths_for_ids(&config.data_directory, attempt.run_id, attempt.attempt_id);
    fs::create_dir_all(&paths.directory)?;
    let working_directory = config
        .data_directory
        .join("workspaces")
        .join(attempt.run_id.to_string());
    fs::create_dir_all(&working_directory)?;
    let arguments = match (attempt.outcome, attempt.delay_milliseconds) {
        (MockOutcome::Succeeded, Some(milliseconds)) => {
            vec!["delay".to_owned(), milliseconds.to_string()]
        }
        (MockOutcome::Succeeded, None) => vec!["success".to_owned()],
        (MockOutcome::Failed, _) => vec!["failure".to_owned()],
    };
    let persisted = storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .workflow_launch(attempt.attempt_id)?;
    let manifest = persisted.unwrap_or(LaunchManifest {
        schema_version: RUNNER_PROTOCOL_VERSION,
        attempt_id: attempt.attempt_id,
        execution_token: attempt.execution_token.clone(),
        executable_path: config.mock_cli_path.clone(),
        arguments,
        working_directory,
        environment: BTreeMap::from([(
            "PATH".to_owned(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
        )]),
        stdout_path: paths.stdout.clone(),
        stderr_path: paths.stderr.clone(),
        identity_path: paths.identity.clone(),
        heartbeat_path: paths.heartbeat.clone(),
        cancellation_path: paths.cancellation.clone(),
        result_path: paths.result.clone(),
        timeout_seconds: config.timeout_seconds,
        cancellation_grace_seconds: config.cancellation_grace_seconds,
    });
    manifest
        .validate()
        .map_err(|error| ExecutionError::InvalidConfiguration(error.to_string()))?;
    write_json_atomically(&manifest, &paths.launch)?;
    storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .mark_attempt_starting(&attempt)?;

    let spawn_result = Command::new(&config.runner_path)
        .arg("--launch")
        .arg(&paths.launch)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Err(error) = spawn_result {
        storage
            .lock()
            .map_err(|_| ExecutionError::PoisonedStorage)?
            .finalize_attempt(
                attempt.attempt_id,
                AttemptCompletion::Failed {
                    result: json!({"message": error.to_string()}),
                    error_code: "runner_launch_failed".to_owned(),
                },
            )?;
    }
    Ok(())
}

fn import_result(
    storage: &Arc<Mutex<Storage>>,
    attempt: &ActiveAttempt,
    paths: &AttemptPaths,
) -> Result<(), ExecutionError> {
    let result: RunnerResult = read_json(&paths.result)?;
    if result.schema_version != RUNNER_PROTOCOL_VERSION
        || result.attempt_id != attempt.attempt_id
        || result.execution_token != attempt.execution_token
    {
        return Err(ExecutionError::InvalidResult(attempt.attempt_id));
    }
    let completion = completion_from_result(&result, &paths.stdout)?;
    storage
        .lock()
        .map_err(|_| ExecutionError::PoisonedStorage)?
        .finalize_attempt(attempt.attempt_id, completion)?;
    Ok(())
}

fn completion_from_result(
    result: &RunnerResult,
    stdout_path: &Path,
) -> Result<AttemptCompletion, ExecutionError> {
    let runner_result = serde_json::to_value(result).map_err(io::Error::other)?;
    match result.termination_reason {
        TerminationReason::Cancelled => Ok(AttemptCompletion::Cancelled(runner_result)),
        TerminationReason::TimedOut => Ok(AttemptCompletion::Failed {
            result: runner_result,
            error_code: "timeout".to_owned(),
        }),
        TerminationReason::LaunchFailed => Ok(AttemptCompletion::Failed {
            result: runner_result,
            error_code: "agent_launch_failed".to_owned(),
        }),
        TerminationReason::Exited if result.exit_code == Some(0) => {
            let metadata = fs::metadata(stdout_path)?;
            if metadata.len() > MAX_STRUCTURED_OUTPUT_BYTES {
                return Ok(AttemptCompletion::Failed {
                    result: json!({"runner": runner_result, "outputBytes": metadata.len()}),
                    error_code: "invalid_output".to_owned(),
                });
            }
            let output = fs::read_to_string(stdout_path)?;
            let parsed = serde_json::from_str::<serde_json::Value>(output.trim());
            match parsed {
                Ok(value)
                    if value.get("schemaVersion").and_then(|value| value.as_u64()) == Some(1)
                        && value.get("status").and_then(|value| value.as_str())
                            == Some("succeeded") =>
                {
                    Ok(AttemptCompletion::Succeeded(
                        json!({"runner": runner_result, "output": value}),
                    ))
                }
                _ => Ok(AttemptCompletion::Failed {
                    result: json!({"runner": runner_result}),
                    error_code: "invalid_output".to_owned(),
                }),
            }
        }
        TerminationReason::Exited => Ok(AttemptCompletion::Failed {
            result: runner_result,
            error_code: "process_exit".to_owned(),
        }),
    }
}

fn read_matching_identity(
    attempt: &ActiveAttempt,
    path: &Path,
) -> Result<RunnerIdentity, ExecutionError> {
    let identity: RunnerIdentity = read_json(path)?;
    if identity.schema_version == RUNNER_PROTOCOL_VERSION
        && identity.attempt_id == attempt.attempt_id
        && identity.execution_token == attempt.execution_token
    {
        Ok(identity)
    } else {
        Err(ExecutionError::InvalidIdentity(attempt.attempt_id))
    }
}

fn mark_running_if_needed(
    storage: &Arc<Mutex<Storage>>,
    attempt: &ActiveAttempt,
) -> Result<(), ExecutionError> {
    if attempt.state == AttemptState::Starting {
        storage
            .lock()
            .map_err(|_| ExecutionError::PoisonedStorage)?
            .mark_attempt_running(attempt)?;
    }
    Ok(())
}

fn prepared_from_active(attempt: &ActiveAttempt) -> PreparedAttempt {
    PreparedAttempt {
        run_id: attempt.run_id,
        step_execution_id: attempt.step_execution_id,
        attempt_id: attempt.attempt_id,
        execution_token: attempt.execution_token.clone(),
        account_id: "mock:default".to_owned(),
        outcome: attempt.outcome,
        delay_milliseconds: attempt.delay_milliseconds,
    }
}

#[derive(Debug)]
struct AttemptPaths {
    directory: PathBuf,
    launch: PathBuf,
    stdout: PathBuf,
    stderr: PathBuf,
    identity: PathBuf,
    heartbeat: PathBuf,
    cancellation: PathBuf,
    result: PathBuf,
}

fn attempt_paths(data_directory: &Path, attempt: &ActiveAttempt) -> AttemptPaths {
    attempt_paths_for_ids(data_directory, attempt.run_id, attempt.attempt_id)
}

fn attempt_paths_for_ids(data_directory: &Path, run_id: Uuid, attempt_id: Uuid) -> AttemptPaths {
    let directory = data_directory
        .join("runs")
        .join(run_id.to_string())
        .join("attempts")
        .join(attempt_id.to_string());
    AttemptPaths {
        launch: directory.join("launch.json"),
        stdout: directory.join("stdout.log"),
        stderr: directory.join("stderr.log"),
        identity: directory.join("identity.json"),
        heartbeat: directory.join("heartbeat.json"),
        cancellation: directory.join("control").join("cancel.json"),
        result: directory.join("result.json"),
        directory,
    }
}

fn process_is_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn record_error(slot: &Mutex<Option<String>>, error: ExecutionError) {
    if let Ok(mut value) = slot.lock() {
        *value = Some(error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn app_instance_lock_rejects_a_second_owner() {
        let directory = tempfile::tempdir().unwrap();
        let first = AppInstanceLock::acquire(directory.path()).unwrap();
        let second = AppInstanceLock::acquire(directory.path());
        assert!(matches!(
            second,
            Err(ExecutionError::InvalidConfiguration(_))
        ));
        drop(first);
        AppInstanceLock::acquire(directory.path()).unwrap();
    }

    #[test]
    fn zero_exit_requires_valid_structured_output() {
        let directory = tempfile::tempdir().unwrap();
        let stdout = directory.path().join("stdout.log");
        fs::write(&stdout, "not JSON\n").unwrap();
        let result = RunnerResult {
            schema_version: RUNNER_PROTOCOL_VERSION,
            attempt_id: Uuid::new_v4(),
            execution_token: "token".to_owned(),
            termination_reason: TerminationReason::Exited,
            exit_code: Some(0),
            started_at: Some(Utc::now()),
            finished_at: Utc::now(),
            error: None,
        };

        assert!(matches!(
            completion_from_result(&result, &stdout).unwrap(),
            AttemptCompletion::Failed { error_code, .. } if error_code == "invalid_output"
        ));
    }
}
