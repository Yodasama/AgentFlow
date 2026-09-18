use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use agentflow_core::{
    development_flow::{
        DevelopmentPhase, FindingSeverity, ReviewFinding, ReviewReport, ReviewVerdict, TestReport,
        TestStatus, standard_development_workflow,
    },
    development_runtime::{
        MockDevelopmentScenario, advance_mock_development_runs, create_mock_development_run,
    },
    domain::{AttemptState, RunState},
    execution::{SchedulerConfig, SchedulerHandle},
    git_workspace::GitWorkspaceService,
    storage::Storage,
    workflow_run::{
        CreateDevelopmentRunRequest, DevelopmentRunCoordinator, NodeLaunchSpec,
        approved_human_input,
    },
};
use serde_json::{Value, json};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if args.first().and_then(|arg| arg.to_str()) == Some("--host") {
        let root = PathBuf::from(&args[1]);
        let storage = Arc::new(Mutex::new(Storage::open(&root.join("agentflow.sqlite"))?));
        let _scheduler = SchedulerHandle::start(
            storage,
            config(&root, &PathBuf::from(&args[2]), &PathBuf::from(&args[3])),
        )?;
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
    if args.len() != 2 {
        return Err("usage: verify_workflow /absolute/runner /absolute/mock-cli".into());
    }
    let runner = PathBuf::from(&args[0]).canonicalize()?;
    let mock = PathBuf::from(&args[1]).canonicalize()?;
    let directory = tempfile::tempdir()?;
    let outcome = verify(directory.path(), &runner, &mock);
    if outcome.is_err() {
        eprintln!("workflow fixture retained: {}", directory.keep().display());
    }
    outcome
}

fn config(root: &Path, runner: &Path, mock: &Path) -> SchedulerConfig {
    SchedulerConfig {
        data_directory: root.into(),
        runner_path: runner.into(),
        mock_cli_path: mock.into(),
        global_limit: 3,
        timeout_seconds: 20,
        cancellation_grace_seconds: 1,
    }
}

fn git(path: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("/usr/bin/git")
        .current_dir(path)
        .args(args)
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}

fn spec(mock: &Path, workspace: &Path, args: Vec<String>) -> NodeLaunchSpec {
    NodeLaunchSpec {
        executable_path: mock.into(),
        arguments: args,
        working_directory: workspace.into(),
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        timeout_seconds: 20,
        cancellation_grace_seconds: 1,
    }
}

fn await_result(storage: &Arc<Mutex<Storage>>, run: Uuid) -> Result<()> {
    let start = Instant::now();
    loop {
        let detail = storage.lock().unwrap().get_run(run)?;
        match detail.attempt_state {
            Some(AttemptState::Succeeded) => {
                assert_eq!(detail.run_state, RunState::Running);
                return Ok(());
            }
            Some(AttemptState::Failed | AttemptState::Interrupted | AttemptState::Cancelled) => {
                return Err(format!("unexpected attempt state: {detail:?}").into());
            }
            _ => {}
        }
        if start.elapsed() > Duration::from_secs(15) {
            return Err("workflow result timeout".into());
        }
        thread::sleep(Duration::from_millis(40));
    }
}

fn execute(
    storage: &Arc<Mutex<Storage>>,
    root: &Path,
    run: Uuid,
    launch: &NodeLaunchSpec,
) -> Result<Uuid> {
    let prepared = storage
        .lock()
        .unwrap()
        .prepare_development_attempt(run, launch, root, 3)?
        .ok_or("node was not prepared")?;
    assert!(
        storage
            .lock()
            .unwrap()
            .prepare_development_attempt(run, launch, root, 3)?
            .is_none()
    );
    await_result(storage, run)?;
    Ok(prepared.attempt_id)
}

fn report_spec(mock: &Path, workspace: &Path, result: Value) -> NodeLaunchSpec {
    spec(
        mock,
        workspace,
        vec!["workflow-result".into(), result.to_string()],
    )
}

