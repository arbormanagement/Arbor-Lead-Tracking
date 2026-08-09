import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contacts, conversations, leads, messages, trackingNumbers } from "@/lib/db/schema";
import { getTwilioClient } from "@/lib/twilio/client";
import { preview, recordThreadActivity } from "./thread";

/** Twilio's "recipient has opted out" error — the carrier-side STOP block. */
const OPT_OUT_ERROR = 21610;

export class SendError extends Error {
  constructor(
    message: string,
    readonly code: "opted_out" | "no_destination" | "no_sender" | "provider" | "empty",
  ) {
    super(message);
  }
}

/**
 * Send a text on a thread and record it as an outbound message.
 *
 * Reply-from is the number the customer actually contacted (`lastEndpointKey`),
 * not a house number: to them the conversation is with that number, and replying
 * from anything else starts a second thread on their phone and breaks the
 * attribution chain on ours.
 *
 * Sending is gated on consent. `smsOptedOutAt` is checked before we queue
 * anything, and a carrier-side rejection (21610) is written back to the contact so
 * the block sticks even if the STOP came in through a path we never saw.
 */
export async function sendThreadSms(args: {
  conversationId: string;
  body: string;
}): Promise<typeof messages.$inferSelect> {
  const body = args.body.trim();
  if (!body) throw new SendError("Message is empty", "empty");

  const [row] = await db
    .select({ thread: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(eq(conversations.id, args.conversationId))
    .limit(1);
  if (!row) throw new SendError("Conversation not found", "no_destination");

  const { thread, contact } = row;

  if (contact.smsOptedOutAt) {
    throw new SendError(
      "This person replied STOP — texting them is blocked until they text START.",
      "opted_out",
    );
  }

  const to = contact.primaryPhone;
  if (!to) throw new SendError("No mobile number on file for this contact", "no_destination");

  const from = await resolveSender(thread.lastEndpointKey);
  if (!from) {
    throw new SendError(
      "No tracking number available to send from — this thread has no texting endpoint.",
      "no_sender",
    );
  }

  // Insert the row FIRST, in 'queued', so a Twilio call that succeeds but whose
  // response we never see still leaves a record. An orphaned queued row is a far
  // better failure than a text the customer got and the thread never shows.
  const [pending] = await db
    .insert(messages)
    .values({
      conversationId: thread.id,
      leadId: await openLeadFor(thread.id),
      channel: "sms",
      direction: "outbound",
      fromAddress: from,
      toAddress: to,
      body,
      status: "queued",
    })
    .returning();

  try {
    const client = await getTwilioClient();
    const sent = await client.messages.create({ from, to, body });

    const [updated] = await db
      .update(messages)
      .set({ externalId: sent.sid, status: sent.status ?? "sent", updatedAt: new Date() })
      .where(eq(messages.id, pending.id))
      .returning();

    await recordThreadActivity(thread.id, {
      channel: "sms",
      direction: "outbound",
      preview: preview(body),
    });
    return updated;
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
        .where(eq(contacts.id, contact.id));
      throw new SendError(
        "Twilio rejected this: the recipient has opted out of messages from this number.",
        "opted_out",
      );
    }
    throw new SendError(detail, "provider");
  }
}

/**
 * The tracking number to send from. Must be one we own AND still have active —
 * texting from a released number would fail at Twilio, so we'd rather say so.
 */
async function resolveSender(endpointKey: string | null): Promise<string | null> {
  if (!endpointKey || !endpointKey.startsWith("+")) return null;
  const [tn] = await db
    .select({ phoneNumber: trackingNumbers.phoneNumber })
    .from(trackingNumbers)
    .where(and(eq(trackingNumbers.phoneNumber, endpointKey), eq(trackingNumbers.status, "active")))
    .limit(1);
  return tn?.phoneNumber ?? null;
}

/** Hang the reply off whatever lead is currently in flight on this thread. */
async function openLeadFor(conversationId: string): Promise<string | null> {
  const [lead] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .orderBy(desc(leads.occurredAt))
    .limit(1);
  return lead?.id ?? null;
}
