/**
 * The repair path for review enrolment — the `thread-backfill` of this feature.
 *
 * Enrolment hangs on one HCP `invoice.paid` webhook per paid invoice, and a
 * webhook that never arrives leaves NO trace: no row, no error, no failed run.
 * The only way to see it is to ask the question from the other side — which
 * paid invoices have no review request? — which is exactly what this does.
 *
 * It is not hypothetical. Across the Arbor-Automations cutover (2026-08-31) the
 * old app had stopped sending and this one was not yet receiving; a $2,975 Tree
 * Service invoice was paid inside that window and its customer was never asked
 * for a review. Nothing in the app could have surfaced that, and nothing would
 * have surfaced the next one either.
 *
 * Four things bound it, because a sweep that enrols in bulk is a sweep that can
 * text a hundred people at once:
 *
 *  1. a WINDOW — invoices paid in the last `BACKFILL_WINDOW_DAYS`, so it can
 *     never reach back into history and re-ask a customer from last year;
 *  2. a GRACE — invoices paid in the last few minutes are left alone, so the
 *     sweep repairs the webhook rather than racing it;
 *  3. a CAP per run, so even a wrong answer arrives slowly enough to catch;
 *  4. `enrollReviewRequest`, which re-checks every eligibility and dedupe rule
 *     including "was this person already asked this month" — the guard that
 *     holds even if the invoice key of an older row differs.
 *
 * ⚠️ The SQL below ALSO pre-filters on job type, skip tags and do_not_service,
 * and that is about cost, not correctness. An invoice the rules decline never
 * gets a row, so without a pre-filter it stays a candidate forever: a dozen
 * PHC and `NO FEEDBACK EMAIL` invoices would each cost two HousecallPro reads
 * every five minutes, for as long as they sat in the window — thousands of
 * requests a day to re-derive the same "no". The pre-filter reads the SYNCED
 * copies and only ever REMOVES candidates; `enrollReviewRequest` remains the
 * authority and re-checks everything live (which matters for `do_not_service`,
 * whose synced value can be null-because-unknown). The skip tags and the type
 * string come from the same constants the authority uses, so there is one set
 * of rules evaluated twice, not two sets.
 */
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpInvoices, hcpJobs, reviewRequests } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { SKIP_TAGS } from "@/lib/reviews/county";
import { enrollReviewRequest, invoiceKeySql, REPEAT_ASK_WINDOW_DAYS } from "@/lib/reviews/enroll";

/** How far back a sweep will look. Comfortably longer than any plausible
 *  webhook outage, comfortably shorter than the repeat-ask window. */
export const BACKFILL_WINDOW_DAYS = 14;
/** Let the webhook have first go; only adopt an invoice it has clearly missed. */
export const BACKFILL_GRACE_MINUTES = 30;
/** Ceiling per run. At a 5-minute cadence that is still 120/hour if a real gap
 *  needs filling, while a mistake stays small enough to notice and stop. */
export const BACKFILL_MAX_PER_RUN = 10;

export interface BackfillStats {
  candidates: number;
  enrolled: number;
  duplicate: number;
  skipped: number;
  failed: number;
}

/**
 * The candidate query, exported so `verify:review-backfill` can run it against a
 * real Postgres.
 *
 * ⚠️ Nothing here is visible to `tsc` — it is all inside `sql` templates — and
 * the first version shipped with `= any(${SKIP_TAGS})`, which typechecked, built,
 * and then failed on EVERY run in production ("op ANY/ALL (array) requires array
 * on right side"), taking the sequencer down with it because the sweep runs
 * first. That is the whole argument for the verify script: this query has to be
 * executed by a real server to be known to work at all.
 */
