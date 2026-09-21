import React, { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { TokenHeatmap } from "./TokenHeatmap";
import { IconSettings } from "./icons";
import { getCachedCliTokenStats, getRealCliTokenStats, RateLimitWindow, RealCliTokenStats } from "./api";

export interface TokenUsageViewProps {
  onOpenProviderModal?: () => void;
}

const TOKEN_STATS_CACHE_KEY = "agentflow_real_cli_token_stats_v1";

function loadCachedStats(): RealCliTokenStats | null {
  try {
    const raw = localStorage.getItem(TOKEN_STATS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RealCliTokenStats;
    if (!parsed?.codex || !Array.isArray(parsed.agyAccounts)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatResetTime(value: number | string | undefined | null): { text: string; full: string; isPast: boolean } {
  if (!value) return { text: "随周期刷新", full: "随服务周期刷新", isPast: false };
  const timestampMs = typeof value === "number" ? (value > 1e11 ? value : value * 1000) : new Date(value).getTime();
  if (Number.isNaN(timestampMs) || timestampMs <= 0) {
    return { text: "随周期刷新", full: "随服务周期刷新", isPast: false };
  }
  const now = Date.now();
  const diffMs = timestampMs - now;
  const date = new Date(timestampMs);
  const timeStr = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dateStr = date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  const full = `${dateStr} ${timeStr}`;

  if (diffMs <= 0) {
    return { text: "已到期 (调用即刷新)", full, isPast: true };
  }

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMinutes / 60);
  const remainingMinutes = diffMinutes % 60;
  const diffDays = Math.floor(diffHours / 24);
  const remainingHours = diffHours % 24;

  if (diffDays > 0) {
    return { text: `${diffDays}天${remainingHours > 0 ? `${remainingHours}时` : ""}后重置`, full, isPast: false };
  }
  if (diffHours > 0) {
    return { text: `${diffHours}小时${remainingMinutes > 0 ? `${remainingMinutes}分` : ""}后重置`, full, isPast: false };
  }
  return { text: `${Math.max(1, diffMinutes)}分钟后重置`, full, isPast: false };
}

function QuotaWindow({ window }: { window: RateLimitWindow }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const remaining = 100 - used;
  const resetInfo = formatResetTime(window.resetsAt);
  return (
    <div className="quota-stat">
      <div className="quota-gauge" style={{ "--quota-value": `${remaining * 3.6}deg` } as CSSProperties}>
        <span>{remaining.toFixed(0)}%</span>
      </div>
      <div className="quota-stat-label">{window.windowDurationMins === 300 ? "5h 限额" : "一周限额"}</div>
      <div className="quota-reset-time" title={`预计重置时刻：${resetInfo.full}`}>
        {resetInfo.text}
      </div>
    </div>
  );
}

function AgyQuotaWindow({ window, remainingFraction, resetTime }: { window: string; remainingFraction: number; resetTime: string }) {
  const remaining = Math.max(0, Math.min(100, remainingFraction * 100));
  const resetInfo = formatResetTime(resetTime);
  return (
    <div className="quota-stat">
      <div className="quota-gauge" style={{ "--quota-value": `${remaining * 3.6}deg` } as CSSProperties}>
        <span>{remaining.toFixed(0)}%</span>
      </div>
      <div className="quota-stat-label">{window === "5h" ? "5h 限额" : "一周限额"}</div>
      <div className="quota-reset-time" title={`预计重置时刻：${resetInfo.full}`}>
        {resetInfo.text}
      </div>
    </div>
  );
}

export function TokenUsageView({ onOpenProviderModal }: TokenUsageViewProps) {
  const [cachedStats] = useState(loadCachedStats);
  const [stats, setStats] = useState<RealCliTokenStats | null>(cachedStats);
  const [loading, setLoading] = useState(cachedStats === null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const latest = await getRealCliTokenStats();
      setStats(latest);
      localStorage.setItem(TOKEN_STATS_CACHE_KEY, JSON.stringify(latest));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      if (!cachedStats) {
        try {
          const cached = await getCachedCliTokenStats();
          if (!cancelled && cached) setStats(cached);
        } catch {
          // The live refresh below remains the source of truth.
        }
      }
      if (!cancelled) void refresh();
    };
    void initialize();
    const timer = window.setInterval(() => void refresh(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cachedStats, refresh]);

  const usage = useMemo(() => {
    const combined = { ...(stats?.codex.dailyUsage ?? {}) };
    for (const account of stats?.agyAccounts ?? []) {
      for (const [date, tokens] of Object.entries(account.dailyUsage)) {
        combined[date] = (combined[date] || 0) + tokens;
      }
    }
    return combined;
  }, [stats]);

  return (
    <div className="token-usage-view">
      <div className="token-view-header">
        <div>
          <h1 className="token-view-title">用量与账户余额</h1>
          <p className="token-view-subtitle">Token 活动与 CLI 配额，每 5 分钟更新。</p>
        </div>
        <div className="token-header-launch-actions">
          <button type="button" className="token-direct-call-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "更新中" : "刷新"}
          </button>
          {onOpenProviderModal && (
            <button type="button" className="token-manage-providers-btn" onClick={onOpenProviderModal}>
              <IconSettings size={14} stroke="#3a3a3c" />
              <span>账户</span>
            </button>
          )}
        </div>
      </div>

      {error && <div className="token-data-error">无法读取官方数据：{error}</div>}

      <div className="token-section-block"><TokenHeatmap usage={usage} /></div>

      <div className="token-section-block">
        <div className="token-section-title-row">
          <div className="token-section-title">CLI 账户余额</div>
          {stats && <div className="token-section-desc">{new Date(stats.codex.refreshedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 更新</div>}
        </div>
        <div className="token-simple-quota-grid">
          {loading && !stats ? (
            Array.from({ length: 4 }, (_, index) => (
              <div className="token-simple-quota-card token-quota-skeleton" key={index} aria-hidden="true">
                <span />
                <div><i /><i /></div>
              </div>
            ))
          ) : <div className="token-simple-quota-card">
            <div className="token-card-header-row">
              <span className="token-simple-quota-name">Codex</span>
            </div>
            <div className="quota-stat-grid">
              {stats?.codex.primary && <QuotaWindow window={stats.codex.primary} />}
              {stats?.codex.secondary && <QuotaWindow window={stats.codex.secondary} />}
            </div>
            {stats?.codex.credits && (
              <div className="quota-credit-badge">
                <span>额度状态: {stats.codex.credits.unlimited ? "无限额限制" : stats.codex.credits.balance ? `$${stats.codex.credits.balance}` : "标准配额"}</span>
                {stats.codex.planType && <span className="quota-plan-pill">{stats.codex.planType.toUpperCase()} 方案</span>}
              </div>
            )}
            {!loading && !stats?.codex.primary && <div className="token-unavailable">官方接口未返回限额窗口</div>}
          </div>}
          {stats?.agyAccounts.map((account, index) => (
            <div className="token-simple-quota-card" key={account.providerId}>
              <div className="token-card-header-row">
                <span className="token-simple-quota-name">agy 账号 {index + 1}</span>
              </div>
              {account.available ? (
                <>
                  {account.quotaGroups.map((group) => (
                    <div className="agy-quota-group" key={group.name}>
                      <div className="agy-quota-group-name">{group.name === "Gemini Models" ? "Gemini" : "Claude + GPT"}</div>
                      <div className="quota-stat-grid">
                        {[...group.buckets]
                          .sort((left, right) => Number(right.window === "5h") - Number(left.window === "5h"))
                          .map((bucket) => <AgyQuotaWindow key={bucket.id} window={bucket.window} remainingFraction={bucket.remainingFraction} resetTime={bucket.resetTime} />)}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="token-unavailable">{account.error || "暂时无法读取配额"}</div>
              )}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
