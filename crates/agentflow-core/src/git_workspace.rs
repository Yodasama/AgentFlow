use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Output},
    sync::Mutex,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    domain::{ArtifactRecord, CheckpointRecord, ProjectRecord, WorkspaceRecord},
    storage::{Storage, StorageError},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitPreflight {
    pub root_path: PathBuf,
    pub git_common_directory: PathBuf,
    pub base_sha: String,
    pub source_has_changes: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FailureSnapshot {
    pub workspace_path: PathBuf,
    pub status_porcelain: String,
    pub diff: String,
    pub untracked_files: Vec<String>,
}

#[derive(Debug, Error)]
pub enum GitWorkspaceError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("Git I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Git command failed ({operation}): {message}")]
    Git { operation: String, message: String },
    #[error("Git output for {0} was not valid UTF-8")]
    InvalidUtf8(&'static str),
    #[error("invalid controlled path: {0}")]
    InvalidControlledPath(String),
    #[error("controlled path is a symbolic link: {0}")]
    SymbolicLink(String),
    #[error("controlled path resolves outside the workspace: {0}")]
    PathEscapesWorkspace(String),
    #[error("workspace has pre-existing staged changes")]
    PreexistingStagedChanges,
    #[error("Git staged a path outside the controlled file list: {0}")]
    UnexpectedStagedPath(String),
    #[error("workspace path is missing: {0}")]
    MissingWorkspace(String),
}

pub struct GitWorkspaceService {
    data_directory: PathBuf,
    repository_operation: Mutex<()>,
}

