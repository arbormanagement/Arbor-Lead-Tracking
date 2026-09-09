import { backfillMissedEnrollments } from "@/lib/reviews/backfill";
import { processReviewWorkflows } from "@/lib/reviews/workflow";
import { withSyncRun } from "./run";

/**
 * reviews.workflow — the SCHEDULED door onto the review follow-up sequence
 * (the merge's slice 4). `withSyncRun`'s one-run-at-a-time claim is the whole
 * point: the old app ran this as a `setInterval` and had to document "exactly
 * ONE deployment may enable this or every customer gets texted twice" as an
 * operator rule. Here two overlapping ticks are structurally impossible, and
 * the run lands in `sync_runs` so /api/diagnostics can see the sequence
 * stalling.
 *
 * The function itself is additionally gated by REVIEW_WORKFLOW_ENABLED
 * (default off) — a `{enabled:false}` result means the flag, not a lock.
 */
export async function syncReviewWorkflow() {
  return withSyncRun("reviews.workflow", async () => {
    // Repair BEFORE sending, so an invoice the webhook missed is enrolled and
    // then sequenced on the same tick rather than waiting five more minutes.
    // Both halves are gated by REVIEW_WORKFLOW_ENABLED; `enrolled > 0` in the
    // run stats means the webhook did not deliver and this caught it, which is
    // worth noticing rather than silently repairing forever.
    const backfill = await backfillMissedEnrollments();
    const workflow = await processReviewWorkflows();
    return { ...workflow, backfill };
  });
}
