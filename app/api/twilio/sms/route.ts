import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, leads, messages, numberAssignments, trackingNumbers } from "@/lib/db/schema";
import { clearSmsOptOut, markSmsOptedOut } from "@/lib/contacts/resolve";
import { env } from "@/lib/env";
import { preview, recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { normalizePhone } from "@/lib/phone";
import { getSmsForwardNumber } from "@/lib/routing";
import { getTwilioClient } from "@/lib/twilio/client";
import { ensureSourceId, isHardSpamNumber, resolveInboundAttribution } from "@/lib/twilio/inbound";
import { parseTwilioForm, validateTwilioSignature } from "@/lib/twilio/signature";
import { xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Inbound SMS/MMS on a tracking number.
 *
 * Mirrors /api/twilio/voice: resolve the number → resolve the DNI lease → spam
 * pre-check → persist, so a text and a call from the same person on the same
 * number attribute to the same source and land in the same thread.
 *
 * Two deliberate differences from the voice webhook:
 *  - It fails CLOSED on an unverifiable signature. /voice fails open because dead
 *    air loses a customer; an unverified text is just a write, and an open write
 *    endpoint lets anyone forge leads.
 *  - `is_lead` is left NULL rather than guessed. A text is like a call: it can be
 *    an existing customer, a vendor, or a wrong number. The `classify-messages`
 *    cron reads the body and decides, so nothing reaches the Leads list until
 *    something has actually confirmed it is an estimate request.
 *
 * Replies to the customer are not sent from here — the reply TwiML is empty and
 * the text is relayed to a human (see `getSmsForwardNumber`).
 */
export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  const sig = await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params);
  if (sig === "invalid") return new Response("invalid signature", { status: 403 });
  if (sig === "unresolved" && env.NODE_ENV === "production") {
    console.error(
      "[twilio/sms] no auth token available to verify the Twilio signature — rejecting write. Fix the Twilio credentials.",
    );
    return new Response("signature unresolved", { status: 403 });
  }

  const messageSid = params.MessageSid || params.SmsMessageSid;
  const fromE164 = normalizePhone(params.From);
  const toNumber = params.To;
  const body = params.Body ?? "";

  if (!messageSid || !fromE164 || !toNumber) {
    // Nothing actionable — ack so Twilio stops retrying a malformed delivery.
    return xmlResponse("<Response/>");
  }

  try {
    const [tn] = await db
      .select()
      .from(trackingNumbers)
      .where(eq(trackingNumbers.phoneNumber, toNumber))
      .limit(1);

    // A text to a number we don't track has no attribution to record and no
    // thread to file it under. Ack and drop.
    if (!tn) {
      console.warn("[twilio/sms] text to untracked number", toNumber);
      return xmlResponse("<Response/>");
    }

    const spam = await isHardSpamNumber(fromE164);
    const { sourceKey, assignmentId, lease } = await resolveInboundAttribution(tn);
    const sourceId = await ensureSourceId(sourceKey);

    const thread = await upsertThread(
      { phone: fromE164 },
      {
        endpointKey: tn.phoneNumber,
        trackingNumberId: tn.id,
        numberAssignmentId: assignmentId,
        sourceId,
      },
    );
    if (!thread) throw new Error("could not open a conversation for this text");

    // Consent bookkeeping. Twilio's Advanced Opt-Out already stops delivery at the
    // carrier; mirroring it here is what stops the app from *queueing* a send that
    // would be rejected, and gives the UI something honest to show.
    await applyOptOutKeywords(thread.contactId, body);

    // Idempotency: Twilio retries on any non-2xx, and the unique index on
    // (channel, external_id) is what makes a retry a no-op rather than a
    // duplicate text and a duplicate lead. Insert FIRST, then act only if this
    // delivery is the one that won.
    const [inserted] = await db
      .insert(messages)
      .values({
        conversationId: thread.conversationId,
        channel: "sms",
        direction: "inbound",
        fromAddress: fromE164,
        toAddress: tn.phoneNumber,
        body,
        media: collectMedia(params),
        externalId: messageSid,
        status: params.SmsStatus ?? "received",
        numSegments: params.NumSegments ? Number(params.NumSegments) : null,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id });

    if (!inserted) return xmlResponse("<Response/>"); // already ingested

    // One OPEN lead per thread. A follow-up text ("it's near the driveway") is part
    // of the enquiry already in flight, not a second enquiry — but a text months
    // later, after the last one was won or lost, is genuinely new business and gets
    // its own lead so the ROI numbers count it.
    const leadId = await attachToOpenLeadOrCreate({
      thread,
      fromE164,
      body,
      sourceId,
      lease,
      location: tn.location ?? "unknown",
      spam,
    });

    await db.update(messages).set({ leadId }).where(eq(messages.id, inserted.id));
    await recordThreadActivity(thread.conversationId, {
      channel: "sms",
      direction: "inbound",
      preview: preview(body) ?? "(no text)",
    });

    if (!spam) await relayToHuman({ fromE164, tn, body });

    // Empty TwiML: no auto-reply. Anything we send from here is an
    // app-originated message to a consumer, which is exactly what A2P 10DLC
    // registration governs — so replies stay a deliberate, separate decision.
    return xmlResponse("<Response/>");
  } catch (err) {
    // 500 so Twilio retries — the insert is idempotent, so a retry is safe and a
    // dropped text is not.
    console.error("[twilio/sms] error", err);
    return new Response("error", { status: 500 });
  }
}

