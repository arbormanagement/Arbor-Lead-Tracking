import { db } from "@/lib/db/client";
import { retellCallSummaries } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { escapeHtml, sendEmail, sendFailureAlert } from "@/lib/email/sendgrid";
import { webhookAuthorized } from "@/lib/intake/webhook-auth";

export const runtime = "nodejs";

/**
 * Retell post-call webhook: on `call_analyzed`, email the summary + transcript
 * to info@. Ported from Arbor-Automations at the same path (the merge's
 * slice 2); dormant until the Retell agent webhook points at this host.
 *
 * ⚠️ This email is the ONLY record of estimate cancellations — Chloe's
 * `##Cancel Estimate` deliberately calls no function and does not transfer
 * (Justin 2026-07-31; the office cancels estimates directly). Do not "clean
 * this up" into a dashboard-only record without replacing that.
 *
 * Idempotent on `call_id` via the unique insert on `retell_call_summaries` —
 * whoever wins the conflict sends the one email. The table starts empty at
 * cutover (lean-import decision): Retell only redelivers near-term, so the old
 * app's history buys nothing here.
 */
export async function POST(req: Request) {
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const event = body.event;

    if (event !== "call_analyzed") {
      return Response.json({ message: `Ignored event: ${event}` });
    }

    const call = body.call || body;
    const fromNumber = call.from_number || call.to_number || call.phone || call.caller_number || "";
    const transcript: string = call.transcript || "";
    const callId: string | null = call.call_id || null;

    const callAnalysis = call.call_analysis || {};
    const summary: string = callAnalysis.call_summary || call.call_summary || call.summary || "";

    // Claim the call_id FIRST — the unique index arbitrates a Retell redelivery
    // racing itself, so exactly one claimant proceeds to email. A claim whose
    // email FAILED stays claimable: this email is the only record of estimate
    // cancellations, so a SendGrid blip must not permanently drop it —
    // Retell's redeliveries become the retry mechanism.
    let [claimed] = await db
      .insert(retellCallSummaries)
      .values({
        callId,
        callerPhone: fromNumber || null,
        summary: summary || null,
        raw: body,
      })
      .onConflictDoNothing({ target: retellCallSummaries.callId })
      .returning({ id: retellCallSummaries.id });
    if (!claimed) {
      const [existing] = await db
        .select({ id: retellCallSummaries.id, status: retellCallSummaries.status })
        .from(retellCallSummaries)
        .where(eq(retellCallSummaries.callId, callId as string))
        .limit(1);
      if (existing?.status !== "failed") {
        console.log(`[call_summary] duplicate call_analyzed for call_id=${callId}, skipping`);
        return Response.json({ message: "Duplicate event ignored" });
      }
      console.log(`[call_summary] retrying failed email for call_id=${callId}`);
      claimed = existing;
    }

    // The summary and transcript are model/caller-derived text landing in an
    // HTML email — escape them, or a caller who says the right words injects
    // markup into the office's inbox.
    const subject = `Call from ${fromNumber}`;
    const formattedTranscript = transcript
      .split("\n")
      .map((line: string) => {
        const trimmed = escapeHtml(line.trim());
        if (!trimmed) return "<br/>";
        return trimmed
          .replace(/^(Agent:)/i, "<strong>Agent:</strong>")
          .replace(/^(User:)/i, "<strong>User:</strong>")
          .replace(/^(Transfer Target:)/i, "<strong>Transfer Target:</strong>");
      })
      .join("<br/>");

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
        <p><strong>Call Summary:</strong><br/>
        ${escapeHtml(summary) || "No summary available."}</p>

        <p><strong>Transcript:</strong><br/>
        ${formattedTranscript || "No transcript available."}</p>
      </div>
    `;

    try {
      await sendEmail("info@arbor-mgmt.com", subject, htmlBody);
      await db
        .update(retellCallSummaries)
        .set({ status: "sent", errorMessage: null })
        .where(eq(retellCallSummaries.id, claimed.id));
      console.log(`[call_summary] email sent for ${fromNumber}`);
    } catch (emailError) {
      const message = emailError instanceof Error ? emailError.message : String(emailError);
      await db
        .update(retellCallSummaries)
        .set({ status: "failed", errorMessage: message })
        .where(eq(retellCallSummaries.id, claimed.id));
      console.log(`[call_summary] email failed for ${fromNumber}: ${message}`);
      await sendFailureAlert("Call Summary Email", message, {
        callId,
        fromNumber,
        summaryRecordId: claimed.id,
        error: message,
      });
    }

    return Response.json({ message: "Call summary processed", id: claimed.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[call_summary] webhook error: ${message}`);
    return Response.json({ message: "Failed to process call summary", error: message }, { status: 500 });
  }
}
