import { sql, type SQL } from "drizzle-orm";
import { hcpEstimates, leads } from "@/lib/db/schema";
import { CANCELLED_STATUSES } from "@/lib/estimates/countable";

/**
 * An enquiry's STAGE, derived from the estimate it produced — never stored.
 *
 * Until 2026-09-05 `leads` carried `status`, `quote_value_cents` and `sales_value_cents`:
 * the estimate's lifecycle copied onto the enquiry by the attribution sync, a leftover
 * of the WhatConverts-shaped model where the lead row was the only place a value could
 * live. This app has a real opportunity table, so those were a second copy of one fact,
 * kept in step by a sync — exactly the shape `location` was retired for in 0046.
 *
 * Every expression here composes ONLY into a query that
 * `leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))`. Same rule as
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

export const leadStageSql: SQL<string> = sql`case
    when ${leads.isSpam} then 'spam'
    when ${hcpEstimates.id} is null then 'new'
    when ${hcpEstimates.outcome} = 'won' then 'won'
    when ${estimateCancelledSql} then 'cancelled'
    when ${hcpEstimates.outcome} = 'lost' then 'lost'
    when coalesce(${hcpEstimates.totalAmountCents}, 0) > 0 then 'quoted'
    else 'qualified'
  end`;

/** What was quoted: the approved amount once won (add-ons sum there), else the estimate total. NULL until priced. */
export const leadQuoteCentsSql: SQL<number | null> = sql`case
    when ${hcpEstimates.id} is null then null
    when ${hcpEstimates.outcome} = 'won'
      then coalesce(nullif(${hcpEstimates.approvedAmountCents}, 0), nullif(${hcpEstimates.totalAmountCents}, 0))
    else nullif(${hcpEstimates.totalAmountCents}, 0)
  end`;

/** What was sold: the approved amount on a won estimate, NULL otherwise. The only ROI revenue. */
export const leadSalesCentsSql: SQL<number | null> = sql`case
    when ${hcpEstimates.outcome} = 'won' then coalesce(${hcpEstimates.approvedAmountCents}, 0)
    else null
  end`;

/**
 * Still in flight: not spam, and either no estimate yet or one nobody has decided.
 * A follow-up text joins such a lead; contact after a won/lost/cancelled estimate is
 * new business and starts its own — "one thread, many leads".
 */
export const isOpenLead: SQL<boolean> = sql`${leads.isSpam} = false
  and (${hcpEstimates.id} is null
       or (${hcpEstimates.outcome} = 'open' and not (${estimateCancelledSql})))`;
