/**
 * Business-timezone day bucketing. Ad platforms report spend per account-timezone
 * day (America/Chicago for Arbor), so anything aggregated alongside spend must use
 * the same day boundary — a 10pm CT lead is "tomorrow" in UTC and would land on
 * the wrong roi_daily row if bucketed by toISOString().
 */
export const BUSINESS_TZ = "America/Chicago";

// en-CA formats as YYYY-MM-DD directly — no formatToParts reassembly needed.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of `d` in the business timezone. */
export function businessDate(d: Date): string {
  return fmt.format(d);
}
