import React, { useState, useMemo } from "react";
import {
  computeHeatmapGrid,
  formatTokenNumber,
  DayUsage,
} from "./tokenTracker";

export interface TokenHeatmapProps {
  usage: Record<string, number>;
  className?: string;
  onSelectDay?: (day: DayUsage) => void;
}

export function TokenHeatmap({ usage, className = "" }: TokenHeatmapProps) {
  const [hoveredDay, setHoveredDay] = useState<{
    day: DayUsage;
    x: number;
    y: number;
  } | null>(null);

  const { weeks, monthLabels } = useMemo(() => {
    return computeHeatmapGrid(usage, "daily");
  }, [usage]);

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>, day: DayUsage | null) => {
    if (!day) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setHoveredDay({
      day,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const handleMouseLeave = () => {
    setHoveredDay(null);
  };

  return (
    <div className={`token-activity-card ${className}`}>
      {/* Top Header Row */}
      <div className="token-activity-header">
        <div className="token-activity-title">Token 活动</div>
        <span className="token-activity-period">每日</span>
      </div>

      {/* Heatmap Grid Container */}
      <div className="token-heatmap-scroll-container">
        <div className="token-heatmap-wrapper">
          {/* 52 Columns Grid */}
          <div className="token-heatmap-grid">
            {weeks.map((week) => (
              <div key={week.weekIndex} className="token-heatmap-col">
                {week.days.map((day, dIdx) => {
                  if (!day) {
                    return (
                      <div
                        key={`empty-${dIdx}`}
                        className="token-cell token-cell-empty"
                      />
                    );
                  }
                  return (
                    <div
                      key={day.dateStr}
                      className={`token-cell level-${day.level}`}
                      onMouseEnter={(e) => handleMouseEnter(e, day)}
                      onMouseLeave={handleMouseLeave}
                    />
                  );
                })}
              </div>
            ))}
          </div>

          {/* Month Labels Axis */}
          <div className="token-heatmap-months-axis">
            {monthLabels.map((m, idx) => (
              <span
                key={`${m.label}-${idx}`}
                className="token-month-label"
                style={{
                  left: `calc(${m.colIndex} * (100% / 52))`,
                }}
              >
                {m.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Floating Hover Tooltip (Matching Screenshot) */}
      {hoveredDay && (
        <div
          className="token-heatmap-tooltip"
          style={{
            left: `${hoveredDay.x}px`,
            top: `${hoveredDay.y - 38}px`,
          }}
        >
          {`${hoveredDay.day.month}月${hoveredDay.day.day}日 使用了 ${formatTokenNumber(hoveredDay.day.tokens)} 个 Token`}
        </div>
      )}
    </div>
  );
}
