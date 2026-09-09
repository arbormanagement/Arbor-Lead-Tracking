import { enrollReviewRequest } from "@/lib/reviews/enroll";
import { webhookAuthorized } from "@/lib/intake/webhook-auth";

export const runtime = "nodejs";

/**
 * HCP `invoice.paid` → enroll the customer in the review follow-up sequence.
 *
 * This route is only the DOOR: it authenticates the sender, pulls the two ids
 * out of the payload and hands them to `enrollReviewRequest`, which owns every
 * eligibility rule (job type, skip tags, do_not_service, consent, dedupe) and
 * is shared with the repair sweep in `lib/reviews/backfill.ts`. Enrolling only
 * creates a PENDING row — the cron sequencer (`lib/reviews/workflow.ts`, gated
 * by REVIEW_WORKFLOW_ENABLED) is what sends.
 *
 * ⚠️ This webhook is not the only path any more, and that is on purpose: it was
 * a single point of failure, and when it went quiet across the Arbor-Automations
 * cutover a paid Tree Service customer was simply never asked. Nothing noticed,
 * because a webhook that never arrives leaves no trace anywhere.
 */
export async function POST(req: Request) {
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const event = body.event;
    console.log(`[review_request] HCP webhook received: event=${event}`);

    if (event !== "invoice.paid") {
      return Response.json({ message: `Ignored event: ${event}` });
    }

    const invoice = body.invoice || {};
    const jobId: string = invoice.job_id || "";
    const invoiceId: string = String(invoice.invoice_number || invoice.id || "");

    console.log(`[review_request] invoice=${invoiceId || "(none)"} job_id=${jobId || "(none)"}`);

    if (!jobId) {
      console.log("[review_request] no job_id in payload, cannot look up customer");
      return Response.json({ message: "No job_id, skipping" });
    }
    // An empty invoice id would make (invoice_id, phone) collide across
    // unrelated customers on the unique index — refuse rather than enroll.
    if (!invoiceId) {
      console.log("[review_request] no invoice id in payload, refusing to enroll");
      return Response.json({ message: "No invoice id, skipping" });
    }

    const result = await enrollReviewRequest({ jobId, invoiceId, via: "webhook" });
    switch (result.status) {
      case "enrolled":
        return Response.json({ message: "Review request created", id: result.id });
      case "suppressed":
        return Response.json({ message: "Review request suppressed (opted out)", id: result.id });
      case "duplicate":
        return Response.json({ message: "Duplicate event, already processed" });
      default:
        return Response.json({ message: `Skipped: ${result.reason}` });
    }
  } catch (error) {
    console.log(`[review_request] webhook error: ${error instanceof Error ? error.message : error}`);
    return Response.json({ message: "Internal server error" }, { status: 500 });
  }
}
