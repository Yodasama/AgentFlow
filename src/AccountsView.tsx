import { useEffect, useState, useCallback } from "react";
import { getAccountStates, type AccountOverview } from "./api";

export function AccountsView() {
  const [data, setData] = useState<AccountOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAccountStates();
      setData(res);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const globalLimit = data?.globalConcurrencyLimit ?? 3;
  const activeAttempts = Array.from(new Set(data?.activeLocks.map((l) => l.attemptId) ?? []));

  return (
    <div className="accounts-view-container">
      <div className="accounts-header">
        <div>
          <h2>Agent 账号与并发治理 (P4 / P8)</h2>
          <p className="subtitle">
            本地多 Agent 互斥锁控制：同账号串行调度、不同账号受控并行（全局上限 {globalLimit} 个 Attempt 并发）
          </p>
        </div>
        <button className="secondary" type="button" disabled={loading} onClick={() => void refresh()}>
          {loading ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {error && <p role="alert" className="error-banner">{error}</p>}

      <section className="concurrency-governance-panel">
        <div className="panel-heading">
          <h3>全局并发通道监控 (Global Limit: {globalLimit})</h3>
          <span className="status-tag">
            {activeAttempts.length} / {globalLimit} 占用中
          </span>
        </div>
        <div className="slots-grid">
          {Array.from({ length: globalLimit }).map((_, index) => {
            const attemptId = activeAttempts[index];
            const isOccupied = Boolean(attemptId);
            return (
              <div key={index} className={`slot-card ${isOccupied ? "occupied" : "idle"}`}>
                <div className="slot-title">
                  <strong>Slot #{index + 1}</strong>
                  <span className={`badge ${isOccupied ? "busy" : "ready"}`}>
                    {isOccupied ? "执行占用" : "就绪空闲"}
                  </span>
                </div>
                {isOccupied ? (
                  <div className="slot-detail">
                    <p>Attempt ID:</p>
                    <code>{attemptId?.slice(0, 18)}…</code>
                  </div>
                ) : (
                  <p className="slot-empty">等待调度器分发任务…</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="accounts-grid-panel">
        <div className="panel-heading">
          <h3>配置的 Agent 适配器槽位 ({data?.accounts.length ?? 0})</h3>
        </div>
        <div className="accounts-grid">
          {data?.accounts.map((acc) => (
            <article key={acc.accountId} className="account-card">
              <div className="account-card-header">
                <div>
                  <h4>{acc.displayName}</h4>
                  <code className="account-id">{acc.accountId}</code>
                </div>
                <span className={`state-badge ${acc.isLocked ? "locked" : "idle"}`}>
                  {acc.isLocked ? "执行锁持有中" : "空闲可用"}
                </span>
              </div>
              <dl>
                <div>
                  <dt>工作流角色</dt>
                  <dd>{acc.role}</dd>
                </div>
                <div>
                  <dt>驱动 Provider</dt>
                  <dd>{acc.provider}</dd>
                </div>
                <div>
                  <dt>当前持有锁</dt>
                  <dd>
                    {acc.lockedByAttemptId ? (
                      <code>Attempt: {acc.lockedByAttemptId.slice(0, 10)}…</code>
                    ) : (
                      "无"
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="locks-table-panel">
        <div className="panel-heading">
          <h3>SQLite 活跃资源排他锁 (Resource Locks: {data?.activeLocks.length ?? 0})</h3>
        </div>
        {data?.activeLocks.length === 0 ? (
          <p className="empty">当前数据库中无活跃资源锁，所有 Agent 账号与工作区均处于空闲就绪状态。</p>
        ) : (
          <div className="table-wrapper">
            <table className="locks-table">
              <thead>
                <tr>
                  <th>资源类型</th>
                  <th>锁定资源 ID</th>
                  <th>持有 Attempt ID</th>
                  <th>锁获取时间</th>
                </tr>
              </thead>
              <tbody>
                {data?.activeLocks.map((lock, idx) => (
                  <tr key={idx}>
                    <td>
                      <span className={`tag ${lock.resourceType}`}>{lock.resourceType}</span>
                    </td>
                    <td><code>{lock.resourceId}</code></td>
                    <td><code>{lock.attemptId}</code></td>
                    <td>{new Date(lock.acquiredAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