export async function findBackfillCandidates(
  nowMs: number = Date.now(),
): Promise<Array<{ invoiceKey: string; jobId: string | null; paidAt: Date | null }>> {
  const now = nowMs;
  const windowStart = new Date(now - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const graceCutoff = new Date(now - BACKFILL_GRACE_MINUTES * 60 * 1000);

  const repeatSince = new Date(now - REPEAT_ASK_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const invoiceKey = invoiceKeySql(hcpInvoices.invoiceNumber, hcpInvoices.hcpInvoiceId);
  /**
   * The tag test, mirroring `shouldSkipReview` exactly — lower-cased and
   * trimmed on BOTH sides. HCP keeps whatever casing the office typed
   * ("NO FEEDBACK EMAIL", "PHC", "Phc Client" have all been seen), so a plain
   * array overlap against the lower-case constants would match none of them
   * and the pre-filter would quietly stop pre-filtering.
   *
   * ⚠️ Each tag is bound as its OWN parameter rather than passing the array to
   * `= any($1)`. Drizzle binds a JS array as a single untyped parameter, so
   * Postgres receives text where it wants `text[]` and the whole statement dies
   * with "op ANY/ALL (array) requires array on right side" — which took down
   * every reviews.workflow run for 13 minutes after the first deploy, sends
   * included, because the sweep runs ahead of the sequencer.
   */
  const skipTagParams = sql.join(
    SKIP_TAGS.map((tag) => sql`${tag}`),
    sql`, `,
  );
  const hasNoSkipTag = (tags: PgColumn) => sql`not exists (
    select 1 from unnest(coalesce(${tags}, '{}'::text[])) as tag
    where lower(btrim(tag)) in (${skipTagParams})
  )`;
  // HCP's own job id, which is what the webhook payload carries and what
  // `getJobById` expects — NOT our ULID FK.
  const hcpJobKey = sql<string>`coalesce(nullif(${hcpInvoices.hcpJobIdHcp}, ''), ${hcpJobs.hcpJobId})`;

  const candidates = await db
    .select({
      invoiceKey,
      jobId: hcpJobKey,
      paidAt: hcpInvoices.paidAt,
    })
    .from(hcpInvoices)
    .leftJoin(hcpJobs, eq(hcpJobs.id, hcpInvoices.hcpJobId))
    .leftJoin(hcpCustomers, eq(hcpCustomers.id, hcpInvoices.hcpCustomerId))
    .where(
      and(
        eq(hcpInvoices.status, "paid"),
        gte(hcpInvoices.paidAt, windowStart),
        lte(hcpInvoices.paidAt, graceCutoff),
        // A tombstoned invoice is one HousecallPro no longer lists (merged or
        // removed upstream); enrolling from it would ask about work that, as
        // far as HCP is concerned, no longer happened.
        isNull(hcpInvoices.missingFromHcpAt),
        sql`coalesce(nullif(${hcpInvoices.hcpJobIdHcp}, ''), ${hcpJobs.hcpJobId}) is not null`,
        // Already enrolled from this invoice.
        sql`not exists (
          select 1 from ${reviewRequests}
          where ${reviewRequests.invoiceId} = ${invoiceKey}
        )`,
        // Already asked this customer inside the repeat window — the cheap
        // form of the authority's phone guard, keyed on the HCP customer, so a
        // customer settling six invoices at once is one candidate, not six.
        //
        // ⚠️ Joined on `hcp_customers.hcp_customer_id`, NOT on the invoice's
        // `hcp_customer_id`: the invoice column is our ULID foreign key while
        // the review request stores HousecallPro's own `cus_…` id. Comparing
        // those two matches nothing, ever, and the guard would look present
        // while doing nothing.
        sql`not exists (
          select 1 from ${reviewRequests}
          where ${reviewRequests.hcpCustomerId} = ${hcpCustomers.hcpCustomerId}
            and ${reviewRequests.createdAt} >= ${repeatSince.toISOString()}
        )`,
        // Tree Service only, as the webhook has it: an absent type does not
        // exclude (HCP leaves it unset on plenty of jobs and the authority
        // treats that the same way).
        sql`(${hcpJobs.jobType} is null or lower(${hcpJobs.jobType}) = 'tree service')`,
        // Skip tags on either the job or the customer.
        hasNoSkipTag(hcpJobs.tags),
        hasNoSkipTag(hcpCustomers.tags),
        // Three-state: only an explicit true excludes here, and the authority
        // re-reads it live with the expand before anyone is contacted.
        sql`${hcpCustomers.doNotService} is not true`,
      ),
    )
    .orderBy(hcpInvoices.paidAt)
    .limit(BACKFILL_MAX_PER_RUN);

  return candidates;
}

export async function backfillMissedEnrollments(): Promise<BackfillStats> {
  const empty: BackfillStats = { candidates: 0, enrolled: 0, duplicate: 0, skipped: 0, failed: 0 };
  if (env.REVIEW_WORKFLOW_ENABLED !== "true") return empty;

  const candidates = await findBackfillCandidates();
  if (candidates.length === 0) return empty;

  const stats: BackfillStats = { ...empty, candidates: candidates.length };
  console.log(
    `[reviews] backfill: ${candidates.length} paid invoice(s) in the last ${BACKFILL_WINDOW_DAYS}d with no review request`,
  );

  for (const candidate of candidates) {
    if (!candidate.jobId) {
      stats.skipped++;
      continue;
    }
    try {
      const result = await enrollReviewRequest({
        jobId: candidate.jobId,
        invoiceId: candidate.invoiceKey,
        via: "backfill",
      });
      if (result.status === "enrolled") stats.enrolled++;
      else if (result.status === "duplicate") stats.duplicate++;
      else stats.skipped++;
    } catch (error) {
      // One unreachable HCP record must not stall the rest of the sweep, and the
      // next run picks it up again — nothing here is claimed or consumed.
      stats.failed++;
      console.log(
        `[reviews] backfill failed for invoice ${candidate.invoiceKey}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (stats.enrolled > 0) {
    console.log(`[reviews] backfill enrolled ${stats.enrolled} missed customer(s)`);
  }
  return stats;
}
