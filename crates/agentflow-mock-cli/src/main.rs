use std::{
    env,
    io::{self, Write},
    process::{Command, ExitCode},
    thread,
    time::Duration,
};

const FAILURE_EXIT_CODE: u8 = 42;

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match execute(&arguments, &mut io::stdout(), &mut io::stderr()) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("mock-cli: {error}");
            ExitCode::FAILURE
        }
    }
}

fn execute(
    arguments: &[String],
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> io::Result<u8> {
    match arguments.first().map(String::as_str) {
        Some("workflow-node") => {
            let input: serde_json::Value =
                serde_json::from_str(arguments.get(1).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidInput, "missing workflow input")
                })?)
                .map_err(io::Error::other)?;
            let iteration = input["iteration"]
                .as_u64()
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing iteration"))?;
            let retry = input["scenario"].as_str() == Some("test_then_review_retry");
            let candidate = &input["candidateCommit"];
            let result = match input["phase"].as_str() {
                Some("analysis") => {
                    serde_json::json!({"summary":"mock analysis: implement fixture and validate it"})
                }
                Some("development") => {
                    std::fs::write(
                        "agentflow-fixture.txt",
                        format!("mock development iteration {iteration}\n"),
                    )?;
                    serde_json::json!({"summary":"mock developer changed agentflow-fixture.txt"})
                }
                Some("tests") => {
                    let content = std::fs::read_to_string("agentflow-fixture.txt")?;
                    let failed = (retry && iteration == 1)
                        || !content.contains(&format!("iteration {iteration}"));
                    serde_json::json!({"report":{"schemaVersion":1,"testedCommit":candidate,
                        "status":if failed {"failed"} else {"passed"}, "summary":"mock fixture test",
                        "failures":if failed {vec!["mock test requested another iteration"]} else {vec![]}}})
                }
                Some("review") => {
                    let content = std::fs::read_to_string("agentflow-fixture.txt")?;
                    if !content.contains(&format!("iteration {iteration}")) {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "review checkout does not contain current candidate",
                        ));
                    }
                    let rejected = retry && iteration == 2;
                    serde_json::json!({"report":{"schemaVersion":1,"reviewedCommit":candidate,
                        "verdict":if rejected {"changes_requested"} else {"approved"}, "summary":"mock candidate review",
                        "findings":if rejected {vec![serde_json::json!({"severity":"blocking","file":"agentflow-fixture.txt","line":1,"message":"mock reviewer requested another iteration"})]} else {vec![]}}})
                }
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "unsupported mock workflow phase",
                    ));
                }
            };
            writeln!(
                stdout,
                "{}",
                serde_json::json!({"schemaVersion":1,"status":"succeeded","result":result})
            )?;
            Ok(0)
        }
        Some("workflow-result") => {
            let payload = arguments.get(1).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "missing mock workflow result")
            })?;
            thread::sleep(Duration::from_millis(parse_number(
                arguments.get(2),
                0,
                "workflow delay",
            )?));
            writeln!(
                stdout,
                "{{\"schemaVersion\":1,\"status\":\"succeeded\",\"result\":{payload}}}"
            )?;
            Ok(0)
        }
        Some("workflow-development") => {
            std::fs::write(
                "agentflow-fixture.txt",
                format!(
                    "mock development iteration {}\n",
                    arguments.get(1).map(String::as_str).unwrap_or("1")
                ),
            )?;
            writeln!(
                stdout,
                r#"{{"schemaVersion":1,"status":"succeeded","result":{{"summary":"mock development wrote a fixture"}}}}"#
            )?;
            Ok(0)
        }
        Some("success") => {
            writeln!(stdout, r#"{{"schemaVersion":1,"status":"succeeded"}}"#)?;
            Ok(0)
        }
        Some("failure") => {
            writeln!(stderr, "intentional mock failure")?;
            Ok(FAILURE_EXIT_CODE)
        }
        Some("delay") => {
            let milliseconds = parse_number(arguments.get(1), 500, "delay milliseconds")?;
            thread::sleep(Duration::from_millis(milliseconds));
            writeln!(
                stdout,
                r#"{{"schemaVersion":1,"status":"succeeded","delayed":true}}"#
            )?;
            Ok(0)
        }
        Some("invalid-json") => {
            writeln!(stdout, "this is intentionally not JSON")?;
            Ok(0)
        }
        Some("long-log") => {
            let lines = parse_number(arguments.get(1), 10_000, "line count")?;
            for index in 0..lines {
                writeln!(stdout, "stdout line {index:06}: {}", "x".repeat(96))?;
                writeln!(stderr, "stderr line {index:06}: {}", "y".repeat(96))?;
            }
            Ok(0)
        }
        Some("derived-child") => {
            let executable = env::current_exe()?;
            let mut child = Command::new(executable).arg("child-worker").spawn()?;
            writeln!(stdout, r#"{{"schemaVersion":1,"childPID":{}}}"#, child.id())?;
            stdout.flush()?;
            let status = child.wait()?;
            Ok(status.code().unwrap_or(128).try_into().unwrap_or(1))
        }
        Some("child-worker") => {
            thread::sleep(Duration::from_secs(30));
            Ok(0)
        }
        _ => {
            writeln!(
                stderr,
                "usage: agentflow-mock-cli <success|failure|delay|invalid-json|long-log|derived-child>"
            )?;
            Ok(2)
        }
    }
}

fn parse_number(value: Option<&String>, default: u64, name: &str) -> io::Result<u64> {
    value.map_or(Ok(default), |value| {
        value.parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid {name}: {value}"),
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_is_structured() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = execute(&["success".into()], &mut stdout, &mut stderr).unwrap();

        assert_eq!(code, 0);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            "{\"schemaVersion\":1,\"status\":\"succeeded\"}\n"
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn failure_uses_nonzero_exit_and_stderr() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = execute(&["failure".into()], &mut stdout, &mut stderr).unwrap();

        assert_eq!(code, FAILURE_EXIT_CODE);
        assert!(stdout.is_empty());
        assert_eq!(
            String::from_utf8(stderr).unwrap(),
            "intentional mock failure\n"
        );
    }

    #[test]
    fn invalid_json_still_exits_zero() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = execute(&["invalid-json".into()], &mut stdout, &mut stderr).unwrap();

        assert_eq!(code, 0);
        assert_eq!(
            String::from_utf8(stdout).unwrap(),
            "this is intentionally not JSON\n"
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn long_log_writes_both_streams() {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = execute(&["long-log".into(), "3".into()], &mut stdout, &mut stderr).unwrap();

        assert_eq!(code, 0);
        assert_eq!(stdout.iter().filter(|byte| **byte == b'\n').count(), 3);
        assert_eq!(stderr.iter().filter(|byte| **byte == b'\n').count(), 3);
    }
}
