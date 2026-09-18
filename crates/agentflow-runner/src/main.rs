use std::{
    env,
    fs::{self, File, OpenOptions},
    io,
    process::{Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use agentflow_core::protocol::{
    CancellationRequest, LaunchManifest, RUNNER_PROTOCOL_VERSION, RunnerHeartbeat, RunnerIdentity,
    RunnerResult, TerminationReason, read_json, write_json_atomically,
};
use chrono::Utc;
use fs2::FileExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};

fn main() {
    if let Err(error) = run() {
        eprintln!("agentflow-runner: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let launch_path = parse_launch_path()?;
    let manifest: LaunchManifest = read_json(&launch_path)?;
    manifest.validate()?;

    let lock_path = launch_path
        .parent()
        .ok_or("launch file has no parent")?
        .join("runner.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    lock.try_lock_exclusive()
        .map_err(|error| format!("attempt runner is already active: {error}"))?;

    execute(&manifest)
}

fn parse_launch_path() -> Result<std::path::PathBuf, &'static str> {
    let mut arguments = env::args_os();
    let _program = arguments.next();
    match (arguments.next(), arguments.next(), arguments.next()) {
        (Some(flag), Some(path), None) if flag == "--launch" => {
            let path = std::path::PathBuf::from(path);
            path.is_absolute()
                .then_some(path)
                .ok_or("launch path must be absolute")
        }
        _ => Err("usage: agentflow-runner --launch /absolute/path/to/launch.json"),
    }
}

fn execute(manifest: &LaunchManifest) -> Result<(), Box<dyn std::error::Error>> {
    create_parent(&manifest.stdout_path)?;
    create_parent(&manifest.stderr_path)?;
    let stdout = File::create(&manifest.stdout_path)?;
    let stderr = File::create(&manifest.stderr_path)?;

    let mut command = Command::new(&manifest.executable_path);
    command
        .args(&manifest.arguments)
        .current_dir(&manifest.working_directory)
        .env_clear()
        .envs(&manifest.environment)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }

    let started_at = Utc::now();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return write_result(
                manifest,
                TerminationReason::LaunchFailed,
                None,
                None,
                Some(error.to_string()),
            )
            .map_err(Into::into);
        }
    };
    let process_group_id = i32::try_from(child.id())?;
    write_json_atomically(
        &RunnerIdentity {
            schema_version: RUNNER_PROTOCOL_VERSION,
            attempt_id: manifest.attempt_id,
            execution_token: manifest.execution_token.clone(),
            runner_pid: std::process::id(),
            child_pid: child.id(),
            child_process_group_id: process_group_id,
            started_at,
        },
        &manifest.identity_path,
    )?;

    let started = Instant::now();
    let timeout = Duration::from_secs(manifest.timeout_seconds);
    let grace = Duration::from_secs(manifest.cancellation_grace_seconds);
    let mut termination_reason = TerminationReason::Exited;
    let mut termination_requested_at: Option<Instant> = None;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }

        write_json_atomically(
            &RunnerHeartbeat {
                schema_version: RUNNER_PROTOCOL_VERSION,
                attempt_id: manifest.attempt_id,
                execution_token: manifest.execution_token.clone(),
                recorded_at: Utc::now(),
            },
            &manifest.heartbeat_path,
        )?;

        if termination_requested_at.is_none() {
            if cancellation_is_valid(manifest) {
                termination_reason = TerminationReason::Cancelled;
                termination_requested_at = Some(Instant::now());
                signal_group(process_group_id, libc::SIGTERM);
            } else if started.elapsed() >= timeout {
                termination_reason = TerminationReason::TimedOut;
                termination_requested_at = Some(Instant::now());
                signal_group(process_group_id, libc::SIGTERM);
            }
        } else if termination_requested_at.is_some_and(|instant| instant.elapsed() >= grace) {
            signal_group(process_group_id, libc::SIGKILL);
        }
        thread::sleep(Duration::from_millis(200));
    };

    write_result(
        manifest,
        termination_reason,
        exit_code(status),
        Some(started_at),
        None,
    )?;
    Ok(())
}

fn cancellation_is_valid(manifest: &LaunchManifest) -> bool {
    read_json::<CancellationRequest>(&manifest.cancellation_path).is_ok_and(|request| {
        request.schema_version == RUNNER_PROTOCOL_VERSION
            && request.attempt_id == manifest.attempt_id
            && request.execution_token == manifest.execution_token
    })
}

fn write_result(
    manifest: &LaunchManifest,
    reason: TerminationReason,
    exit_code: Option<i32>,
    started_at: Option<chrono::DateTime<Utc>>,
    error: Option<String>,
) -> io::Result<()> {
    write_json_atomically(
        &RunnerResult {
            schema_version: RUNNER_PROTOCOL_VERSION,
            attempt_id: manifest.attempt_id,
            execution_token: manifest.execution_token.clone(),
            termination_reason: reason,
            exit_code,
            started_at,
            finished_at: Utc::now(),
            error,
        },
        &manifest.result_path,
    )
}

fn create_parent(path: &std::path::Path) -> io::Result<()> {
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| io::Error::other("path has no parent"))?,
    )
}

fn signal_group(process_group_id: i32, signal: i32) {
    unsafe { libc::kill(-process_group_id, signal) };
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
}
