use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;
pub const WORKFLOW_NODE_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub schema_version: u32,
    #[serde(default = "default_workflow_name")]
    pub name: String,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub repeat_blocks: Vec<RepeatBlock>,
    #[serde(default)]
    pub role_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub available_inputs: BTreeSet<String>,
    #[serde(default)]
    pub budget: WorkflowBudget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    #[serde(default = "default_node_version")]
    pub version: u32,
    pub kind: NodeKind,
    pub label: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub command: Option<CommandDefinition>,
    #[serde(default)]
    pub required_inputs: BTreeSet<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Start,
    Agent,
    Command,
    Condition,
    HumanApproval,
    End,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandDefinition {
    pub program: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub result_kind: CommandResultKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandResultKind {
    Test,
    Structured,
    Generic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub is_default: bool,
    #[serde(default)]
    pub predicate: Option<ConditionPredicate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ConditionPredicate {
    pub field: String,
    pub operator: ComparisonOperator,
    #[serde(default)]
    pub expected: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ComparisonOperator {
    Equals,
    NotEquals,
    Exists,
    DoesNotExist,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepeatBlock {
    pub id: String,
    pub node_ids: BTreeSet<String>,
    pub entry_node_id: String,
    pub exit_node_id: String,
    pub back_edge_id: String,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowBudget {
    pub max_steps: u32,
    pub max_iterations: u32,
}

impl Default for WorkflowBudget {
    fn default() -> Self {
        Self {
            max_steps: 100,
            max_iterations: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCursor {
    pub current_node_id: String,
    pub steps_executed: u32,
    pub repeat_iterations: BTreeMap<String, u32>,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVersionRecord {
    pub workflow_version_id: Uuid,
    pub name: String,
    pub schema_version: u32,
    pub digest: String,
    pub definition: WorkflowDefinition,
    pub created_at: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkflowExecutionError {
    #[error("workflow definition is invalid")]
    InvalidDefinition,
    #[error("current workflow node does not exist: {0}")]
    MissingNode(String),
    #[error("no workflow edge matched from node: {0}")]
    NoMatchingEdge(String),
    #[error("workflow step budget exhausted")]
    StepBudgetExhausted,
    #[error("repeat block iteration limit reached: {0}")]
    RepeatLimitReached(String),
    #[error("workflow is already complete")]
    AlreadyComplete,
}

impl WorkflowCursor {
    pub fn start(workflow: &WorkflowDefinition) -> Result<Self, WorkflowExecutionError> {
        if !validate_workflow(workflow).valid {
            return Err(WorkflowExecutionError::InvalidDefinition);
        }
        let start = workflow
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Start)
            .expect("validated workflow has one Start");
        Ok(Self {
            current_node_id: start.id.clone(),
            steps_executed: 0,
            repeat_iterations: BTreeMap::new(),
            completed: false,
        })
    }

    pub fn advance(
        &mut self,
        workflow: &WorkflowDefinition,
        facts: &Value,
    ) -> Result<&str, WorkflowExecutionError> {
        if self.completed {
            return Err(WorkflowExecutionError::AlreadyComplete);
        }
        if self.steps_executed >= workflow.budget.max_steps {
            return Err(WorkflowExecutionError::StepBudgetExhausted);
        }
        let node = workflow
            .nodes
            .iter()
            .find(|node| node.id == self.current_node_id)
            .ok_or_else(|| WorkflowExecutionError::MissingNode(self.current_node_id.clone()))?;
        if node.kind == NodeKind::End {
            self.completed = true;
            return Ok(&self.current_node_id);
        }
        let outgoing = workflow
            .edges
            .iter()
            .filter(|edge| edge.source == node.id)
            .collect::<Vec<_>>();
        let selected = if matches!(node.kind, NodeKind::Condition | NodeKind::HumanApproval) {
            outgoing
                .iter()
                .find(|edge| {
                    edge.predicate
                        .as_ref()
                        .is_some_and(|predicate| predicate_matches(predicate, facts))
                })
                .copied()
                .or_else(|| outgoing.iter().find(|edge| edge.is_default).copied())
        } else {
            outgoing.first().copied()
        }
        .ok_or_else(|| WorkflowExecutionError::NoMatchingEdge(node.id.clone()))?;

        if let Some(block) = workflow
            .repeat_blocks
            .iter()
            .find(|block| block.back_edge_id == selected.id)
        {
            let iteration = self.repeat_iterations.entry(block.id.clone()).or_insert(1);
            if *iteration >= block.max_iterations {
                return Err(WorkflowExecutionError::RepeatLimitReached(block.id.clone()));
            }
            *iteration += 1;
        }
        self.steps_executed += 1;
        self.current_node_id.clone_from(&selected.target);
        if workflow
            .nodes
            .iter()
            .any(|node| node.id == self.current_node_id && node.kind == NodeKind::End)
        {
            self.completed = true;
        }
        Ok(&self.current_node_id)
    }
}

pub fn validate_workflow(workflow: &WorkflowDefinition) -> ValidationReport {
    let mut issues = Vec::new();
    if workflow.schema_version != WORKFLOW_SCHEMA_VERSION {
        issues.push(issue(
            "unsupported_schema",
            "不支持的工作流 schemaVersion",
            None,
            None,
        ));
    }
    if workflow.name.trim().is_empty() {
        issues.push(issue("missing_name", "工作流名称不能为空", None, None));
    }
    if workflow.budget.max_steps == 0 || workflow.budget.max_iterations == 0 {
        issues.push(issue(
            "invalid_budget",
            "工作流步骤和迭代预算必须大于零",
            None,
            None,
        ));
    }

    let mut node_ids = HashSet::new();
    for node in &workflow.nodes {
        if node.id.is_empty() || !node_ids.insert(node.id.as_str()) {
            issues.push(issue(
                "duplicate_node_id",
                "节点 ID 为空或重复",
                Some(&node.id),
                None,
            ));
        }
        if node.version != WORKFLOW_NODE_VERSION {
            issues.push(issue(
                "unsupported_node_version",
                "节点版本不受支持",
                Some(&node.id),
                None,
            ));
        }
        if node.label.trim().is_empty() {
            issues.push(issue(
                "missing_node_label",
                "节点名称不能为空",
                Some(&node.id),
                None,
            ));
        }
        if node.kind == NodeKind::Agent {
            match node.role.as_deref() {
                Some(role)
                    if workflow
                        .role_bindings
                        .get(role)
                        .is_some_and(|id| !id.is_empty()) => {}
                _ => issues.push(issue(
                    "missing_role_binding",
                    "Agent 节点缺少已绑定账号的角色",
                    Some(&node.id),
                    None,
                )),
            }
        }
        if node.kind == NodeKind::Command
            && node
                .command
                .as_ref()
                .is_none_or(|command| command.program.trim().is_empty())
        {
            issues.push(issue(
                "missing_command",
                "Command 节点缺少预配置命令",
                Some(&node.id),
                None,
            ));
        }
        for required in &node.required_inputs {
            if !workflow.available_inputs.contains(required) {
                issues.push(issue(
                    "missing_required_input",
                    "节点引用了工作流未声明的必需输入",
                    Some(&node.id),
                    None,
                ));
            }
        }
    }

    let starts = workflow
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Start)
        .collect::<Vec<_>>();
    if starts.len() != 1 {
        issues.push(issue(
            "start_count",
            "工作流必须且只能包含一个 Start 节点",
            None,
            None,
        ));
    }
    if !workflow.nodes.iter().any(|node| node.kind == NodeKind::End) {
        issues.push(issue("missing_end", "工作流必须包含 End 节点", None, None));
    }

    let mut edge_ids = HashSet::new();
    for edge in &workflow.edges {
        if edge.id.is_empty() || !edge_ids.insert(edge.id.as_str()) {
            issues.push(issue(
                "duplicate_edge_id",
                "边 ID 为空或重复",
                None,
                Some(&edge.id),
            ));
        }
        if !node_ids.contains(edge.source.as_str()) || !node_ids.contains(edge.target.as_str()) {
            issues.push(issue(
                "dangling_edge",
                "边引用了不存在的节点",
                None,
                Some(&edge.id),
            ));
        }
        if edge.is_default && edge.predicate.is_some() {
            issues.push(issue(
                "default_edge_predicate",
                "默认路径不能同时声明条件",
                None,
                Some(&edge.id),
            ));
        }
        if let Some(predicate) = &edge.predicate {
            let valid_shape = match predicate.operator {
                ComparisonOperator::Equals | ComparisonOperator::NotEquals => {
                    predicate.expected.is_some()
                }
                ComparisonOperator::Exists | ComparisonOperator::DoesNotExist => {
                    predicate.expected.is_none()
                }
            };
            if predicate.field.trim().is_empty() || !valid_shape {
                issues.push(issue(
                    "invalid_predicate",
                    "声明式条件字段或期望值不合法",
                    None,
                    Some(&edge.id),
                ));
            }
        }
    }

    for node in &workflow.nodes {
        let incoming = workflow
            .edges
            .iter()
            .filter(|edge| edge.target == node.id)
            .count();
        let outgoing = workflow
            .edges
            .iter()
            .filter(|edge| edge.source == node.id)
            .collect::<Vec<_>>();
        match node.kind {
            NodeKind::Start => {
                if incoming != 0 || outgoing.len() != 1 {
                    issues.push(issue(
                        "invalid_start_degree",
                        "Start 必须没有入边且只有一条出边",
                        Some(&node.id),
                        None,
                    ));
                }
            }
            NodeKind::End => {
                if !outgoing.is_empty() {
                    issues.push(issue(
                        "invalid_end_degree",
                        "End 不能有出边",
                        Some(&node.id),
                        None,
                    ));
                }
            }
            NodeKind::Condition | NodeKind::HumanApproval => {
                if outgoing.iter().filter(|edge| edge.is_default).count() != 1 {
                    issues.push(issue(
                        "missing_default_path",
                        "分支节点必须且只能包含一条默认路径",
                        Some(&node.id),
                        None,
                    ));
                }
                if outgoing
                    .iter()
                    .any(|edge| !edge.is_default && edge.predicate.is_none())
                {
                    issues.push(issue(
                        "missing_edge_predicate",
                        "非默认分支缺少声明式条件",
                        Some(&node.id),
                        None,
                    ));
                }
            }
            _ if outgoing.len() != 1 => issues.push(issue(
                "parallel_or_dead_end",
                "第一版非分支节点必须且只能有一条出边",
                Some(&node.id),
                None,
            )),
            _ => {}
        }
    }

    validate_repeat_blocks(workflow, &node_ids, &edge_ids, &mut issues);

    if let [start] = starts.as_slice() {
        let reachable = reachable_nodes(&start.id, &workflow.edges, &node_ids);
        for node in &workflow.nodes {
            if !reachable.contains(node.id.as_str()) {
                issues.push(issue(
                    "unreachable_node",
                    "节点从 Start 不可达",
                    Some(&node.id),
                    None,
                ));
            }
        }
    }

    let back_edges = workflow
        .repeat_blocks
        .iter()
        .map(|block| block.back_edge_id.as_str())
        .collect::<HashSet<_>>();
    if graph_has_cycle(workflow, &node_ids, &back_edges) {
        issues.push(issue(
            "unbounded_cycle",
            "工作流包含未受 RepeatBlock 限制的循环",
            None,
            None,
        ));
    }

    ValidationReport {
        valid: issues.is_empty(),
        issues,
    }
}

pub fn workflow_digest(workflow: &WorkflowDefinition) -> Result<String, serde_json::Error> {
    let bytes = serde_json::to_vec(workflow)?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn validate_repeat_blocks(
    workflow: &WorkflowDefinition,
    node_ids: &HashSet<&str>,
    edge_ids: &HashSet<&str>,
    issues: &mut Vec<ValidationIssue>,
) {
    let mut block_ids = HashSet::new();
    let mut claimed_nodes = HashSet::new();
    let mut claimed_back_edges = HashSet::new();
    for block in &workflow.repeat_blocks {
        if block.id.is_empty() || !block_ids.insert(block.id.as_str()) {
            issues.push(issue(
                "duplicate_repeat_block",
                "RepeatBlock ID 为空或重复",
                None,
                None,
            ));
        }
        if block.max_iterations == 0 || block.max_iterations > workflow.budget.max_iterations {
            issues.push(issue(
                "invalid_repeat_limit",
                "RepeatBlock 最大轮次必须在工作流预算内",
                None,
                Some(&block.back_edge_id),
            ));
        }
        if !node_ids.contains(block.entry_node_id.as_str())
            || !node_ids.contains(block.exit_node_id.as_str())
            || !block.node_ids.contains(&block.entry_node_id)
            || !block.node_ids.contains(&block.exit_node_id)
            || block
                .node_ids
                .iter()
                .any(|node| !node_ids.contains(node.as_str()))
        {
            issues.push(issue(
                "invalid_repeat_nodes",
                "RepeatBlock 引用了无效入口、出口或成员节点",
                None,
                Some(&block.back_edge_id),
            ));
        }
        if block
            .node_ids
            .iter()
            .any(|node| !claimed_nodes.insert(node.as_str()))
        {
            issues.push(issue(
                "nested_repeat_block",
                "第一版不允许嵌套或重叠 RepeatBlock",
                None,
                Some(&block.back_edge_id),
            ));
        }
        if !edge_ids.contains(block.back_edge_id.as_str())
            || !claimed_back_edges.insert(block.back_edge_id.as_str())
        {
            issues.push(issue(
                "invalid_back_edge",
                "RepeatBlock 缺少唯一且存在的回边",
                None,
                Some(&block.back_edge_id),
            ));
            continue;
        }
        if let Some(edge) = workflow
            .edges
            .iter()
            .find(|edge| edge.id == block.back_edge_id)
        {
            if edge.source != block.exit_node_id || edge.target != block.entry_node_id {
                issues.push(issue(
                    "invalid_back_edge",
                    "回边必须从 RepeatBlock 出口返回入口",
                    None,
                    Some(&edge.id),
                ));
            }
        }
        let invalid_entry = workflow.edges.iter().any(|edge| {
            !block.node_ids.contains(&edge.source)
                && block.node_ids.contains(&edge.target)
                && edge.target != block.entry_node_id
        });
        let invalid_exit = workflow.edges.iter().any(|edge| {
            block.node_ids.contains(&edge.source)
                && !block.node_ids.contains(&edge.target)
                && edge.source != block.exit_node_id
        });
        if invalid_entry || invalid_exit {
            issues.push(issue(
                "invalid_repeat_boundary",
                "RepeatBlock 必须只有声明的入口和出口",
                None,
                Some(&block.back_edge_id),
            ));
        }
    }
}

fn graph_has_cycle(
    workflow: &WorkflowDefinition,
    node_ids: &HashSet<&str>,
    ignored_edges: &HashSet<&str>,
) -> bool {
    let mut indegree = node_ids
        .iter()
        .map(|id| (*id, 0_usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &workflow.edges {
        if ignored_edges.contains(edge.id.as_str())
            || !node_ids.contains(edge.source.as_str())
            || !node_ids.contains(edge.target.as_str())
        {
            continue;
        }
        outgoing.entry(&edge.source).or_default().push(&edge.target);
        *indegree.entry(&edge.target).or_default() += 1;
    }
    let mut pending = indegree
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect::<VecDeque<_>>();
    let mut visited = 0;
    while let Some(node) = pending.pop_front() {
        visited += 1;
        for target in outgoing.get(node).into_iter().flatten() {
            let count = indegree.get_mut(target).expect("known node");
            *count -= 1;
            if *count == 0 {
                pending.push_back(target);
            }
        }
    }
    visited != node_ids.len()
}

fn reachable_nodes<'a>(
    start: &'a str,
    edges: &'a [WorkflowEdge],
    nodes: &HashSet<&'a str>,
) -> HashSet<&'a str> {
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        if nodes.contains(edge.source.as_str()) && nodes.contains(edge.target.as_str()) {
            outgoing.entry(&edge.source).or_default().push(&edge.target);
        }
    }
    let mut reachable = HashSet::from([start]);
    let mut pending = VecDeque::from([start]);
    while let Some(node) = pending.pop_front() {
        for target in outgoing.get(node).into_iter().flatten() {
            if reachable.insert(target) {
                pending.push_back(target);
            }
        }
    }
    reachable
}

fn predicate_matches(predicate: &ConditionPredicate, facts: &Value) -> bool {
    let actual = predicate
        .field
        .split('.')
        .try_fold(facts, |value, segment| value.get(segment));
    match predicate.operator {
        ComparisonOperator::Equals => actual == predicate.expected.as_ref(),
        ComparisonOperator::NotEquals => actual != predicate.expected.as_ref(),
        ComparisonOperator::Exists => actual.is_some(),
        ComparisonOperator::DoesNotExist => actual.is_none(),
    }
}

fn issue(
    code: &str,
    message: &str,
    node_id: Option<&str>,
    edge_id: Option<&str>,
) -> ValidationIssue {
    ValidationIssue {
        code: code.into(),
        message: message.into(),
        node_id: node_id.map(str::to_owned),
        edge_id: edge_id.map(str::to_owned),
    }
}

const fn default_node_version() -> u32 {
    WORKFLOW_NODE_VERSION
}

fn default_workflow_name() -> String {
    "Untitled Workflow".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_minimal_linear_workflow_and_advances_to_end() {
        let workflow = minimal_workflow();
        assert!(validate_workflow(&workflow).valid);
        let mut cursor = WorkflowCursor::start(&workflow).unwrap();
        assert_eq!(cursor.advance(&workflow, &json!({})).unwrap(), "end");
        assert!(cursor.completed);
    }

    #[test]
    fn rejects_dangling_edge_and_unreachable_end() {
        let mut workflow = minimal_workflow();
        workflow.edges[0].target = "missing".into();
        let report = validate_workflow(&workflow);
        assert!(!report.valid);
        assert!(
            report
                .issues
                .iter()
                .any(|item| item.code == "dangling_edge")
        );
        assert!(
            report
                .issues
                .iter()
                .any(|item| item.code == "unreachable_node")
        );
    }

    #[test]
    fn rejects_unbounded_cycles_missing_roles_and_inputs() {
        let mut workflow = minimal_workflow();
        workflow.nodes.insert(1, node("agent", NodeKind::Agent));
        workflow.nodes[1].role = Some("developer".into());
        workflow.nodes[1].required_inputs.insert("task".into());
        workflow.edges = vec![
            edge("start-agent", "start", "agent"),
            edge("loop", "agent", "agent"),
        ];
        let report = validate_workflow(&workflow);
        assert!(!report.valid);
        for code in [
            "missing_role_binding",
            "missing_required_input",
            "unbounded_cycle",
        ] {
            assert!(
                report.issues.iter().any(|issue| issue.code == code),
                "missing {code}"
            );
        }
    }

    #[test]
    fn condition_uses_declared_predicate_and_default_path() {
        let mut workflow = WorkflowDefinition {
            schema_version: 1,
            name: "condition".into(),
            nodes: vec![
                node("start", NodeKind::Start),
                node("condition", NodeKind::Condition),
                node("passed", NodeKind::End),
                node("failed", NodeKind::End),
            ],
            edges: vec![
                edge("start-condition", "start", "condition"),
                WorkflowEdge {
                    id: "pass".into(),
                    source: "condition".into(),
                    target: "passed".into(),
                    is_default: false,
                    predicate: Some(ConditionPredicate {
                        field: "tests.status".into(),
                        operator: ComparisonOperator::Equals,
                        expected: Some(json!("passed")),
                    }),
                },
                WorkflowEdge {
                    id: "default".into(),
                    source: "condition".into(),
                    target: "failed".into(),
                    is_default: true,
                    predicate: None,
                },
            ],
            repeat_blocks: vec![],
            role_bindings: BTreeMap::new(),
            available_inputs: BTreeSet::new(),
            budget: WorkflowBudget::default(),
        };
        assert!(validate_workflow(&workflow).valid);
        let mut cursor = WorkflowCursor::start(&workflow).unwrap();
        cursor.advance(&workflow, &json!({})).unwrap();
        assert_eq!(
            cursor
                .advance(&workflow, &json!({"tests": {"status": "passed"}}))
                .unwrap(),
            "passed"
        );

        workflow.edges.retain(|edge| edge.id != "default");
        assert!(
            validate_workflow(&workflow)
                .issues
                .iter()
                .any(|issue| issue.code == "missing_default_path")
        );
    }

    fn minimal_workflow() -> WorkflowDefinition {
        WorkflowDefinition {
            schema_version: 1,
            name: "minimal".into(),
            nodes: vec![node("start", NodeKind::Start), node("end", NodeKind::End)],
            edges: vec![edge("edge", "start", "end")],
            repeat_blocks: vec![],
            role_bindings: BTreeMap::new(),
            available_inputs: BTreeSet::new(),
            budget: WorkflowBudget::default(),
        }
    }

    fn node(id: &str, kind: NodeKind) -> WorkflowNode {
        WorkflowNode {
            id: id.into(),
            version: 1,
            kind,
            label: id.into(),
            role: None,
            command: None,
            required_inputs: BTreeSet::new(),
        }
    }

    fn edge(id: &str, source: &str, target: &str) -> WorkflowEdge {
        WorkflowEdge {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            is_default: false,
            predicate: None,
        }
    }
}