fn verify(root: &Path, runner: &Path, mock: &Path) -> Result<()> {
    let source = root.join("source");
    fs::create_dir(&source)?;
    git(&source, &["init", "-q"])?;
    git(
        &source,
        &[
            "-c",
            "user.name=AgentFlow Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--allow-empty",
            "-qm",
            "base",
        ],
    )?;
    let original_head = git(&source, &["rev-parse", "HEAD"])?;
    let database = root.join("agentflow.sqlite");
    let mut storage = Storage::open(&database)?;
    let mut definition = standard_development_workflow();
    definition
        .role_bindings
        .insert("analyst".into(), "mock:custom-analyst".into());
    let version = storage.publish_workflow(&definition)?;
    let shared = Arc::new(Mutex::new(storage));
    let coordinator = DevelopmentRunCoordinator::new(shared.clone());
    let run = coordinator
        .create_run(
            CreateDevelopmentRunRequest {
                title: "Real runner workflow fixture".into(),
                description: "Mock agents, real processes and Git checkpoints".into(),
                acceptance_criteria: vec!["retry and approval survive persistence".into()],
            },
            &version,
        )?
        .run_id;
    let git_service = GitWorkspaceService::new(root.into());
    let workspace = {
        let mut storage = shared.lock().unwrap();
        let (project, preflight) = git_service.register_project(&mut storage, &source)?;
        git_service.create_development_workspace(
            &mut storage,
            &project,
            run,
            &preflight.base_sha,
            1,
            None,
        )?
    };
    let workdir = PathBuf::from(&workspace.path);
    let analysis = report_spec(mock, &workdir, json!({"summary":"mock analysis evidence"}));
    let prepared = shared
        .lock()
        .unwrap()
        .prepare_development_attempt(run, &analysis, root, 3)?
        .unwrap();
    assert_eq!(prepared.account_id, "mock:custom-analyst");
    drop(coordinator);
    let mut host = Command::new(env::current_exe()?)
        .arg("--host")
        .arg(root)
        .arg(runner)
        .arg(mock)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    let observed = await_result(&shared, run);
    host.kill()?;
    host.wait()?;
    observed?;
    drop(shared);

    let shared = Arc::new(Mutex::new(Storage::open(&database)?));
    let coordinator = DevelopmentRunCoordinator::new(shared.clone());
    let scheduler = SchedulerHandle::start(shared.clone(), config(root, runner, mock))?;
    assert_eq!(
        coordinator.load(run)?.flow.phase,
        DevelopmentPhase::Analysis
    );
    assert!(
        coordinator
            .complete_analysis(run, json!("tampered"))
            .is_err()
    );
    coordinator.complete_analysis(run, json!("mock analysis evidence"))?;
    assert!(
        coordinator
            .complete_analysis(run, json!("mock analysis evidence"))
            .is_err()
    );

    let mut final_candidate = String::new();
    for iteration in 1..=3 {
        let launch = spec(
            mock,
            &workdir,
            vec!["workflow-development".into(), iteration.to_string()],
        );
        let attempt = execute(&shared, root, run, &launch)?;
        assert!(
            coordinator
                .complete_development(run, "unrecorded-commit".into())
                .is_err()
        );
        let checkpoint = git_service.create_checkpoint(
            &mut shared.lock().unwrap(),
            &workspace,
            attempt,
            &["agentflow-fixture.txt".into()],
        )?;
        let candidate = checkpoint.commit_sha;
        coordinator.complete_development(run, candidate.clone())?;
        let tests = TestReport {
            schema_version: 1,
            tested_commit: candidate.clone(),
            status: if iteration == 1 {
                TestStatus::Failed
            } else {
                TestStatus::Passed
            },
            summary: format!("mock tests iteration {iteration}"),
            failures: if iteration == 1 {
                vec!["mock failing test".into()]
            } else {
                vec![]
            },
        };
        execute(
            &shared,
            root,
            run,
            &report_spec(mock, &workdir, json!({"report":tests})),
        )?;
        coordinator.record_tests(run, tests)?;
        if iteration == 1 {
            assert_eq!(
                coordinator.load(run)?.flow.phase,
                DevelopmentPhase::Development
            );
            continue;
        }
        let review = ReviewReport {
            schema_version: 1,
            reviewed_commit: candidate.clone(),
            verdict: if iteration == 2 {
                ReviewVerdict::ChangesRequested
            } else {
                ReviewVerdict::Approved
            },
            summary: format!("mock review iteration {iteration}"),
            findings: if iteration == 2 {
                vec![ReviewFinding {
                    severity: FindingSeverity::Blocking,
                    file: "agentflow-fixture.txt".into(),
                    line: 1,
                    message: "mock requested revision".into(),
                }]
            } else {
                vec![]
            },
        };
        execute(
            &shared,
            root,
            run,
            &report_spec(mock, &workdir, json!({"report":review})),
        )?;
        coordinator.record_review(run, review)?;
        final_candidate = candidate;
    }
    assert_eq!(
        coordinator.load(run)?.flow.phase,
        DevelopmentPhase::HumanApproval
    );
    assert!(
        coordinator
            .record_approval(
                run,
                approved_human_input("stale".into(), version.digest.clone(), "approve".into())
            )
            .is_err()
    );
    coordinator.record_approval(
        run,
        approved_human_input(
            final_candidate.clone(),
            version.digest,
            "fixture human approval".into(),
        ),
    )?;
    assert_eq!(
        shared.lock().unwrap().get_run(run)?.run_state,
        RunState::Succeeded
    );
    assert_eq!(shared.lock().unwrap().list_runs()?.len(), 1);
    assert_eq!(
        coordinator.load(run)?.flow.completed_commit,
        Some(final_candidate)
    );
    assert_eq!(git(&source, &["rev-parse", "HEAD"])?, original_head);
    assert!(git(&source, &["status", "--porcelain"])?.is_empty());
    if let Some(error) = scheduler.last_error() {
        return Err(error.into());
    }
    drop(scheduler);
    verify_automatic(&root.join("automatic"), runner, mock, false)?;
    verify_automatic(&root.join("automatic-cancel"), runner, mock, true)?;
    println!(
        "workflow fixture passed: persisted runner result after host SIGKILL, test retry, review retry, three Git checkpoints, SHA-bound approval"
    );
    Ok(())
}

