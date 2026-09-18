use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::workflow::{
    CommandDefinition, CommandResultKind, ComparisonOperator, ConditionPredicate, NodeKind,
    RepeatBlock, WorkflowBudget, WorkflowDefinition, WorkflowEdge, WorkflowNode,
};

pub const RESULT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestStatus {
    Passed,
    Failed,
    InfrastructureError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestReport {
    pub schema_version: u32,
    pub tested_commit: String,
    pub status: TestStatus,
    pub summary: String,
    #[serde(default)]
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewVerdict {
    Approved,
    ChangesRequested,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Blocking,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewFinding {
    pub severity: FindingSeverity,
    pub file: String,
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewReport {
    pub schema_version: u32,
    pub verdict: ReviewVerdict,
    pub reviewed_commit: String,
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<ReviewFinding>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

impl ApprovalDecision {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanApproval {
    pub schema_version: u32,
    pub candidate_commit: String,
    pub workflow_digest: String,
    pub decision: ApprovalDecision,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub approval_id: Uuid,
    pub run_id: Uuid,
    pub candidate_commit: String,
    pub workflow_digest: String,
    pub decision: ApprovalDecision,
    pub comment: String,
    pub created_at: String,
    pub invalidated_at: Option<String>,
    pub invalidation_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevelopmentPhase {
    Analysis,
    Development,
    Tests,
    WaitingInfrastructure,
    Review,
    HumanApproval,
    Completed,
    Exhausted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentLoop {
    pub workflow_digest: String,
    pub max_iterations: u32,
    pub max_actions: u32,
    pub phase: DevelopmentPhase,
    pub iteration: u32,
    pub actions_used: u32,
    pub candidate_commit: Option<String>,
    pub feedback: Vec<Value>,
    pub test_history: Vec<TestReport>,
    pub review_history: Vec<ReviewReport>,
    pub approval_history: Vec<HumanApproval>,
    pub completed_commit: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DevelopmentFlowError {
    #[error("invalid transition from {from:?}; expected {expected}")]
    InvalidPhase {
        from: DevelopmentPhase,
        expected: &'static str,
    },
    #[error("unsupported result schema version: {0}")]
    UnsupportedSchema(u32),
    #[error("result commit {actual} does not match candidate {expected}")]
    CandidateMismatch { expected: String, actual: String },
    #[error("approval workflow digest does not match this execution")]
    WorkflowMismatch,
    #[error("structured result is invalid: {0}")]
    InvalidResult(String),
    #[error("execution budget is exhausted")]
    BudgetExhausted,
}

impl DevelopmentLoop {
    pub fn new(workflow_digest: String, max_iterations: u32, max_actions: u32) -> Self {
        let phase = if max_iterations == 0 || max_actions == 0 {
            DevelopmentPhase::Exhausted
        } else {
            DevelopmentPhase::Analysis
        };
        Self {
            workflow_digest,
            max_iterations,
            max_actions,
            phase,
            iteration: 1,
            actions_used: 0,
            candidate_commit: None,
            feedback: Vec::new(),
            test_history: Vec::new(),
            review_history: Vec::new(),
            approval_history: Vec::new(),
            completed_commit: None,
        }
    }

    pub fn complete_analysis(&mut self, summary: Value) -> Result<(), DevelopmentFlowError> {
        self.require_phase(DevelopmentPhase::Analysis, "analysis")?;
        self.consume_action()?;
        self.feedback
            .push(json!({"kind": "analysis", "summary": summary}));
        self.phase = DevelopmentPhase::Development;
        Ok(())
    }

    pub fn complete_development(
        &mut self,
        candidate_commit: String,
    ) -> Result<(), DevelopmentFlowError> {
        self.require_phase(DevelopmentPhase::Development, "development")?;
        if candidate_commit.trim().is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "candidate commit must not be empty".to_owned(),
            ));
        }
        self.consume_action()?;
        self.candidate_commit = Some(candidate_commit);
        self.phase = DevelopmentPhase::Tests;
        Ok(())
    }

    pub fn record_tests(&mut self, report: TestReport) -> Result<(), DevelopmentFlowError> {
        self.require_phase(DevelopmentPhase::Tests, "tests")?;
        validate_schema(report.schema_version)?;
        self.require_candidate(&report.tested_commit)?;
        if report.summary.trim().is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "test summary must not be empty".to_owned(),
            ));
        }
        if report.status == TestStatus::Failed && report.failures.is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "failed test report must include failures".to_owned(),
            ));
        }
        self.consume_action()?;
        self.test_history.push(report.clone());
        match report.status {
            TestStatus::Passed => self.phase = DevelopmentPhase::Review,
            TestStatus::InfrastructureError => {
                self.feedback
                    .push(json!({"kind": "test_infrastructure", "report": report}));
                self.phase = DevelopmentPhase::WaitingInfrastructure;
            }
            TestStatus::Failed => {
                self.feedback
                    .push(json!({"kind": "test_failure", "report": report}));
                self.next_iteration();
            }
        }
        Ok(())
    }

    pub fn retry_infrastructure(&mut self) -> Result<(), DevelopmentFlowError> {
        self.require_phase(
            DevelopmentPhase::WaitingInfrastructure,
            "infrastructure retry",
        )?;
        self.consume_action()?;
        self.phase = DevelopmentPhase::Tests;
        Ok(())
    }

    pub fn record_review(&mut self, report: ReviewReport) -> Result<(), DevelopmentFlowError> {
        self.require_phase(DevelopmentPhase::Review, "review")?;
        validate_schema(report.schema_version)?;
        self.require_candidate(&report.reviewed_commit)?;
        if report.summary.trim().is_empty()
            || report.findings.iter().any(|finding| {
                finding.file.is_empty() || finding.line == 0 || finding.message.is_empty()
            })
        {
            return Err(DevelopmentFlowError::InvalidResult(
                "review summary and finding locations must be complete".to_owned(),
            ));
        }
        if report.verdict == ReviewVerdict::ChangesRequested && report.findings.is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "changes_requested review must include findings".to_owned(),
            ));
        }
        if report.verdict == ReviewVerdict::Approved
            && report
                .findings
                .iter()
                .any(|finding| finding.severity == FindingSeverity::Blocking)
        {
            return Err(DevelopmentFlowError::InvalidResult(
                "approved review cannot contain blocking findings".to_owned(),
            ));
        }
        self.consume_action()?;
        self.review_history.push(report.clone());
        match report.verdict {
            ReviewVerdict::Approved => self.phase = DevelopmentPhase::HumanApproval,
            ReviewVerdict::ChangesRequested => {
                self.feedback
                    .push(json!({"kind": "review_findings", "report": report}));
                self.next_iteration();
            }
        }
        Ok(())
    }

    pub fn record_approval(&mut self, approval: HumanApproval) -> Result<(), DevelopmentFlowError> {
        self.require_phase(DevelopmentPhase::HumanApproval, "human approval")?;
        validate_schema(approval.schema_version)?;
        self.require_candidate(&approval.candidate_commit)?;
        if approval.workflow_digest != self.workflow_digest {
            return Err(DevelopmentFlowError::WorkflowMismatch);
        }
        if approval.decision == ApprovalDecision::Rejected && approval.comment.trim().is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "rejected approval must include a comment".to_owned(),
            ));
        }
        self.consume_action()?;
        self.approval_history.push(approval.clone());
        match approval.decision {
            ApprovalDecision::Approved => {
                self.completed_commit = self.candidate_commit.clone();
                self.phase = DevelopmentPhase::Completed;
            }
            ApprovalDecision::Rejected => {
                self.feedback
                    .push(json!({"kind": "human_rejection", "approval": approval}));
                self.next_iteration();
            }
        }
        Ok(())
    }

    pub fn candidate_changed(
        &mut self,
        candidate_commit: String,
    ) -> Result<(), DevelopmentFlowError> {
        if !matches!(
            self.phase,
            DevelopmentPhase::Tests
                | DevelopmentPhase::WaitingInfrastructure
                | DevelopmentPhase::Review
                | DevelopmentPhase::HumanApproval
        ) {
            return Err(DevelopmentFlowError::InvalidPhase {
                from: self.phase,
                expected: "an active candidate",
            });
        }
        if candidate_commit.trim().is_empty() {
            return Err(DevelopmentFlowError::InvalidResult(
                "candidate commit must not be empty".to_owned(),
            ));
        }
        self.consume_action()?;
        self.feedback.push(json!({
            "kind": "candidate_changed",
            "from": self.candidate_commit,
            "to": candidate_commit,
        }));
        self.candidate_commit = Some(candidate_commit);
        self.phase = DevelopmentPhase::Tests;
        Ok(())
    }

    fn next_iteration(&mut self) {
        if self.iteration >= self.max_iterations {
            self.phase = DevelopmentPhase::Exhausted;
        } else {
            self.iteration += 1;
            self.candidate_commit = None;
            self.phase = DevelopmentPhase::Development;
        }
    }

    fn consume_action(&mut self) -> Result<(), DevelopmentFlowError> {
        if self.actions_used >= self.max_actions {
            self.phase = DevelopmentPhase::Exhausted;
            return Err(DevelopmentFlowError::BudgetExhausted);
        }
        self.actions_used += 1;
        Ok(())
    }

    fn require_phase(
        &self,
        expected: DevelopmentPhase,
        name: &'static str,
    ) -> Result<(), DevelopmentFlowError> {
        if self.phase == expected {
            Ok(())
        } else {
            Err(DevelopmentFlowError::InvalidPhase {
                from: self.phase,
                expected: name,
            })
        }
    }

    fn require_candidate(&self, actual: &str) -> Result<(), DevelopmentFlowError> {
        let expected = self.candidate_commit.as_deref().unwrap_or_default();
        if actual == expected {
            Ok(())
        } else {
            Err(DevelopmentFlowError::CandidateMismatch {
                expected: expected.to_owned(),
                actual: actual.to_owned(),
            })
        }
    }
}

