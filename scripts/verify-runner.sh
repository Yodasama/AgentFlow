#!/bin/sh

set -eu

runner_input=${1:-target/debug/agentflow-runner}
runner_directory=$(cd "$(dirname "$runner_input")" && pwd)
runner_path="$runner_directory/$(basename "$runner_input")"
mock_input=${2:-target/debug/agentflow-mock-cli}
mock_directory=$(cd "$(dirname "$mock_input")" && pwd)
mock_path="$mock_directory/$(basename "$mock_input")"

if [ ! -x "$runner_path" ]; then
    printf 'runner is not executable: %s\n' "$runner_path" >&2
    exit 1
fi
if [ ! -x "$mock_path" ]; then
    printf 'mock CLI is not executable: %s\n' "$mock_path" >&2
    exit 1
fi

test_root=$(mktemp -d "${TMPDIR:-/tmp}/agentflow-runner-test.XXXXXX")
trap 'rm -rf "$test_root"' EXIT INT TERM

write_launch() {
    case_name=$1
    attempt_id=$2
    execution_token=$3
    executable_path=$4
    arguments_json=$5
    timeout=$6
    case_root="$test_root/$case_name"
    mkdir -p "$case_root/control"

    cat > "$case_root/launch.json" <<EOF
{
  "schemaVersion": 1,
  "attemptId": "$attempt_id",
  "executionToken": "$execution_token",
  "executablePath": "$executable_path",
  "arguments": $arguments_json,
  "workingDirectory": "$case_root",
  "environment": {"PATH": "/usr/bin:/bin"},
  "stdoutPath": "$case_root/stdout.log",
  "stderrPath": "$case_root/stderr.log",
  "identityPath": "$case_root/identity.json",
  "heartbeatPath": "$case_root/heartbeat.json",
  "cancellationPath": "$case_root/control/cancel.json",
  "resultPath": "$case_root/result.json",
  "timeoutSeconds": $timeout,
  "cancellationGraceSeconds": 1
}
EOF
}

write_cancel() {
    destination=$1
    attempt_id=$2
    execution_token=$3
    cat > "$destination" <<EOF
{"schemaVersion":1,"attemptId":"$attempt_id","executionToken":"$execution_token"}
EOF
}

wait_for_file() {
    target=$1
    remaining=100
    while [ ! -f "$target" ] && [ "$remaining" -gt 0 ]; do
        sleep 0.1
        remaining=$((remaining - 1))
    done
    [ -f "$target" ]
}

survival_attempt=$(uuidgen)
survival_token=$(uuidgen)
write_launch "survival" "$survival_attempt" "$survival_token" "$mock_path" '["delay","1000"]' 10
(
    "$runner_path" --launch "$test_root/survival/launch.json" >/dev/null 2>&1 &
)
wait_for_file "$test_root/survival/result.json"
grep -q '"terminationReason": "exited"' "$test_root/survival/result.json"
grep -q '"delayed":true' "$test_root/survival/stdout.log"

cancel_attempt=$(uuidgen)
cancel_token=$(uuidgen)
write_launch "cancel" "$cancel_attempt" "$cancel_token" "$mock_path" '["derived-child"]' 60
"$runner_path" --launch "$test_root/cancel/launch.json" >/dev/null 2>&1 &
wait_for_file "$test_root/cancel/identity.json"

write_cancel "$test_root/cancel/control/cancel.json" "$cancel_attempt" "stale-token"
sleep 0.5
if [ -f "$test_root/cancel/result.json" ]; then
    printf 'runner accepted a stale cancellation token\n' >&2
    exit 1
fi

write_cancel "$test_root/cancel/control/cancel.json" "$cancel_attempt" "$cancel_token"
wait_for_file "$test_root/cancel/result.json"
grep -q '"terminationReason": "cancelled"' "$test_root/cancel/result.json"

failure_attempt=$(uuidgen)
failure_token=$(uuidgen)
write_launch "failure" "$failure_attempt" "$failure_token" "$mock_path" '["failure"]' 10
"$runner_path" --launch "$test_root/failure/launch.json" >/dev/null 2>&1
grep -q '"exitCode": 42' "$test_root/failure/result.json"
grep -q 'intentional mock failure' "$test_root/failure/stderr.log"

invalid_attempt=$(uuidgen)
invalid_token=$(uuidgen)
write_launch "invalid" "$invalid_attempt" "$invalid_token" "$mock_path" '["invalid-json"]' 10
"$runner_path" --launch "$test_root/invalid/launch.json" >/dev/null 2>&1
grep -q 'this is intentionally not JSON' "$test_root/invalid/stdout.log"

log_attempt=$(uuidgen)
log_token=$(uuidgen)
write_launch "long-log" "$log_attempt" "$log_token" "$mock_path" '["long-log","10000"]' 20
"$runner_path" --launch "$test_root/long-log/launch.json" >/dev/null 2>&1
test "$(wc -c < "$test_root/long-log/stdout.log")" -gt 500000
test "$(wc -c < "$test_root/long-log/stderr.log")" -gt 500000

printf 'runner survival, cancellation, failure, invalid output, and long-log checks passed\n'