/** Stages an open lead can still be sitting in — anything past these is finished. */
const OPEN_STAGES = ["new", "working", "qualified", "quoted"] as const;

/**
 * Attach this text to the thread's still-open lead, or start a new one.
 *
 * The window matters for ROI: without it, every follow-up text would mint a lead
 * and inflate the count; with a lead reused forever, a repeat customer's second
 * job would never be counted at all.
 */
async function attachToOpenLeadOrCreate(args: {
  thread: { conversationId: string; contactId: string };
  fromE164: string;
  body: string;
  sourceId: string | null;
  lease: typeof numberAssignments.$inferSelect | null;
  location: "edwardsville" | "ofallon" | "unknown";
  spam: boolean;
}): Promise<string> {
  const { thread, fromE164, body, sourceId, lease, location, spam } = args;

  const [open] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.conversationId, thread.conversationId), inArray(leads.status, [...OPEN_STAGES])))
    .orderBy(desc(leads.occurredAt))
    .limit(1);
  // Deliberately returned untouched: a follow-up text joining a lead already in
  // flight must NOT rewrite the attribution that earned it — the same rule
  // `lib/messaging/thread.ts` enforces for threads. The lease below is copied on
  // the INSERT path only.
  if (open) return open.id;

  // Link to an EXISTING campaign by name only, exactly as `/api/twilio/voice`
  // does — the lease carries `utm_campaign` text while campaigns are keyed
  // (platform, external_campaign_id) by the spend sync. Never creates a row.
  let campaignId: string | null = null;
  if (lease?.campaign) {
    const [c] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.name, lease.campaign))
      .limit(1);
    campaignId = c?.id ?? null;
  }

  // Carry the DNI lease's frozen attribution onto the lead, the way the voice
  // route already does for calls. Without it a text had NO path to a click id at
  // all: `messages` and `leads` carry no `number_assignment_id`, and the
  // conversion exporter reaches leases only through `calls`. So a paid text
  // reached `attributions` and campaign-level roi_daily with a NULL campaign, and
  // exported to Google matched on a hashed phone when its gclid was sitting right
  // here — the identical defect the comment in `/api/twilio/voice` describes.
  const [lead] = await db
    .insert(leads)
    .values({
      type: "sms",
      status: spam ? "spam" : "new",
      phoneE164: fromE164,
      message: body || null,
      conversationId: thread.conversationId,
      contactId: thread.contactId,
      sourceId,
      location,
      isSpam: spam,
      campaignId,
      medium: lease?.medium ?? null,
      keyword: lease?.keyword ?? null,
      gclid: lease?.gclid ?? null,
      gbraid: lease?.gbraid ?? null,
      wbraid: lease?.wbraid ?? null,
      fbclid: lease?.fbclid ?? null,
      landingPage: lease?.landingPage ?? null,
      visitorId: lease?.visitorId ?? null,
      webSessionId: lease?.webSessionId ?? null,
      // Left unclassified on purpose — see the note at the top of this file.
      isLead: spam ? false : null,
      leadReason: spam ? "spam rule: blocked number" : null,
    })
    .returning({ id: leads.id });
  return lead.id;
}

/**
 * Honour STOP/START in the message body.
 *
 * Twilio's Advanced Opt-Out handles the carrier side automatically for numbers in
 * a messaging service; this mirrors the state locally so the app never queues a
 * send that would come back as error 21610, and so the thread can say plainly that
 * this person has opted out.
 */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

async function applyOptOutKeywords(contactId: string, body: string) {
  const word = body.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return;
  try {
    if (STOP_WORDS.has(word)) await markSmsOptedOut(contactId);
    else if (START_WORDS.has(word)) await clearSmsOptOut(contactId);
  } catch (err) {
    console.error("[twilio/sms] opt-out bookkeeping failed (text still captured)", err);
  }
}

/** Twilio sends MMS attachments as NumMedia + MediaUrl0/MediaContentType0/… */
function collectMedia(params: Record<string, string>) {
  const count = Number(params.NumMedia ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  const items = [];
  for (let i = 0; i < count; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) items.push({ url, contentType: params[`MediaContentType${i}`] ?? null });
  }
  return items.length ? items : null;
}

/**
 * Relay the text to a human so nobody has to be watching the dashboard.
 *
 * Sent FROM the tracking number the customer texted, which means a reply from the
 * office goes back to that tracking number and lands in this same thread rather
 * than reaching the customer — so the relay includes the customer's number to
 * text directly. Best-effort: a relay failure must not cost us the captured text.
 */
async function relayToHuman(args: {
  fromE164: string;
  tn: typeof trackingNumbers.$inferSelect;
  body: string;
}) {
  const { fromE164, tn, body } = args;
  const to = await getSmsForwardNumber();
  if (!to) return; // relaying deliberately off

  try {
    const client = await getTwilioClient();
    const label = tn.friendlyName ? `${tn.friendlyName} ${tn.phoneNumber}` : tn.phoneNumber;
    await client.messages.create({
      from: tn.phoneNumber,
      to,
      body: `New text to ${label}\nFrom ${fromE164}\n\n${body || "(no text)"}\n\nReply directly to ${fromE164}.`,
    });
  } catch (err) {
    console.error("[twilio/sms] relay failed (text captured)", err);
  }
}