impl GitWorkspaceService {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            repository_operation: Mutex::new(()),
        }
    }

    pub fn register_project(
        &self,
        storage: &mut Storage,
        selected_path: &Path,
    ) -> Result<(ProjectRecord, GitPreflight), GitWorkspaceError> {
        let preflight = self.preflight(selected_path)?;
        let project = storage.register_project(
            path_text(&preflight.root_path)?,
            path_text(&preflight.git_common_directory)?,
        )?;
        Ok((project, preflight))
    }

    pub fn preflight(&self, selected_path: &Path) -> Result<GitPreflight, GitWorkspaceError> {
        let selected_path = selected_path.canonicalize()?;
        let root = git_text(
            &selected_path,
            &["rev-parse", "--show-toplevel"],
            "resolve repository root",
        )?;
        let root_path = PathBuf::from(root.trim()).canonicalize()?;
        let common = git_text(
            &root_path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            "resolve Git common directory",
        )?;
        let git_common_directory = PathBuf::from(common.trim()).canonicalize()?;
        let base_sha = git_text(
            &root_path,
            &["rev-parse", "HEAD^{commit}"],
            "resolve base commit",
        )?
        .trim()
        .to_owned();
        let status = git_output(
            &root_path,
            &["status", "--porcelain=v1", "--untracked-files=all"],
            "inspect source status",
        )?;
        Ok(GitPreflight {
            root_path,
            git_common_directory,
            base_sha,
            source_has_changes: !status.stdout.is_empty(),
        })
    }

    pub fn create_development_workspace(
        &self,
        storage: &mut Storage,
        project: &ProjectRecord,
        run_id: Uuid,
        base_sha: &str,
        generation: u32,
        source_checkpoint_id: Option<Uuid>,
    ) -> Result<WorkspaceRecord, GitWorkspaceError> {
        if let Some(existing) = storage.workspace(run_id, generation, "development")? {
            return Ok(existing);
        }
        let branch_name = if generation == 1 {
            format!("agentflow/{run_id}")
        } else {
            format!("agentflow/{run_id}-generation-{generation}")
        };
        let path = self
            .data_directory
            .join("workspaces")
            .join(run_id.to_string())
            .join(format!("generation-{generation}"));
        let source = PathBuf::from(&project.root_path);
        self.create_worktree(&source, &path, Some(&branch_name), base_sha)?;
        let workspace = WorkspaceRecord {
            workspace_id: Uuid::new_v4(),
            run_id,
            project_id: project.project_id,
            generation,
            kind: "development".to_owned(),
            base_sha: base_sha.to_owned(),
            branch_name: Some(branch_name),
            path: path_text(&path)?.to_owned(),
            source_checkpoint_id,
            created_at: now(),
        };
        storage.insert_workspace(&workspace)?;
        Ok(workspace)
    }

    pub fn create_review_workspace(
        &self,
        storage: &mut Storage,
        development: &WorkspaceRecord,
        checkpoint: &CheckpointRecord,
    ) -> Result<WorkspaceRecord, GitWorkspaceError> {
        if let Some(existing) = storage.review_workspace(
            development.run_id,
            development.generation,
            checkpoint.checkpoint_id,
        )? {
            return Ok(existing);
        }
        let path = self
            .data_directory
            .join("reviews")
            .join(checkpoint.checkpoint_id.to_string());
        self.create_worktree(
            Path::new(&development.path),
            &path,
            None,
            &checkpoint.commit_sha,
        )?;
        let review = WorkspaceRecord {
            workspace_id: Uuid::new_v4(),
            run_id: development.run_id,
            project_id: development.project_id,
            generation: development.generation,
            kind: "review".to_owned(),
            base_sha: checkpoint.commit_sha.clone(),
            branch_name: None,
            path: path_text(&path)?.to_owned(),
            source_checkpoint_id: Some(checkpoint.checkpoint_id),
            created_at: now(),
        };
        storage.insert_workspace(&review)?;
        Ok(review)
    }

    pub fn create_next_generation(
        &self,
        storage: &mut Storage,
        project: &ProjectRecord,
        previous: &WorkspaceRecord,
        checkpoint: &CheckpointRecord,
    ) -> Result<WorkspaceRecord, GitWorkspaceError> {
        self.create_development_workspace(
            storage,
            project,
            previous.run_id,
            &checkpoint.commit_sha,
            previous.generation + 1,
            Some(checkpoint.checkpoint_id),
        )
    }

    pub fn create_checkpoint(
        &self,
        storage: &mut Storage,
        workspace: &WorkspaceRecord,
        attempt_id: Uuid,
        controlled_files: &[String],
    ) -> Result<CheckpointRecord, GitWorkspaceError> {
        let marker = format!("AgentFlow-Attempt: {attempt_id}");
        if let Some(existing) = storage.checkpoint_by_marker(&marker)? {
            return Ok(existing);
        }
        let workspace_path = PathBuf::from(&workspace.path);
        if !workspace_path.is_dir() {
            return Err(GitWorkspaceError::MissingWorkspace(workspace.path.clone()));
        }
        let workspace_root = workspace_path.canonicalize()?;
        let controlled = validate_controlled_files(&workspace_root, controlled_files)?;
        let _guard = self.repository_operation.lock().unwrap();

        if head_contains_marker(&workspace_root, &marker)? {
            let checkpoint = checkpoint_from_existing_commit(
                workspace,
                attempt_id,
                controlled.iter().cloned().collect(),
                marker,
            )?;
            index_artifacts(storage, &workspace_root, &checkpoint)?;
            return storage.insert_checkpoint(&checkpoint).map_err(Into::into);
        }

        ensure_no_staged_changes(&workspace_root)?;
        let changed = changed_files(&workspace_root)?;
        let selected = changed
            .intersection(&controlled)
            .cloned()
            .collect::<Vec<_>>();
        let base_sha = git_text(
            &workspace_root,
            &["rev-parse", "HEAD^{commit}"],
            "resolve checkpoint base",
        )?
        .trim()
        .to_owned();
        let (commit_sha, no_changes) = if selected.is_empty() {
            (base_sha.clone(), true)
        } else {
            git_paths(
                &workspace_root,
                &["add", "--"],
                &selected,
                "stage controlled files",
            )?;
            let staged = nul_paths(
                &git_output(
                    &workspace_root,
                    &["diff", "--cached", "--name-only", "-z"],
                    "inspect staged files",
                )?
                .stdout,
            )?;
            if let Some(unexpected) = staged.iter().find(|path| !controlled.contains(*path)) {
                return Err(GitWorkspaceError::UnexpectedStagedPath(unexpected.clone()));
            }
            let message = format!("AgentFlow checkpoint {attempt_id}\n\n{marker}");
            git_with_owned_arguments(
                &workspace_root,
                vec![
                    "-c".into(),
                    "core.hooksPath=/dev/null".into(),
                    "-c".into(),
                    "commit.gpgSign=false".into(),
                    "-c".into(),
                    "user.name=AgentFlow".into(),
                    "-c".into(),
                    "user.email=agentflow@localhost".into(),
                    "commit".into(),
                    "--no-verify".into(),
                    "--no-gpg-sign".into(),
                    "-m".into(),
                    message,
                ],
                "create checkpoint commit",
            )?;
            (
                git_text(
                    &workspace_root,
                    &["rev-parse", "HEAD^{commit}"],
                    "resolve checkpoint commit",
                )?
                .trim()
                .to_owned(),
                false,
            )
        };
        let checkpoint = CheckpointRecord {
            checkpoint_id: Uuid::new_v4(),
            workspace_id: workspace.workspace_id,
            run_id: workspace.run_id,
            attempt_id,
            base_sha,
            commit_sha,
            controlled_files: controlled.into_iter().collect(),
            marker,
            no_changes,
            created_at: now(),
        };
        index_artifacts(storage, &workspace_root, &checkpoint)?;
        storage.insert_checkpoint(&checkpoint).map_err(Into::into)
    }

    pub fn failure_snapshot(
        &self,
        workspace: &WorkspaceRecord,
    ) -> Result<FailureSnapshot, GitWorkspaceError> {
        let path = PathBuf::from(&workspace.path);
        Ok(FailureSnapshot {
            workspace_path: path.clone(),
            status_porcelain: git_text(
                &path,
                &["status", "--porcelain=v1", "--untracked-files=all"],
                "capture failure status",
            )?,
            diff: git_text(
                &path,
                &["diff", "--no-ext-diff", "--no-color", "HEAD", "--"],
                "capture failure diff",
            )?,
            untracked_files: nul_paths(
                &git_output(
                    &path,
                    &["ls-files", "--others", "--exclude-standard", "-z"],
                    "capture untracked files",
                )?
                .stdout,
            )?,
        })
    }

    fn create_worktree(
        &self,
        repository: &Path,
        destination: &Path,
        branch_name: Option<&str>,
        commit: &str,
    ) -> Result<(), GitWorkspaceError> {
        let _guard = self.repository_operation.lock().unwrap();
        if destination.join(".git").exists() {
            return Ok(());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let destination_text = path_text(destination)?.to_owned();
        match branch_name {
            Some(branch) if branch_exists(repository, branch)? => {
                git_with_owned_arguments(
                    repository,
                    vec![
                        "worktree".into(),
                        "add".into(),
                        destination_text,
                        branch.into(),
                    ],
                    "attach existing worktree branch",
                )?;
            }
            Some(branch) => {
                git_with_owned_arguments(
                    repository,
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "-b".into(),
                        branch.into(),
                        destination_text,
                        commit.into(),
                    ],
                    "create development worktree",
                )?;
            }
            None => {
                git_with_owned_arguments(
                    repository,
                    vec![
                        "worktree".into(),
                        "add".into(),
                        "--detach".into(),
                        destination_text,
                        commit.into(),
                    ],
                    "create review worktree",
                )?;
            }
        }
        Ok(())
    }
}