pub fn parse_test_report(bytes: &[u8]) -> Result<TestReport, DevelopmentFlowError> {
    serde_json::from_slice(bytes)
        .map_err(|error| DevelopmentFlowError::InvalidResult(error.to_string()))
}

pub fn parse_review_report(bytes: &[u8]) -> Result<ReviewReport, DevelopmentFlowError> {
    serde_json::from_slice(bytes)
        .map_err(|error| DevelopmentFlowError::InvalidResult(error.to_string()))
}

pub fn standard_development_workflow() -> WorkflowDefinition {
    let nodes = vec![
        node("start", NodeKind::Start, None, None),
        node("analysis", NodeKind::Agent, Some("analyst"), None),
        node("development", NodeKind::Agent, Some("developer"), None),
        node(
            "tests",
            NodeKind::Command,
            None,
            Some(CommandDefinition {
                program: "project-test-command".to_owned(),
                arguments: Vec::new(),
                result_kind: CommandResultKind::Test,
            }),
        ),
        node("test-decision", NodeKind::Condition, None, None),
        node("review", NodeKind::Agent, Some("reviewer"), None),
        node("review-decision", NodeKind::Condition, None, None),
        node("approval", NodeKind::HumanApproval, None, None),
        node("loop-decision", NodeKind::Condition, None, None),
        node("end", NodeKind::End, None, None),
    ];
    let mut edges = vec![
        edge("start-analysis", "start", "analysis"),
        edge("analysis-development", "analysis", "development"),
        edge("development-tests", "development", "tests"),
        edge("tests-test-decision", "tests", "test-decision"),
        conditional_edge(
            "tests-passed",
            "test-decision",
            "review",
            "tests.status",
            json!("passed"),
        ),
        default_edge("tests-retry", "test-decision", "loop-decision"),
        edge("review-review-decision", "review", "review-decision"),
        conditional_edge(
            "review-approved",
            "review-decision",
            "approval",
            "review.verdict",
            json!("approved"),
        ),
        default_edge("review-retry", "review-decision", "loop-decision"),
        conditional_edge(
            "approval-approved",
            "approval",
            "loop-decision",
            "approval.decision",
            json!("approved"),
        ),
        default_edge("approval-retry", "approval", "loop-decision"),
        conditional_edge(
            "repeat-back",
            "loop-decision",
            "development",
            "loop.action",
            json!("retry"),
        ),
        default_edge("loop-complete", "loop-decision", "end"),
    ];
    edges.sort_by(|left, right| left.id.cmp(&right.id));
    WorkflowDefinition {
        schema_version: 1,
        name: "标准开发与有限返工".to_owned(),
        nodes,
        edges,
        repeat_blocks: vec![RepeatBlock {
            id: "development-loop".to_owned(),
            node_ids: [
                "development",
                "tests",
                "test-decision",
                "review",
                "review-decision",
                "approval",
                "loop-decision",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            entry_node_id: "development".to_owned(),
            exit_node_id: "loop-decision".to_owned(),
            back_edge_id: "repeat-back".to_owned(),
            max_iterations: 3,
        }],
        role_bindings: BTreeMap::from([
            ("analyst".to_owned(), "mock:analyst".to_owned()),
            ("developer".to_owned(), "mock:developer".to_owned()),
            ("reviewer".to_owned(), "mock:reviewer".to_owned()),
        ]),
        available_inputs: BTreeSet::from(["task".to_owned(), "workspace".to_owned()]),
        budget: WorkflowBudget {
            max_steps: 40,
            max_iterations: 3,
        },
    }
}

fn validate_schema(version: u32) -> Result<(), DevelopmentFlowError> {
    if version == RESULT_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(DevelopmentFlowError::UnsupportedSchema(version))
    }
}

