use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use agentflow_core::{
    domain::{CreateMockTaskRequest, MockOutcome, RunState},
    execution::{SchedulerConfig, SchedulerHandle, request_cancellation},
    storage::Storage,
};
use uuid::Uuid;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--host")) {
        return run_scheduler_host();
    }
    let (runner_path, mock_cli_path) = binary_arguments()?;
    let data_directory = env::temp_dir().join(format!(
        "agentflow-scheduler-verification-{}",
        Uuid::new_v4()
    ));
    fs::create_dir_all(&data_directory)?;
    let result = verify(&data_directory, runner_path, mock_cli_path);
    if result.is_ok() {
        fs::remove_dir_all(&data_directory)?;
    } else {
        eprintln!("verification data retained at {}", data_directory.display());
    }
    result
}

fn verify(
    data_directory: &Path,
    runner_path: PathBuf,
    mock_cli_path: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let database_path = data_directory.join("agentflow.sqlite");
    let storage = Arc::new(Mutex::new(Storage::open(&database_path)?));
    let config = SchedulerConfig {
        data_directory: data_directory.to_path_buf(),
        runner_path,
        mock_cli_path,
        global_limit: 3,
        timeout_seconds: 30,
        cancellation_grace_seconds: 1,
    };
    let scheduler = SchedulerHandle::start(Arc::clone(&storage), config.clone())?;

    let parallel_runs = ["mock:one", "mock:two", "mock:three"]
        .into_iter()
        .map(|account| enqueue(&storage, account, MockOutcome::Succeeded, Some(1_200)))
        .collect::<Result<Vec<_>, _>>()?;
    wait_until("three distinct accounts running concurrently", || {
        parallel_runs.iter().all(|run_id| {
            storage
                .lock()
                .unwrap()
                .get_run(*run_id)
                .is_ok_and(|run| run.run_state == RunState::Running)
        })
    })?;
    wait_until("parallel runs succeeded", || {
        all_in_state(&storage, &parallel_runs, RunState::Succeeded)
    })?;

    let serial_runs = [
        enqueue(&storage, "mock:serial", MockOutcome::Succeeded, Some(900))?,
        enqueue(&storage, "mock:serial", MockOutcome::Succeeded, Some(900))?,
    ];
    wait_until("same account has one running and one queued", || {
        let states = serial_runs
            .iter()
            .map(|run_id| storage.lock().unwrap().get_run(*run_id).unwrap().run_state)
            .collect::<Vec<_>>();
        states.contains(&RunState::Running) && states.contains(&RunState::Queued)
    })?;
    wait_until("same-account runs succeeded serially", || {
        all_in_state(&storage, &serial_runs, RunState::Succeeded)
    })?;

    let cancel_run = enqueue(
        &storage,
        "mock:cancel",
        MockOutcome::Succeeded,
        Some(10_000),
    )?;
    wait_for_state(&storage, cancel_run, RunState::Running)?;
    request_cancellation(&storage, data_directory, cancel_run)?;
    wait_for_state(&storage, cancel_run, RunState::Cancelled)?;

    let failed_run = enqueue(&storage, "mock:failure", MockOutcome::Failed, None)?;
    wait_for_state(&storage, failed_run, RunState::Failed)?;

    drop(scheduler);
    let recovery_run = enqueue(
        &storage,
        "mock:recovery",
        MockOutcome::Succeeded,
        Some(1_200),
    )?;
    drop(storage);

    let mut host = Command::new(env::current_exe()?)
        .arg("--host")
        .arg(data_directory)
        .arg(&config.runner_path)
        .arg(&config.mock_cli_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    wait_for_state_in_database(&database_path, recovery_run, RunState::Running)?;
    host.kill()?;
    host.wait()?;
    thread::sleep(Duration::from_millis(1_500));

    let reopened = Arc::new(Mutex::new(Storage::open(&database_path)?));
    let restarted_scheduler = SchedulerHandle::start(Arc::clone(&reopened), config)?;
    wait_for_state(&reopened, recovery_run, RunState::Succeeded)?;
    if let Some(error) = restarted_scheduler.last_error() {
        return Err(format!("scheduler recorded an error: {error}").into());
    }
    drop(restarted_scheduler);
    println!("scheduler verification passed");
    Ok(())
}

fn run_scheduler_host() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(2).map(PathBuf::from);
    let data_directory = arguments.next().ok_or("missing host data directory")?;
    let runner_path = arguments.next().ok_or("missing host runner path")?;
    let mock_cli_path = arguments.next().ok_or("missing host mock CLI path")?;
    let storage = Arc::new(Mutex::new(Storage::open(
        &data_directory.join("agentflow.sqlite"),
    )?));
    let _scheduler = SchedulerHandle::start(
        storage,
        SchedulerConfig {
            data_directory,
            runner_path,
            mock_cli_path,
            global_limit: 3,
            timeout_seconds: 30,
            cancellation_grace_seconds: 1,
        },
    )?;
    thread::sleep(Duration::from_secs(60));
    Ok(())
}

fn binary_arguments() -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1).map(PathBuf::from);
    let runner = arguments
        .next()
        .ok_or("usage: verify_scheduler /absolute/agentflow-runner /absolute/agentflow-mock-cli")?;
    let mock = arguments
        .next()
        .ok_or("usage: verify_scheduler /absolute/agentflow-runner /absolute/agentflow-mock-cli")?;
    if arguments.next().is_some() || !runner.is_absolute() || !mock.is_absolute() {
        return Err(
            "usage: verify_scheduler /absolute/agentflow-runner /absolute/agentflow-mock-cli"
                .into(),
        );
    }
    Ok((runner, mock))
}

fn enqueue(
    storage: &Arc<Mutex<Storage>>,
    account_id: &str,
    outcome: MockOutcome,
    delay_milliseconds: Option<u64>,
) -> Result<Uuid, Box<dyn std::error::Error>> {
    let run = storage
        .lock()
        .map_err(|_| "database mutex is poisoned")?
        .enqueue_mock_task(CreateMockTaskRequest {
            title: format!("Scheduler fixture for {account_id}"),
            description: "Verify independent runner scheduling".to_owned(),
            acceptance_criteria: vec!["terminal state persisted".to_owned()],
            outcome,
            account_id: Some(account_id.to_owned()),
            delay_milliseconds,
        })?;
    Ok(run.run_id)
}

fn all_in_state(storage: &Arc<Mutex<Storage>>, run_ids: &[Uuid], state: RunState) -> bool {
    run_ids.iter().all(|run_id| {
        storage
            .lock()
            .unwrap()
            .get_run(*run_id)
            .is_ok_and(|run| run.run_state == state)
    })
}

fn wait_for_state(
    storage: &Arc<Mutex<Storage>>,
    run_id: Uuid,
    state: RunState,
) -> Result<(), Box<dyn std::error::Error>> {
    wait_until(&format!("run {run_id} reached {state}"), || {
        storage
            .lock()
            .unwrap()
            .get_run(run_id)
            .is_ok_and(|run| run.run_state == state)
    })
}

fn wait_for_state_in_database(
    database_path: &Path,
    run_id: Uuid,
    state: RunState,
) -> Result<(), Box<dyn std::error::Error>> {
    wait_until(&format!("run {run_id} reached {state}"), || {
        Storage::open(database_path)
            .and_then(|storage| storage.get_run(run_id))
            .is_ok_and(|run| run.run_state == state)
    })
}

fn wait_until(
    description: &str,
    condition: impl Fn() -> bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if condition() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for {description}").into())
}