fn validate_controlled_files(
    workspace_root: &Path,
    controlled_files: &[String],
) -> Result<BTreeSet<String>, GitWorkspaceError> {
    let mut result = BTreeSet::new();
    for value in controlled_files {
        let relative = Path::new(value);
        if value.is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err(GitWorkspaceError::InvalidControlledPath(value.clone()));
        }
        let normalized = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/");
        if normalized.is_empty() {
            return Err(GitWorkspaceError::InvalidControlledPath(value.clone()));
        }
        let candidate = workspace_root.join(&normalized);
        if let Ok(metadata) = fs::symlink_metadata(&candidate) {
            if metadata.file_type().is_symlink() {
                return Err(GitWorkspaceError::SymbolicLink(normalized));
            }
            if !candidate.canonicalize()?.starts_with(workspace_root) {
                return Err(GitWorkspaceError::PathEscapesWorkspace(normalized));
            }
        }
        result.insert(normalized);
    }
    Ok(result)
}

fn changed_files(repository: &Path) -> Result<BTreeSet<String>, GitWorkspaceError> {
    let tracked = git_output(
        repository,
        &["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"],
        "list tracked changes",
    )?;
    let untracked = git_output(
        repository,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        "list untracked changes",
    )?;
    let mut paths = nul_paths(&tracked.stdout)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    paths.extend(nul_paths(&untracked.stdout)?);
    Ok(paths)
}

fn ensure_no_staged_changes(repository: &Path) -> Result<(), GitWorkspaceError> {
    let status = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["diff", "--cached", "--quiet", "--exit-code"])
        .status()?;
    match status.code() {
        Some(0) => Ok(()),
        Some(1) => Err(GitWorkspaceError::PreexistingStagedChanges),
        _ => Err(GitWorkspaceError::Git {
            operation: "inspect staged changes".to_owned(),
            message: format!("git exited with {status}"),
        }),
    }
}

