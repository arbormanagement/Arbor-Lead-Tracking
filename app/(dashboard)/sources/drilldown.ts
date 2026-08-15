import { DEFAULT_DAYS as ESTIMATES_DEFAULT_DAYS } from "../estimates/view";
import type { FILTER_KEYS } from "../estimates/filters";

/**
 * Link from a /sources row to the estimates behind it.
 *
 * The two pages are two directions through one join — an estimate reaches a source
 * only via `leads.hcp_estimate_id` → `leads.source_id` — and this is the direction
 * that was missing: you could see that Google Ads produced eleven estimates and had
 * no way to ask which eleven.
 *
 * **The timeframe is carried across but the numbers still will not match exactly, and
 * that is not a bug to chase.** /sources counts from `roi_daily`, which buckets an
 * estimate on the CONTACT's date so it sits beside the spend that produced it;
 * /estimates windows on when the estimate was CREATED. A click that landed on the
 * 1st and an estimate written on the 3rd fall in different buckets at a window edge.
 * Both are right for their own question — see lib/estimates/countable.ts — so the
 * drill-down is "these estimates", not "this exact count re-listed".
 */
export function estimateDrilldown(
  filters: Partial<Record<(typeof FILTER_KEYS)[number], string>>,
  days: number,
): string {
  const q = new URLSearchParams();
  if (days !== ESTIMATES_DEFAULT_DAYS) q.set("days", String(days));
  for (const [k, v] of Object.entries(filters)) {
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `/estimates?${s}` : "/estimates";
}
