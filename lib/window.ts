import { BUSINESS_TZ, parseWallTime } from "@/lib/tz";

/**
 * The query window for the raw-table list tools — estimates, jobs, invoices.
 *
 * `days` answers "what came in recently" and is what almost every caller wants.
 * `start`/`end` answer "what happened in THAT period", which `days` cannot express
 * at all: a window ending in the past — last August, Q3, the same week a year ago —
 * is not reachable by counting back from now, and pulling a year of rows to look at
 * one week of them is not a workaround, it is a slower wrong answer.
 *
 * **Only for tools that read the raw HousecallPro tables.** Anything backed by
 * `roi_daily`, or that puts ad spend beside attributed outcomes, keeps its 365-day
 * cap: spend is complete for any window, attribution only exists from
 * `TRACKING_STARTED_AT` (2026-08-08), and a longer window silently divides one by
 * the other. Estimates, jobs and invoices carry no such hazard — they are synced
 * from HousecallPro back to 2017 and mean the same thing at any depth. The estimate
 * list additionally reports `agg.createdBeforeTracking`, so a caller reaching past
 * the cutover can see how much of its window predates tracking.
 *
 * ## Bounds
 *
 * A bare `YYYY-MM-DD` means the WHOLE day in America/Chicago, inclusive at both
 * ends — `start: "2025-08-01", end: "2025-08-31"` is all of August, with the 31st
 * in it. This deliberately matches the HousecallPro tools' convention rather than
 * the half-open one: HCP originally read a bare `*_max` as midnight, which dropped
 * everything on the final day with no error and no missing-data signal, and had to
 * be fixed (Arbor-MCP-Server #178). Repeating that trap here would be worse, since
 * the two sit side by side in the same reports.
 *
 * A full ISO-8601 timestamp is used exactly as given, so a caller who wants the
 * half-open `[start, end)` shape can still have it by passing times.
 *
 * Business timezone, not UTC: a 7pm CT estimate is "tomorrow" in UTC, so a
 * UTC-bucketed August would take a slice out of the 1st and add one to the 31st.
 */
export interface WindowInput {
  days?: number;
  start?: string;
  end?: string;
}

export interface ResolvedWindow {
  /** Inclusive lower bound. */
  since: Date;
  /** Inclusive upper bound, or null for "up to now". */
  until: Date | null;
  /** True when the caller gave an explicit range rather than a rolling window. */
  explicit: boolean;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function bound(value: string, edge: "start" | "end"): Date {
  if (DATE_ONLY.test(value)) {
    const wall = edge === "start" ? `${value} 00:00:00` : `${value} 23:59:59`;
    const at = parseWallTime(wall, BUSINESS_TZ);
    if (!at) throw new Error(`Could not read "${value}" as a date`);
    // 23:59:59 + 999ms — the last instant of the day, so a row stamped
    // 23:59:59.500 is inside its own day rather than silently outside it.
    return edge === "start" ? at : new Date(at.getTime() + 999);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error(`Could not read "${value}" as a date`);
  return at;
}

/**
 * Resolve a window, applying `defaultDays` when the caller gave nothing.
 *
 * Throws when `days` is combined with `start`/`end`. Silently letting one win is
 * how a caller ends up reading a window it did not ask for and cannot see is
 * wrong — the tool schemas say the two are alternatives, so a request using both
 * is a caller bug worth surfacing loudly.
 */
export function resolveWindow(input: WindowInput, defaultDays: number): ResolvedWindow {
  const { days, start, end } = input;

  if (start != null || end != null) {
    if (days != null) {
      throw new Error("Pass either `days` (a rolling window) or `start`/`end` (a fixed period) — not both.");
    }
    const since = start != null ? bound(start, "start") : new Date(0);
    const until = end != null ? bound(end, "end") : null;
    if (until && until < since) {
      throw new Error(`\`end\` (${end}) falls before \`start\` (${start}).`);
    }
    return { since, until, explicit: true };
  }

  return { since: new Date(Date.now() - (days ?? defaultDays) * 86_400_000), until: null, explicit: false };
}
