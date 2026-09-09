import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contacts, messages, reviewRequests } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { parseTwilioForm, validateTwilioSignature } from "@/lib/twilio/signature";

export const runtime = "nodejs";

/** Twilio's terminal failure states. Everything else (queued/sending/sent) is
 *  still in flight and `delivered` is the happy ending. */
const TERMINAL_FAILURES = new Set(["failed", "undelivered"]);
/** "Recipient has opted out" — the carrier-side STOP block. */
const OPT_OUT_ERROR = "21610";

/**
 * SMS delivery receipts.
 *
 * ⚠️ This closes the gap that let a landline consume a whole review sequence.
 * `client.messages.create()` resolving only means Twilio accepted the message;
 * the carrier's verdict arrives minutes later and ONLY here. With no callback
 * configured, `messages.status` froze at whatever the create call returned, so
 * an undelivered text and a delivered one were indistinguishable in the inbox
 * and to the review sequencer alike — one customer was texted twice, both
 * undelivered (error 30006), and nothing anywhere said so.
 *
 * Fails CLOSED on an unverifiable signature, like /status and /recording: this
 * is a pure write endpoint, and a forged receipt could mark a real customer
 * unreachable.
 */
export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  const sig = await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params);
  if (sig === "invalid") return new Response("invalid signature", { status: 403 });
  if (sig === "unresolved" && env.NODE_ENV === "production") {
    console.error("[twilio/message-status] no auth token to verify the signature — rejecting write");
    return new Response("signature unresolved", { status: 403 });
  }

  const sid = params.MessageSid || params.SmsSid;
  const status = params.MessageStatus || params.SmsStatus;
  const errorCode = params.ErrorCode || null;
  if (!sid || !status) return new Response(null, { status: 204 });

  try {
    await db
      .update(messages)
      .set({ status, errorCode, updatedAt: new Date() })
      .where(and(eq(messages.channel, "sms"), eq(messages.externalId, sid)));

    if (!TERMINAL_FAILURES.has(status)) return new Response(null, { status: 204 });

    console.log(`[twilio/message-status] ${sid} ${status}${errorCode ? ` (${errorCode})` : ""}`);

    // Which review request this belonged to travels on the callback URL — see
    // `messageStatusCallbackUrl`. Absent for inbox replies, which have no
    // sequence to hold back.
    const reviewRequestId = new URL(req.url).searchParams.get("rr");
    if (!reviewRequestId) return new Response(null, { status: 204 });

    const [request] = await db
      .select({ id: reviewRequests.id, contactId: reviewRequests.contactId, name: reviewRequests.customerName })
      .from(reviewRequests)
      .where(eq(reviewRequests.id, reviewRequestId))
      .limit(1);
    if (!request) return new Response(null, { status: 204 });

    if (errorCode === OPT_OUT_ERROR) {
      // The carrier says they said STOP. Same handling as a create-time 21610:
      // the block lives on the PERSON, so it survives them starting a new thread.
      if (request.contactId) {
        await db
          .update(contacts)
          .set({ smsOptedOutAt: new Date(), updatedAt: new Date() })
          .where(and(eq(contacts.id, request.contactId), isNull(contacts.smsOptedOutAt)));
      }
      await db
        .update(reviewRequests)
        .set({
          status: "suppressed",
          errorMessage: "Carrier reported the recipient has opted out (21610)",
          updatedAt: new Date(),
        })
        .where(eq(reviewRequests.id, request.id));
      console.log(`[twilio/message-status] ${request.name} opted out — review request suppressed`);
      return new Response(null, { status: 204 });
    }

    // Only stamp the FIRST verdict: a later receipt must not overwrite the code
    // that explains the row.
    await db
      .update(reviewRequests)
      .set({ smsUndeliverableAt: new Date(), smsUndeliverableCode: errorCode, updatedAt: new Date() })
      .where(and(eq(reviewRequests.id, request.id), isNull(reviewRequests.smsUndeliverableAt)));
    console.log(
      `[twilio/message-status] ${request.name} is unreachable by SMS (${errorCode ?? status}) — the final text will be skipped`,
    );
  } catch (error) {
    // Never 500 at Twilio: it retries, and a retry storm on a receipt helps
    // nobody. The row keeps its last known status and the next receipt corrects it.
    console.error("[twilio/message-status] failed to persist receipt", sid, error);
  }

  return new Response(null, { status: 204 });
}
