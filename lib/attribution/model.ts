import { getSetting } from "@/lib/settings";

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