fn node(
    id: &str,
    kind: NodeKind,
    role: Option<&str>,
    command: Option<CommandDefinition>,
) -> WorkflowNode {
    WorkflowNode {
        id: id.to_owned(),
        version: 1,
        kind,
        label: id.to_owned(),
        role: role.map(str::to_owned),
        command,
        required_inputs: BTreeSet::new(),
    }
}

fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
    WorkflowEdge {
        id: id.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        is_default: false,
        predicate: None,
    }
}

fn conditional_edge(
    id: &str,
    source: &str,
    target: &str,
    field: &str,
    expected: Value,
) -> WorkflowEdge {
    WorkflowEdge {
        id: id.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        is_default: false,
        predicate: Some(ConditionPredicate {
            field: field.to_owned(),
            operator: ComparisonOperator::Equals,
            expected: Some(expected),
        }),
    }
}

fn default_edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
    WorkflowEdge {
        id: id.to_owned(),
        source: source.to_owned(),
        target: target.to_owned(),
        is_default: true,
        predicate: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{WorkflowCursor, validate_workflow};

    #[test]
    fn standard_template_is_valid_and_repeat_is_bounded() {
        let workflow = standard_development_workflow();
        let report = validate_workflow(&workflow);
        assert!(report.valid, "{:#?}", report.issues);
        let mut cursor = WorkflowCursor::start(&workflow).unwrap();
        cursor.advance(&workflow, &json!({})).unwrap();
        assert_eq!(cursor.current_node_id, "analysis");
    }

    #[test]
    fn test_failure_then_review_rejection_then_approval_completes_on_third_candidate() {
        let mut flow = DevelopmentLoop::new("workflow-digest".into(), 3, 20);
        flow.complete_analysis(json!({"requirements": "ready"}))
            .unwrap();
        flow.complete_development("sha-1".into()).unwrap();
        flow.record_tests(test_report("sha-1", TestStatus::Failed))
            .unwrap();
        assert_eq!(
            (flow.phase, flow.iteration),
            (DevelopmentPhase::Development, 2)
        );

        flow.complete_development("sha-2".into()).unwrap();
        flow.record_tests(test_report("sha-2", TestStatus::Passed))
            .unwrap();
        flow.record_review(ReviewReport {
            schema_version: 1,
            verdict: ReviewVerdict::ChangesRequested,
            reviewed_commit: "sha-2".into(),
            summary: "blocking issue".into(),
            findings: vec![ReviewFinding {
                severity: FindingSeverity::Blocking,
                file: "src/main.rs".into(),
                line: 7,
                message: "incorrect boundary".into(),
            }],
        })
        .unwrap();
        assert_eq!(
            (flow.phase, flow.iteration),
            (DevelopmentPhase::Development, 3)
        );

        flow.complete_development("sha-3".into()).unwrap();
        flow.record_tests(test_report("sha-3", TestStatus::Passed))
            .unwrap();
        flow.record_review(approved_review("sha-3")).unwrap();
        flow.record_approval(HumanApproval {
            schema_version: 1,
            candidate_commit: "sha-3".into(),
            workflow_digest: "workflow-digest".into(),
            decision: ApprovalDecision::Approved,
            comment: "ship it".into(),
        })
        .unwrap();
        assert_eq!(flow.phase, DevelopmentPhase::Completed);
        assert_eq!(flow.completed_commit.as_deref(), Some("sha-3"));
        assert_eq!(flow.test_history.len(), 3);
        assert_eq!(flow.review_history.len(), 2);
    }

    #[test]
    fn stale_approval_and_changed_candidate_cannot_complete() {
        let mut flow = DevelopmentLoop::new("digest".into(), 3, 20);
        flow.complete_analysis(json!({})).unwrap();
        flow.complete_development("sha-1".into()).unwrap();
        flow.record_tests(test_report("sha-1", TestStatus::Passed))
            .unwrap();
        flow.record_review(approved_review("sha-1")).unwrap();
        flow.candidate_changed("sha-2".into()).unwrap();
        assert_eq!(flow.phase, DevelopmentPhase::Tests);
        assert!(matches!(
            flow.record_tests(test_report("sha-1", TestStatus::Passed)),
            Err(DevelopmentFlowError::CandidateMismatch { .. })
        ));
    }

    #[test]
    fn iteration_limit_and_invalid_json_never_pass() {
        let mut flow = DevelopmentLoop::new("digest".into(), 1, 10);
        flow.complete_analysis(json!({})).unwrap();
        flow.complete_development("sha".into()).unwrap();
        flow.record_tests(test_report("sha", TestStatus::Failed))
            .unwrap();
        assert_eq!(flow.phase, DevelopmentPhase::Exhausted);
        assert!(parse_review_report(br#"{"schemaVersion":1,"verdict":"approved"}"#).is_err());
        assert!(parse_test_report(b"not json").is_err());
    }

    fn test_report(commit: &str, status: TestStatus) -> TestReport {
        TestReport {
            schema_version: 1,
            tested_commit: commit.into(),
            status,
            summary: "test result".into(),
            failures: (status == TestStatus::Failed)
                .then(|| "fixture failure".to_owned())
                .into_iter()
                .collect(),
        }
    }

    fn approved_review(commit: &str) -> ReviewReport {
        ReviewReport {
            schema_version: 1,
            verdict: ReviewVerdict::Approved,
            reviewed_commit: commit.into(),
            summary: "approved".into(),
            findings: Vec::new(),
        }
    }
}