fn verify_automatic(
    root: &Path,
    runner: &Path,
    mock: &Path,
    cancel_at_approval: bool,
) -> Result<()> {
    fs::create_dir_all(root)?;
    let source = root.join("source");
    fs::create_dir(&source)?;
    git(&source, &["init", "-q"])?;
    git(
        &source,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--allow-empty",
            "-qm",
            "base",
        ],
    )?;
    let path = root.join("agentflow.sqlite");
    let shared = Arc::new(Mutex::new(Storage::open(&path)?));
    let coordinator = DevelopmentRunCoordinator::new(shared.clone());
    let initial = create_mock_development_run(
        &shared,
        root,
        &source,
        CreateDevelopmentRunRequest {
            title: "Automatic mock workflow".into(),
            description: "Scheduler drives every node".into(),
            acceptance_criteria: vec!["Independent reviews for both candidates".into()],
        },
        if cancel_at_approval {
            MockDevelopmentScenario::Pass
        } else {
            MockDevelopmentScenario::TestThenReviewRetry
        },
    )?;
    let run = initial.run_id;
    let workspace = shared
        .lock()
        .unwrap()
        .workspace(run, 1, "development")?
        .unwrap();
    let scheduler_config = config(root, runner, mock);
    advance_mock_development_runs(&shared, &scheduler_config)?;
    let initial_attempt = shared
        .lock()
        .unwrap()
        .active_attempts()?
        .pop()
        .ok_or("missing prepared analysis")?
        .attempt_id;
    drop(coordinator);
    drop(shared);
    let shared = Arc::new(Mutex::new(Storage::open(&path)?));
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .active_attempts()?
            .first()
            .unwrap()
            .attempt_id,
        initial_attempt
    );
    let coordinator = DevelopmentRunCoordinator::new(shared.clone());
    let scheduler = SchedulerHandle::start(shared.clone(), scheduler_config)?;
    let start = Instant::now();
    loop {
        let detail = shared.lock().unwrap().get_run(run)?;
        if detail.run_state == RunState::WaitingInput {
            break;
        }
        if detail.run_state.is_terminal() || detail.run_state == RunState::Interrupted {
            return Err(format!(
                "automatic workflow stopped: {detail:?}; {:?}",
                scheduler.last_error()
            )
            .into());
        }
        if start.elapsed() > Duration::from_secs(25) {
            return Err(
                format!("automatic workflow timed out: {:?}", scheduler.last_error()).into(),
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
    let snapshot = coordinator.load(run)?;
    assert_eq!(snapshot.flow.phase, DevelopmentPhase::HumanApproval);
    assert_eq!(
        snapshot.flow.iteration,
        if cancel_at_approval { 1 } else { 3 }
    );
    assert_eq!(
        snapshot.flow.test_history.len(),
        if cancel_at_approval { 1 } else { 3 }
    );
    assert_eq!(
        snapshot.flow.review_history.len(),
        if cancel_at_approval { 1 } else { 2 }
    );
    let mut review_paths = Vec::new();
    for report in &snapshot.flow.review_history {
        let storage = shared.lock().unwrap();
        let checkpoint = storage
            .checkpoint_for_candidate(run, &report.reviewed_commit)?
            .unwrap();
        let review = storage
            .review_workspace(run, workspace.generation, checkpoint.checkpoint_id)?
            .unwrap();
        assert_ne!(review.path, workspace.path);
        assert_eq!(
            git(Path::new(&review.path), &["rev-parse", "HEAD"])?,
            report.reviewed_commit
        );
        assert!(git(Path::new(&review.path), &["status", "--porcelain"])?.is_empty());
        review_paths.push(review.path);
    }
    if !cancel_at_approval {
        assert_ne!(review_paths[0], review_paths[1]);
    }
    if let Some(error) = scheduler.last_error() {
        return Err(error.into());
    }
    drop(scheduler);
    drop(coordinator);
    drop(shared);
    let shared = Arc::new(Mutex::new(Storage::open(&path)?));
    let coordinator = DevelopmentRunCoordinator::new(shared.clone());
    assert_eq!(coordinator.load(run)?, snapshot);
    let approval = approved_human_input(
        snapshot.flow.candidate_commit.unwrap(),
        initial.flow.workflow_digest,
        "approve persisted automatic run".into(),
    );
    if cancel_at_approval {
        agentflow_core::execution::request_cancellation(&shared, root, run)?;
        assert!(coordinator.record_approval(run, approval).is_err());
    } else {
        coordinator.record_approval(run, approval)?;
    }
    assert_eq!(
        shared.lock().unwrap().get_run(run)?.run_state,
        if cancel_at_approval {
            RunState::Cancelled
        } else {
            RunState::Succeeded
        }
    );
    assert!(git(&source, &["status", "--porcelain"])?.is_empty());
    println!(
        "automatic workflow passed: prepared restart, automatic retries, isolated candidate reviews, persisted approval wait"
    );
    Ok(())
}