fn head_contains_marker(repository: &Path, marker: &str) -> Result<bool, GitWorkspaceError> {
    let message = git_text(
        repository,
        &["log", "-1", "--format=%B"],
        "inspect checkpoint marker",
    )?;
    Ok(message.lines().any(|line| line == marker))
}

fn checkpoint_from_existing_commit(
    workspace: &WorkspaceRecord,
    attempt_id: Uuid,
    controlled_files: Vec<String>,
    marker: String,
) -> Result<CheckpointRecord, GitWorkspaceError> {
    let path = Path::new(&workspace.path);
    let commit_sha = git_text(
        path,
        &["rev-parse", "HEAD^{commit}"],
        "recover checkpoint commit",
    )?
    .trim()
    .to_owned();
    let base_sha = git_text(path, &["rev-parse", "HEAD^1"], "recover checkpoint parent")?
        .trim()
        .to_owned();
    Ok(CheckpointRecord {
        checkpoint_id: Uuid::new_v4(),
        workspace_id: workspace.workspace_id,
        run_id: workspace.run_id,
        attempt_id,
        base_sha,
        commit_sha,
        controlled_files,
        marker,
        no_changes: false,
        created_at: now(),
    })
}

fn index_artifacts(
    storage: &mut Storage,
    workspace_root: &Path,
    checkpoint: &CheckpointRecord,
) -> Result<(), GitWorkspaceError> {
    let mut artifacts = Vec::new();
    for relative_path in &checkpoint.controlled_files {
        let path = workspace_root.join(relative_path);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let hash = git_text(
            workspace_root,
            &["hash-object", "--", relative_path],
            "hash artifact",
        )?
        .trim()
        .to_owned();
        artifacts.push(ArtifactRecord {
            artifact_id: Uuid::new_v4(),
            run_id: checkpoint.run_id,
            attempt_id: checkpoint.attempt_id,
            artifact_type: "controlled_file".to_owned(),
            relative_path: relative_path.clone(),
            byte_size: metadata.len(),
            content_hash: format!("git-blob:{hash}"),
            created_at: now(),
        });
    }
    storage.replace_artifacts(checkpoint.run_id, checkpoint.attempt_id, &artifacts)?;
    Ok(())
}

fn branch_exists(repository: &Path, branch: &str) -> Result<bool, GitWorkspaceError> {
    let status = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ])
        .status()?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(GitWorkspaceError::Git {
            operation: "inspect branch".to_owned(),
            message: format!("git exited with {status}"),
        }),
    }
}

fn git_paths(
    repository: &Path,
    prefix: &[&str],
    paths: &[String],
    operation: &str,
) -> Result<Output, GitWorkspaceError> {
    let mut arguments = prefix
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    arguments.extend(paths.iter().cloned());
    git_with_owned_arguments(repository, arguments, operation)
}

fn git_text(
    repository: &Path,
    arguments: &[&str],
    operation: &str,
) -> Result<String, GitWorkspaceError> {
    let output = git_output(repository, arguments, operation)?;
    String::from_utf8(output.stdout).map_err(|_| GitWorkspaceError::InvalidUtf8("stdout"))
}

fn git_output(
    repository: &Path,
    arguments: &[&str],
    operation: &str,
) -> Result<Output, GitWorkspaceError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()?;
    checked_output(output, operation)
}

fn git_with_owned_arguments(
    repository: &Path,
    arguments: Vec<String>,
    operation: &str,
) -> Result<Output, GitWorkspaceError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()?;
    checked_output(output, operation)
}

fn checked_output(output: Output, operation: &str) -> Result<Output, GitWorkspaceError> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(GitWorkspaceError::Git {
            operation: operation.to_owned(),
            message: output_message(&output.status, &output.stderr),
        })
    }
}

fn output_message(status: &ExitStatus, stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr).trim().to_owned();
    if message.is_empty() {
        format!("git exited with {status}")
    } else {
        message
    }
}

fn nul_paths(bytes: &[u8]) -> Result<Vec<String>, GitWorkspaceError> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| {
            String::from_utf8(value.to_vec()).map_err(|_| GitWorkspaceError::InvalidUtf8("path"))
        })
        .collect()
}

