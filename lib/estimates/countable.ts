import { and, isNotNull, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { hcpEstimates } from "@/lib/db/schema";

/**
 * Estimate work_status values that mean the appointment never happened. HCP's
 * vocabulary, verified against the live account: a cancelled estimate is
 * administrative debris, not a customer who said no.
 *
 * Note this is NOT the same vocabulary as invoices, which cancel as
 * `canceled` / `voided`. Each HCP entity has its own; do not generalise from
 * this one.
 */
export const CANCELLED_STATUSES = ["pro canceled", "user canceled"];

/**
 * "Does this estimate count as a sales opportunity?" — the one predicate behind
 * every estimate metric, so no two surfaces can disagree about the denominator.
 *
 * Two conditions, both load-bearing:
 *  1. it was actually scheduled (`scheduled_start_hcp IS NOT NULL`) — an estimate
 *     nobody booked a visit for was never sold;
 *  2. it was not cancelled — a cancelled appointment did not happen.
 *
 * **This is copied from the business's existing reporting, not invented**
 * (`arbor-reporting/server/storage.ts`, `getEstimatePivotMulti`). It is the rule the
 * team's numbers already run on, and getting it wrong is not a rounding error:
 *
 *   Feb 2026, every HCP record ....... 114 estimates, 29 won → 25%
 *   Feb 2026, this predicate .......... 60 estimates, 29 won → 48%
 *
 * Same wins both ways. The denominator is the entire difference, and 25% is not a
 * close rate — roughly 45 of those 114 rows are cancelled, including thirteen
 * created inside forty minutes on Feb 11, which is one person doing a cleanup
 * rather than thirteen customers declining.
 *
 * The trap this exists to prevent: this app now holds the COMPLETE 15,234-row HCP
 * history, so anything counting `hcp_estimates` without this predicate silently
 * reports the wrong number while looking perfectly correct.
 *
 * Cancelled estimates are not deleted — they stay queryable, and they are the right
 * population for asking "how many appointments are we losing before we get there?",
 * which is a real operational question. They just are not opportunities.
 */
export const isCountableEstimate: SQL = and(
  isNotNull(hcpEstimates.scheduledStartHcp),
  // `status IS NULL OR status NOT IN (...)` — spelled out because SQL NULL is not
  // false, so a bare NOT IN would silently drop every estimate with no work_status.
  or(isNull(hcpEstimates.status), notInArray(hcpEstimates.status, CANCELLED_STATUSES)),
)!;

/**
 * The date an estimate belongs to for reporting: **the appointment, not the
 * creation**. Close rate windows and cohorts group on this.
 *
 * Deliberately different from `roi_daily`, which buckets on the CONTACT date so
 * spend and outcomes land on the same day as the click that produced them. Both are
 * correct for their own question and they are easy to conflate:
 *
 *   roi_daily  → "what did the ads we ran that day produce?"     (contact date)
 *   close rate → "of the visits we ran that month, what closed?"  (appointment date)
 *
 * A cohort built on `created_at` is a different population from one built on
 * `scheduled_start` and the two will never reconcile.
 */
export const REPORTING_DATE = hcpEstimates.scheduledStartHcp;
