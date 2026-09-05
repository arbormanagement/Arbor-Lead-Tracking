import { isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, leads } from "@/lib/db/schema";
import { CANCELLED_STATUSES } from "@/lib/estimates/countable";

/**
 * An inquiry's STAGE and VALUE, derived from the estimates it produced — never stored.
 *
 * Until 2026-09-05 `leads` carried `status`, `quote_value_cents` and `sales_value_cents`:
 * the estimate's lifecycle copied onto the enquiry by the attribution sync, a leftover
 * of the WhatConverts-shaped model where the lead row was the only place a value could
 * live. This app has a real opportunity table, so those were a second copy of one fact,
 * kept in step by a sync — exactly the shape `location` was retired for in 0046.
 *
 * Since migration 0057 the link is `hcp_estimates.lead_id` — MANY estimates to one
 * inquiry — so the derivation is a ROLLUP over all of them, not a case over one row.
 * Every expression here takes the rollup returned by `leadEstimateRollup()` and composes
 * only into a query that `leftJoin(est, eq(est.leadId, leads.id))`. Same rule as
 * `lib/estimates/countable.ts`: one definition, pushed down, shared by every reader.
 *
 * The labels are the old `status` vocabulary so nothing downstream has to relearn
 * them; only their source changed. `working` and `duplicate` were never set.
 */

/** HCP marks a cancelled estimate on `work_status`; `coalesce` so a NULL status can never make a predicate NULL. */
export const estimateCancelledSql: SQL<boolean> = sql`coalesce(${hcpEstimates.status}, '') in (${sql.join(
  CANCELLED_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)})`;

/**
 * One row per inquiry that has at least one estimate: how many, in which states, and
 * what they add up to. Built fresh per query (it closes over `db`), aliased
 * `lead_estimates`. Join it LEFT: an inquiry with no estimate has no row here, and
 * `leadId IS NULL` is what the stage reads as `new`.
 *
 * The sums are the point of the rollup. One inquiry that produced two won jobs is
 * worth both of them; the old single link could only ever report one, and the second
 * read as untracked business.
 */
export function leadEstimateRollup() {
  const live = sql`not (${estimateCancelledSql})`;
  return db
    .select({
      leadId: hcpEstimates.leadId,
      estimates: sql<number>`count(*)::int`.as("estimates"),
      won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`.as("won"),
      /** Still undecided and not cancelled — the ones that keep an inquiry open. */
      open: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'open' and ${live})::int`.as("open"),
      openPriced: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'open' and ${live} and coalesce(${hcpEstimates.totalAmountCents}, 0) > 0)::int`.as("open_priced"),
      lost: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'lost')::int`.as("lost"),
      /** Approved value of the won estimates (falling back to the total where an approval carries none). */
      wonQuoteCents: sql<number | null>`sum(coalesce(nullif(${hcpEstimates.approvedAmountCents}, 0), nullif(${hcpEstimates.totalAmountCents}, 0))) filter (where ${hcpEstimates.outcome} = 'won')::int`.as("won_quote_cents"),
      liveTotalCents: sql<number | null>`sum(nullif(${hcpEstimates.totalAmountCents}, 0)) filter (where ${live})::int`.as("live_total_cents"),
      allTotalCents: sql<number | null>`sum(nullif(${hcpEstimates.totalAmountCents}, 0))::int`.as("all_total_cents"),
      /** The only ROI revenue: approved amounts on won estimates. NULL until something is won. */
      salesCents: sql<number | null>`sum(coalesce(${hcpEstimates.approvedAmountCents}, 0)) filter (where ${hcpEstimates.outcome} = 'won')::int`.as("sales_cents"),
      /** When the office first wrote an estimate for this inquiry — the `qualified` conversion. */
      firstCreatedAt: sql<Date | null>`min(${hcpEstimates.createdAtHcp})`.as("first_created_at"),
      /** The first appointment actually booked, cancelled ones excluded — the `scheduled` conversion. */
      firstScheduledAt: sql<Date | null>`min(${hcpEstimates.scheduledStartHcp}) filter (where ${live})`.as("first_scheduled_at"),
      /** When the first of them was approved — the `won` conversion. */
      firstApprovedAt: sql<Date | null>`min(${hcpEstimates.approvedAtHcp}) filter (where ${hcpEstimates.outcome} = 'won')`.as("first_approved_at"),
      /** This app's estimate ids, oldest first. */
      ids: sql<string[]>`array_agg(${hcpEstimates.id} order by ${hcpEstimates.createdAtHcp} nulls last, ${hcpEstimates.id})`.as("ids"),
    })
    .from(hcpEstimates)
    .where(isNotNull(hcpEstimates.leadId))
    .groupBy(hcpEstimates.leadId)
    .as("lead_estimates");
}

export type LeadEstimateRollup = ReturnType<typeof leadEstimateRollup>;

/**
 * Stage precedence across several estimates: a win anywhere is a win; otherwise a
 * LIVE open estimate outranks a cancelled or lost duplicate (the office cancels the
 * duplicate and keeps the first, so the survivor is the truth); otherwise lost;
 * otherwise everything was cancelled.
 */
export const leadStageSql = (est: LeadEstimateRollup): SQL<string> => sql`case
    when ${leads.isSpam} then 'spam'
    when ${est.leadId} is null then 'new'
    when ${est.won} > 0 then 'won'
    when ${est.openPriced} > 0 then 'quoted'
    when ${est.open} > 0 then 'qualified'
    when ${est.lost} > 0 then 'lost'
    else 'cancelled'
  end`;

/** What was quoted: the approved amounts once won (add-ons sum there), else the live totals, else any total. NULL until priced. */
export const leadQuoteCentsSql = (est: LeadEstimateRollup): SQL<number | null> => sql`case
    when ${est.leadId} is null then null
    when ${est.won} > 0 then ${est.wonQuoteCents}
    else coalesce(${est.liveTotalCents}, ${est.allTotalCents})
  end`;

/** What was sold: the approved amounts on won estimates, NULL otherwise. The only ROI revenue. */
export const leadSalesCentsSql = (est: LeadEstimateRollup): SQL<number | null> => sql`case
    when ${est.won} > 0 then ${est.salesCents}
    else null
  end`;

/**
 * Still in flight: not spam, and either no estimate yet or one nobody has decided.
 * A follow-up text or call joins such an inquiry; contact after every estimate was
 * won, lost or cancelled is new business and starts its own — "one thread, many
 * inquiries".
 */
export const isOpenLead = (est: LeadEstimateRollup): SQL<boolean> => sql`${leads.isSpam} = false
  and (${est.leadId} is null or ${est.open} > 0)`;
