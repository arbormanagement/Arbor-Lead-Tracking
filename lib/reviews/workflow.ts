/**
 * The Google-review follow-up sequence: invoice.paid → +1min SMS → +24h email
 * (skipped when no email is on file) → +2d final SMS, every step skipped once
 * the tracking link is clicked. Copy and timing ported verbatim from
 * Arbor-Automations `server/reviewWorkflow.ts` (the merge's slice 4); the
 * machinery is rebuilt on this app's rails:
 *
 *  - runs as a locked cron job (`withSyncRun`) instead of a `setInterval` in
 *    the web process — the "exactly ONE deployment may run this" env-flag
 *    footgun becomes structural;
 *  - retry counts persist on the row (`attempts_*`) instead of an in-memory
 *    Map that reset on every restart;
 *  - sends are consent-gated and threaded (see `outreach.ts`).
 *
 * ⚠️ Gated by REVIEW_WORKFLOW_ENABLED (default off): this sends real SMS and
 * email to real customers, and until the slice 4 cutover the OLD app owns the
 * sequence. Both running at once texts every customer twice.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { reviewRequests } from "@/lib/db/schema";
import { sendEmail, sendFailureAlert } from "@/lib/email/sendgrid";
import { env } from "@/lib/env";
import { sendReviewSms } from "@/lib/reviews/outreach";
import { MAX_RETRIES, finalSmsBody, followUpEmailHtml, initialSmsBody, isWithinSendWindow, nextDueStep, type ReviewStep } from "@/lib/reviews/sequence";

type ReviewRow = typeof reviewRequests.$inferSelect;

async function set(row: ReviewRow, values: Partial<typeof reviewRequests.$inferInsert>) {
  await db
    .update(reviewRequests)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(reviewRequests.id, row.id));
}

/** Re-read `clicked` right before sending — a click during the wait means the
 *  customer already did the thing, and another text reads as not noticing. */
async function freshClicked(row: ReviewRow): Promise<boolean> {
  const [fresh] = await db
    .select({ clicked: reviewRequests.clicked })
    .from(reviewRequests)
    .where(eq(reviewRequests.id, row.id))
    .limit(1);
  return fresh?.clicked ?? false;
}

async function failStep(row: ReviewRow, step: ReviewStep, summary: string) {
  await set(row, { status: "failed", errorMessage: summary });
  await sendFailureAlert("Google Review Workflow", summary, {
    reviewRequestId: row.id,
    step,
    customer: row.customerName,
    phone: row.customerPhoneE164,
    email: row.customerEmail ?? "(none)",
    invoiceId: row.invoiceId,
    county: row.county,
  });
}

async function runStep(row: ReviewRow, step: ReviewStep): Promise<void> {
  if (step === "email_skip") {
    await set(row, { emailSent: "skipped" });
    console.log(`[reviews] no email on file for ${row.customerName}, skipping email step`);
    return;
  }

  if (await freshClicked(row)) {
    // Completed by the click handler; just mark the step so the row settles.
    if (step === "sms1") await set(row, { status: "completed", smsSent: true });
    if (step === "email") await set(row, { status: "completed", emailSent: "sent" });
    if (step === "sms2") await set(row, { status: "completed", finalSmsSent: true });
    return;
  }

  const attemptKey = step === "sms1" ? "attemptsSms1" : step === "email" ? "attemptsEmail" : "attemptsSms2";
  const attemptCol = reviewRequests[attemptKey];
  const attempts = row[attemptKey];
  if (attempts >= MAX_RETRIES) {
    await failStep(row, step, `${step} failed after ${MAX_RETRIES} attempts`);
    return;
  }
  // Claim the attempt BEFORE sending, so a crash mid-send still counts against
  // the cap — the old in-memory Map lost this on every restart.
  await db
    .update(reviewRequests)
    .set({ [attemptKey]: sql`${attemptCol} + 1`, updatedAt: new Date() })
    .where(eq(reviewRequests.id, row.id));

  try {
    if (step === "email") {
      await sendEmail(row.customerEmail as string, "Quick favor?", followUpEmailHtml(row.customerName, row.trackingUrl), "justin@arbor-mgmt.com");
      await set(row, { emailSent: "sent" });
      console.log(`[reviews] follow-up email sent to ${row.customerName}`);
      return;
    }

    const body = step === "sms1" ? initialSmsBody(row.customerName, row.trackingUrl) : finalSmsBody(row.customerName, row.trackingUrl);
    const result = await sendReviewSms({
      toE164: row.customerPhoneE164,
      customerName: row.customerName,
      body,
    });
    if (!result.ok) {
      if (result.reason === "opted_out") {
        // Not a retryable failure and not an error: the customer said stop.
        await set(row, { status: "suppressed", errorMessage: result.detail });
        console.log(`[reviews] ${row.customerName} is opted out — request suppressed`);
        return;
      }
      throw new Error(result.detail);
    }

    if (step === "sms1") {
      await set(row, { smsSent: true });
      console.log(`[reviews] initial SMS sent to ${row.customerName} (${row.customerPhoneE164})`);
    } else {
      await set(row, { finalSmsSent: true, status: "completed" });
      console.log(`[reviews] final SMS sent to ${row.customerName} (${row.customerPhoneE164})`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[reviews] ${step} failed for ${row.customerName}: ${message}`);
    await set(row, { errorMessage: `${step} failed: ${message}` });
  }
}

export async function processReviewWorkflows(): Promise<{ enabled: boolean; pending: number; stepsRun: number; held: number }> {
  if (env.REVIEW_WORKFLOW_ENABLED !== "true") {
    return { enabled: false, pending: 0, stepsRun: 0, held: 0 };
  }

  const pending = await db
    .select()
    .from(reviewRequests)
    .where(and(eq(reviewRequests.status, "pending")));

  const now = new Date();
  // Quiet hours are a HOLD, not a skip: a step due outside the window stays due
  // and goes out on the first tick inside it. `email_skip` is exempt because it
  // contacts nobody — it only marks a row that has no email on file, and making
  // it wait would push that row's final SMS out by the length of the hold.
  const sendable = isWithinSendWindow(now);
  let stepsRun = 0;
  let held = 0;
  for (const row of pending) {
    const step = nextDueStep(row, now);
    if (!step) continue;
    if (!sendable && step !== "email_skip") {
      held++;
      continue;
    }
    stepsRun++;
    try {
      await runStep(row, step);
    } catch (error) {
      // One broken row must not stall the whole queue.
      console.log(`[reviews] step runner error for ${row.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (held > 0) {
    // Say it out loud. A silently-held queue reads exactly like an empty one,
    // which is the failure mode that hid the getJobById bug for two days.
    console.log(`[reviews] ${held} step(s) held outside the send window (Mon-Fri 9am-7pm CT)`);
  }
  return { enabled: true, pending: pending.length, stepsRun, held };
}
