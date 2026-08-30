/**
 * Outbound SMS for the review workflow — the merge's replacement for the old
 * app's bare `sendSMS`, with the two things it never had:
 *
 *  1. CONSENT. `contacts.sms_opted_out_at` is checked before every send and a
 *     carrier-side 21610 writes the block back, exactly like inbox replies
 *     (`lib/messaging/send.ts`). A STOP to any tracking number now also stops
 *     review texts, because the block lives on the person.
 *  2. THREADING. Every send lands on the contact's conversation, so a reply
 *     shows in `/inbox` with the request that prompted it — not as a bare
 *     email forward with no history.
 *
 * Sends go from `REVIEW_SMS_FROM` (+16183103486 in production — the number
 * customers have received these from all along). That number should be imported
 * into `tracking_numbers` (outreach pool, static) so its inbound texts hit
 * `/api/twilio/sms` and STOP handling; the send itself only needs the env var.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contacts, messages } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { preview, recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { getTwilioClient } from "@/lib/twilio/client";

/** Twilio's "recipient has opted out" error — the carrier-side STOP block. */
const OPT_OUT_ERROR = 21610;

export type ReviewSendResult =
  | { ok: true }
  | { ok: false; reason: "opted_out" | "not_configured" | "provider"; detail: string };

export async function sendReviewSms(args: {
  toE164: string;
  customerName: string;
  body: string;
}): Promise<ReviewSendResult> {
  const from = env.REVIEW_SMS_FROM;
  if (!from) {
    return { ok: false, reason: "not_configured", detail: "REVIEW_SMS_FROM is not set" };
  }

  const thread = await upsertThread(
    { phone: args.toE164, name: args.customerName },
    { endpointKey: from },
  );
  if (!thread) {
    return { ok: false, reason: "provider", detail: `could not resolve a contact for ${args.toE164}` };
  }

  const [contact] = await db
    .select({ id: contacts.id, smsOptedOutAt: contacts.smsOptedOutAt })
    .from(contacts)
    .where(eq(contacts.id, thread.contactId))
    .limit(1);
  if (contact?.smsOptedOutAt) {
    return {
      ok: false,
      reason: "opted_out",
      detail: "This person replied STOP — review texts to them are blocked.",
    };
  }

  // Row first, in 'queued': a Twilio call that succeeds but whose response we
  // never see still leaves a record, same trade as inbox replies.
  const [pending] = await db
    .insert(messages)
    .values({
      conversationId: thread.conversationId,
      channel: "sms",
      direction: "outbound",
      fromAddress: from,
      toAddress: args.toE164,
      body: args.body,
      status: "queued",
    })
    .returning();

  try {
    const client = await getTwilioClient();
    const sent = await client.messages.create({ from, to: args.toE164, body: args.body });

    await db
      .update(messages)
      .set({ externalId: sent.sid, status: sent.status ?? "sent", updatedAt: new Date() })
      .where(eq(messages.id, pending.id));

    await recordThreadActivity(thread.conversationId, {
      channel: "sms",
      direction: "outbound",
      preview: preview(args.body),
    });
    return { ok: true };
  } catch (err) {
    const code = (err as { code?: number }).code;
    const detail = err instanceof Error ? err.message : String(err);
    await db
      .update(messages)
      .set({ status: "failed", errorCode: code != null ? String(code) : null, updatedAt: new Date() })
      .where(eq(messages.id, pending.id));

    if (code === OPT_OUT_ERROR) {
      await db
        .update(contacts)
        .set({ smsOptedOutAt: new Date(), updatedAt: new Date() })
        .where(eq(contacts.id, thread.contactId));
      return { ok: false, reason: "opted_out", detail };
    }
    return { ok: false, reason: "provider", detail };
  }
}
