/** Dashboard timeframe presets, selected via a `?days=` URL param. */
export const TIMEFRAMES = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "12 mo" },
] as const;

export function pickDays(param: string | undefined, fallback: number): number {
  const n = Number(param);
  return TIMEFRAMES.some((t) => t.days === n) ? n : fallback;
}

export function timeframeLabel(days: number): string {
  return days === 365 ? "last 12 months" : `last ${days} days`;
}
