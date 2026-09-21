export interface DayUsage {
  dateStr: string;
  month: number;
  day: number;
  weekday: number;
  tokens: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface WeekColumn {
  weekIndex: number;
  days: DayUsage[];
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export function formatTokenNumber(tokens: number | null | undefined): string {
  if (tokens == null) return "不可用";
  if (tokens >= 100_000_000) return `${(tokens / 100_000_000).toFixed(1)}亿`;
  if (tokens >= 10_000) return `${(tokens / 10_000).toFixed(1)}万`;
  return tokens.toLocaleString();
}

export function getTokenLevel(tokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0;
  if (tokens < 2_000_000) return 1;
  if (tokens < 15_000_000) return 2;
  if (tokens < 60_000_000) return 3;
  return 4;
}

export function computeHeatmapGrid(
  map: Record<string, number>,
  viewMode: "daily" | "weekly" | "cumulative",
): { weeks: WeekColumn[]; monthLabels: { label: string; colIndex: number }[] } {
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(today.getDate() + (6 - today.getDay()));
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - 52 * 7 + 1);
  const weeks: WeekColumn[] = [];
  const monthLabels: { label: string; colIndex: number }[] = [];
  let lastMonth = -1;
  let cumulative = 0;
  let days: DayUsage[] = [];
  let weekTokens = 0;

  for (let index = 0; index < 52 * 7; index += 1) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + index);
    const dateStr = date.toLocaleDateString("en-CA");
    const tokens = map[dateStr] || 0;
    cumulative += tokens;
    const month = date.getMonth() + 1;
    const colIndex = Math.floor(index / 7);
    if (date.getDate() <= 7 && month !== lastMonth && colIndex >= 1 && colIndex <= 50) {
      monthLabels.push({ label: `${month}月`, colIndex });
      lastMonth = month;
    }
    days.push({
      dateStr,
      month,
      day: date.getDate(),
      weekday: date.getDay(),
      tokens,
      level: getTokenLevel(viewMode === "cumulative" ? cumulative : tokens),
    });
    weekTokens += tokens;
    if (date.getDay() === 6 || index === 52 * 7 - 1) {
      weeks.push({ weekIndex: weeks.length, days, totalTokens: weekTokens, level: getTokenLevel(weekTokens) });
      days = [];
      weekTokens = 0;
    }
  }
  return { weeks, monthLabels };
}