fn path_text(path: &Path) -> Result<&str, GitWorkspaceError> {
    path.to_str()
        .ok_or(GitWorkspaceError::InvalidUtf8("filesystem path"))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CreateMockTaskRequest, MockOutcome};
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn worktrees_and_checkpoints_are_isolated_idempotent_and_recoverable() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source repository");
        let data = fixture.path().join("application data");
        fs::create_dir_all(&source).unwrap();
        git_ok(&source, &["init", "-b", "main"]);
        git_ok(&source, &["config", "user.name", "Fixture"]);
        git_ok(&source, &["config", "user.email", "fixture@example.test"]);
        fs::write(source.join("shared.txt"), "base\n").unwrap();
        fs::write(source.join("path with spaces.txt"), "initial\n").unwrap();
        git_ok(
            &source,
            &["add", "--", "shared.txt", "path with spaces.txt"],
        );
        git_ok(&source, &["commit", "-m", "initial"]);
        let base_sha = git_text(&source, &["rev-parse", "HEAD"], "base")
            .unwrap()
            .trim()
            .to_owned();

        let hook = source.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 91\n").unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        git_ok(&source, &["config", "commit.gpgSign", "true"]);
        fs::write(source.join("source-only-dirty.txt"), "do not touch\n").unwrap();

        fs::create_dir_all(&data).unwrap();
        let mut storage = Storage::open(&data.join("agentflow.sqlite")).unwrap();
        let first = completed_run(&mut storage, "first run");
        let second = completed_run(&mut storage, "second run");
        let third = completed_run(&mut storage, "no-change run");
        let fourth = completed_run(&mut storage, "checkpoint recovery run");
        let service = GitWorkspaceService::new(data.clone());
        let (project, preflight) = service.register_project(&mut storage, &source).unwrap();
        assert_eq!(preflight.base_sha, base_sha);
        assert!(preflight.source_has_changes);

        let first_workspace = service
            .create_development_workspace(
                &mut storage,
                &project,
                first.0,
                &preflight.base_sha,
                1,
                None,
            )
            .unwrap();
        let second_workspace = service
            .create_development_workspace(
                &mut storage,
                &project,
                second.0,
                &preflight.base_sha,
                1,
                None,
            )
            .unwrap();
        fs::write(
            Path::new(&first_workspace.path).join("shared.txt"),
            "first\n",
        )
        .unwrap();
        fs::write(
            Path::new(&first_workspace.path).join("new file.txt"),
            "artifact\n",
        )
        .unwrap();
        fs::write(
            Path::new(&second_workspace.path).join("shared.txt"),
            "second\n",
        )
        .unwrap();

        let first_checkpoint = service
            .create_checkpoint(
                &mut storage,
                &first_workspace,
                first.1,
                &["shared.txt".into(), "new file.txt".into()],
            )
            .unwrap();
        let second_checkpoint = service
            .create_checkpoint(
                &mut storage,
                &second_workspace,
                second.1,
                &["shared.txt".into()],
            )
            .unwrap();
        assert_ne!(first_checkpoint.commit_sha, second_checkpoint.commit_sha);
        assert_eq!(
            fs::read_to_string(source.join("shared.txt")).unwrap(),
            "base\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("source-only-dirty.txt")).unwrap(),
            "do not touch\n"
        );
        assert_eq!(
            git_text(&source, &["rev-parse", "HEAD"], "source head")
                .unwrap()
                .trim(),
            base_sha
        );
        let repeated = service
            .create_checkpoint(
                &mut storage,
                &first_workspace,
                first.1,
                &["shared.txt".into(), "new file.txt".into()],
            )
            .unwrap();
        assert_eq!(repeated.checkpoint_id, first_checkpoint.checkpoint_id);
        assert_eq!(repeated.commit_sha, first_checkpoint.commit_sha);
        assert_eq!(storage.artifacts_for_run(first.0).unwrap().len(), 2);

        let review = service
            .create_review_workspace(&mut storage, &first_workspace, &first_checkpoint)
            .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&review.path).join("shared.txt")).unwrap(),
            "first\n"
        );
        // A second recorded candidate in the same development generation must
        // get a separate review checkout; the first review remains immutable.
        let mut later_candidate = first_checkpoint.clone();
        later_candidate.checkpoint_id = Uuid::new_v4();
        later_candidate.commit_sha = second_checkpoint.commit_sha.clone();
        later_candidate.marker =
            format!("review-candidate-fixture:{}", later_candidate.checkpoint_id);
        storage.insert_checkpoint(&later_candidate).unwrap();
        let later_review = service
            .create_review_workspace(&mut storage, &first_workspace, &later_candidate)
            .unwrap();
        assert_ne!(review.path, later_review.path);
        assert_eq!(
            fs::read_to_string(Path::new(&later_review.path).join("shared.txt")).unwrap(),
            "second\n"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&review.path).join("shared.txt")).unwrap(),
            "first\n"
        );
        assert_eq!(
            service
                .create_review_workspace(&mut storage, &first_workspace, &later_candidate)
                .unwrap()
                .workspace_id,
            later_review.workspace_id
        );
        let next = service
            .create_next_generation(&mut storage, &project, &first_workspace, &first_checkpoint)
            .unwrap();
        assert!(Path::new(&first_workspace.path).exists());
        assert!(Path::new(&next.path).exists());
        assert_ne!(first_workspace.path, next.path);

        let third_workspace = service
            .create_development_workspace(
                &mut storage,
                &project,
                third.0,
                &preflight.base_sha,
                1,
                None,
            )
            .unwrap();
        let no_change = service
            .create_checkpoint(
                &mut storage,
                &third_workspace,
                third.1,
                &["shared.txt".into()],
            )
            .unwrap();
        assert!(no_change.no_changes);
        assert_eq!(no_change.base_sha, no_change.commit_sha);

        let fourth_workspace = service
            .create_development_workspace(
                &mut storage,
                &project,
                fourth.0,
                &preflight.base_sha,
                1,
                None,
            )
            .unwrap();
        let fourth_path = Path::new(&fourth_workspace.path);
        fs::write(fourth_path.join("shared.txt"), "recovered commit\n").unwrap();
        git_ok(fourth_path, &["add", "--", "shared.txt"]);
        let recovery_marker = format!("AgentFlow-Attempt: {}", fourth.1);
        git_with_owned_arguments(
            fourth_path,
            vec![
                "-c".into(),
                "core.hooksPath=/dev/null".into(),
                "-c".into(),
                "commit.gpgSign=false".into(),
                "-c".into(),
                "user.name=AgentFlow".into(),
                "-c".into(),
                "user.email=agentflow@localhost".into(),
                "commit".into(),
                "--no-verify".into(),
                "--no-gpg-sign".into(),
                "-m".into(),
                format!("AgentFlow checkpoint {}\n\n{recovery_marker}", fourth.1),
            ],
            "simulate commit before database record",
        )
        .unwrap();
        let committed_before_recovery = git_text(
            fourth_path,
            &["rev-parse", "HEAD"],
            "commit before recovery",
        )
        .unwrap();
        let recovered = service
            .create_checkpoint(
                &mut storage,
                &fourth_workspace,
                fourth.1,
                &["shared.txt".into()],
            )
            .unwrap();
        assert_eq!(recovered.commit_sha, committed_before_recovery.trim());
        assert_eq!(
            git_text(fourth_path, &["rev-parse", "HEAD"], "head after recovery")
                .unwrap()
                .trim(),
            committed_before_recovery.trim()
        );

        fs::write(
            Path::new(&second_workspace.path).join("untracked failure.txt"),
            "failure evidence\n",
        )
        .unwrap();
        let snapshot = service.failure_snapshot(&second_workspace).unwrap();
        assert!(
            snapshot
                .untracked_files
                .contains(&"untracked failure.txt".into())
        );
        assert!(snapshot.status_porcelain.contains("untracked failure.txt"));
    }

    #[test]
    fn controlled_paths_reject_traversal_and_external_symlinks() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = fixture.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        assert!(matches!(
            validate_controlled_files(&workspace, &["../outside".into()]),
            Err(GitWorkspaceError::InvalidControlledPath(_))
        ));
        symlink("/tmp", workspace.join("external-link")).unwrap();
        assert!(matches!(
            validate_controlled_files(&workspace, &["external-link".into()]),
            Err(GitWorkspaceError::SymbolicLink(_))
        ));
    }

    fn completed_run(storage: &mut Storage, title: &str) -> (Uuid, Uuid) {
        let detail = storage
            .create_and_execute_mock_task(CreateMockTaskRequest {
                title: title.to_owned(),
                description: "Git fixture".to_owned(),
                acceptance_criteria: vec!["checkpoint is traceable".to_owned()],
                outcome: MockOutcome::Succeeded,
                account_id: None,
                delay_milliseconds: None,
            })
            .unwrap();
        (detail.run_id, detail.attempt_id.unwrap())
    }

    fn git_ok(repository: &Path, arguments: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            arguments,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
