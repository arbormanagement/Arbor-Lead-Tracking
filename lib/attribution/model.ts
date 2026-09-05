import { getSetting, setSetting } from "@/lib/settings";

/**
 * How many days after an inquiry an estimate by the same contact still counts as its
 * result (`customer_window_days`). 30 by Justin's decision (2026-09-05): two jobs
 * written inside a month of one enquiry are two sales that enquiry produced; a repeat
 * customer's unrelated job months later is not. The matcher treats 0 as this default.
 */
export const DEFAULT_LINK_WINDOW_DAYS = 30;

export type TouchModel = "first" | "last";

/**
 * Which attribution model the dashboard is currently showing.
 *
 * Both models are computed on every rebuild and stored side by side in
 * `roi_daily` (see its `touch_type` column), so this is a **display filter, not a
 * re-derivation** — switching it is instant and nothing is recomputed. That is the
 * whole point of carrying both: the old `attribution_model` setting was an
 * either/or that re-derived everything, so the two could never be compared.
 *
 * **Every read of `roi_daily` must filter on `touch_type`.** Summing across models
 * double-counts everything, spend included, because spend is written identically to
 * both rows.
 *
 * What the two answer:
 *   last  — which channel produced THIS estimate
 *   first — which channel ACQUIRED this customer
 *
 * They differ most on repeat business, which is where the difference matters: a
 * returning customer's estimate has no new inbound contact, so `last` says
 * unattributed (correctly — no channel produced it) while `first` still credits
 * whoever won them originally.
 */
export async function selectedTouchModel(): Promise<TouchModel> {
  // Stored as the legacy "last_touch" / "first_touch" strings the Settings form
  // already writes, so switching models needs no migration of the setting itself.
  const stored = await getSetting<string>("attribution_model", "last_touch");
  return stored === "first_touch" ? "first" : "last";
}

/** Human label for the active model, for surfacing on any page that reports numbers. */
export function touchModelLabel(m: TouchModel): string {
  return m === "first" ? "First touch (acquiring channel)" : "Last touch (channel that produced the estimate)";
}

/**
 * Switch the displayed model, and optionally the customer window — the MCP
 * `set_attribution_model` tool. The settings route requires both fields (a form
 * posts both); conversationally the model alone is the common ask, so the window
 * only changes when explicitly given.
 *
 * Switching the model is instant and recomputes nothing (both models are stored
 * side by side); a changed customer window applies on the next attribution
 * rebuild — hourly, or via trigger_sync('attribution').
 */
export async function setAttributionOptions(opts: {
  model: "last_touch" | "first_touch";
  customerWindowDays?: number;
}): Promise<void> {
  await setSetting("attribution_model", opts.model);
  if (opts.customerWindowDays !== undefined) {
    await setSetting("customer_window_days", Math.round(opts.customerWindowDays));
  }
}
