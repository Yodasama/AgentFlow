use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

pub const RUNNER_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchManifest {
    pub schema_version: u32,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub executable_path: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub environment: BTreeMap<String, String>,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub identity_path: PathBuf,
    pub heartbeat_path: PathBuf,
    pub cancellation_path: PathBuf,
    pub result_path: PathBuf,
    pub timeout_seconds: u64,
    pub cancellation_grace_seconds: u64,
}

impl LaunchManifest {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.schema_version != RUNNER_PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion(self.schema_version));
        }
        if self.execution_token.is_empty() {
            return Err(ProtocolError::EmptyExecutionToken);
        }
        for (field, path) in [
            ("executablePath", &self.executable_path),
            ("workingDirectory", &self.working_directory),
            ("stdoutPath", &self.stdout_path),
            ("stderrPath", &self.stderr_path),
            ("identityPath", &self.identity_path),
            ("heartbeatPath", &self.heartbeat_path),
            ("cancellationPath", &self.cancellation_path),
            ("resultPath", &self.result_path),
        ] {
            if !path.is_absolute() {
                return Err(ProtocolError::PathMustBeAbsolute(field));
            }
        }
        if self.timeout_seconds == 0 {
            return Err(ProtocolError::InvalidTimeout);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerIdentity {
    pub schema_version: u32,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub runner_pid: u32,
    pub child_pid: u32,
    pub child_process_group_id: i32,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerHeartbeat {
    pub schema_version: u32,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancellationRequest {
    pub schema_version: u32,
    pub attempt_id: Uuid,
    pub execution_token: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminationReason {
    Exited,
    Cancelled,
    TimedOut,
    LaunchFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunnerResult {
    pub schema_version: u32,
    pub attempt_id: Uuid,
    pub execution_token: String,
    pub termination_reason: TerminationReason,
    pub exit_code: Option<i32>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: DateTime<Utc>,
    pub error: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported runner protocol schema version: {0}")]
    UnsupportedVersion(u32),
    #[error("execution token must not be empty")]
    EmptyExecutionToken,
    #[error("{0} must be an absolute path")]
    PathMustBeAbsolute(&'static str),
    #[error("timeoutSeconds must be greater than zero")]
    InvalidTimeout,
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, io::Error> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

pub fn write_json_atomically<T: Serialize>(value: &T, destination: &Path) -> Result<(), io::Error> {
    let parent = destination
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent"))?;
    fs::create_dir_all(parent)?;

    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("result"),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);

    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_json_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("heartbeat.json");
        let attempt_id = Uuid::new_v4();
        let first = RunnerHeartbeat {
            schema_version: RUNNER_PROTOCOL_VERSION,
            attempt_id,
            execution_token: "token".into(),
            recorded_at: DateTime::from_timestamp(1, 0).unwrap(),
        };
        let mut second = first.clone();
        second.recorded_at = DateTime::from_timestamp(2, 0).unwrap();

        write_json_atomically(&first, &destination).unwrap();
        write_json_atomically(&second, &destination).unwrap();

        assert_eq!(read_json::<RunnerHeartbeat>(&destination).unwrap(), second);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
