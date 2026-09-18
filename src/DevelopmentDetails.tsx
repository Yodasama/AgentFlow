import { useEffect, useState } from "react";
import { getDevelopmentRun, type DevelopmentRunSnapshot, type RunDetail } from "./api";

const phaseLabels: Record<DevelopmentRunSnapshot["flow"]["phase"], string> = {
  analysis: "分析任务", development: "开发", tests: "测试", waiting_infrastructure: "等待测试环境处理",
  review: "Review", human_approval: "等待人工确认", completed: "已完成", exhausted: "已达到执行上限",
};

interface Props {
  run: RunDetail;
  busy: boolean;
  onApproval: (snapshot: DevelopmentRunSnapshot, decision: "approved" | "rejected", comment: string) => Promise<void>;
}

export function DevelopmentDetails({ run, busy, onApproval }: Props) {
  const [snapshot, setSnapshot] = useState<DevelopmentRunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");

  useEffect(() => {
    let active = true;
    setError(null);
    void getDevelopmentRun(run.runId).then((value) => {
      if (active) setSnapshot(value);
    }).catch((reason: unknown) => {
      if (active) setError(String(reason));
    });
    return () => { active = false; };
  }, [run.runId, run.runState, run.stepExecutionId, run.stepState]);

  useEffect(() => { setComment(""); }, [snapshot?.flow.candidateCommit]);

  if (error) return <p role="alert" className="error-banner">工作流详情读取失败：{error}</p>;
  if (!snapshot || snapshot.runId !== run.runId) return <p className="empty">正在读取工作流记录…</p>;
  const { flow } = snapshot;
  const canApprove = run.runState === "waiting_input" && flow.phase === "human_approval" && flow.candidateCommit !== null;
  return (
    <div className="workflow-detail">
      <p className="demo-note">Mock 演示：使用本地模拟 Agent；测试与 Review 报告不代表真实项目验收。</p>
      <dl>
        <div><dt>当前阶段</dt><dd>{phaseLabels[flow.phase]}{run.runState === "cancelled" ? "（运行已取消）" : run.runState === "interrupted" ? "（运行已中断）" : ""}</dd></div>
        <div><dt>执行预算</dt><dd>第 {flow.iteration} / {flow.maxIterations} 轮 · 已用 {flow.actionsUsed} / {flow.maxActions} 个动作</dd></div>
        <div><dt>候选版本</dt><dd className="wrap-value">{flow.candidateCommit ?? "尚未生成 Checkpoint"}</dd></div>
        <div><dt>工作流版本</dt><dd className="wrap-value">{flow.workflowDigest}</dd></div>
      </dl>
      {flow.testHistory.length > 0 && <section className="report-section" aria-label="测试记录">
        <h3>测试记录</h3>
        {flow.testHistory.map((report, index) => <article className="report" key={`${index}-${report.testedCommit}`}>
          <strong>测试 {index + 1} · {{ passed: "通过", failed: "失败，进入返工", infrastructure_error: "环境异常" }[report.status]}</strong>
          <p>{report.summary}</p><code>{report.testedCommit}</code>
          {report.failures.length > 0 && <ul>{report.failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul>}
        </article>)}
      </section>}
      {flow.reviewHistory.length > 0 && <section className="report-section" aria-label="Review 记录">
        <h3>Review 记录</h3>
        {flow.reviewHistory.map((report, index) => <article className="report" key={`${index}-${report.reviewedCommit}`}>
          <strong>Review {index + 1} · {report.verdict === "approved" ? "通过" : "要求修改"}</strong>
          <p>{report.summary}</p><code>{report.reviewedCommit}</code>
          {report.findings.length > 0 && <ul>{report.findings.map((finding, i) => <li key={i}>{finding.file}:{finding.line} · {finding.severity === "blocking" ? "阻断" : "提示"} · {finding.message}</li>)}</ul>}
        </article>)}
      </section>}
      {canApprove && <form className="approval-panel" onSubmit={(event) => {
        event.preventDefault();
        void onApproval(snapshot, "approved", comment.trim());
      }}>
        <h3>确认当前候选版本</h3>
        <p>批准只对上方候选 SHA 与工作流版本生效，不会合并回源分支。</p>
        <label>审批意见（要求返工时必填）<textarea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} disabled={busy} /></label>
        <div className="detail-actions">
          <button className="primary" disabled={busy} type="submit">批准当前版本</button>
          <button className="secondary" disabled={busy || !comment.trim()} type="button" onClick={() => void onApproval(snapshot, "rejected", comment.trim())}>要求返工</button>
        </div>
      </form>}
      {flow.approvalHistory.length > 0 && <section className="report-section" aria-label="人工确认记录">
        <h3>人工确认记录</h3>
        {flow.approvalHistory.map((approval, index) => <article className="report" key={index}>
          <strong>{approval.decision === "approved" ? "已批准" : "已要求返工"}</strong><p>{approval.comment || "未填写意见"}</p><code>{approval.candidateCommit}</code>
        </article>)}
      </section>}
    </div>
  );
}
