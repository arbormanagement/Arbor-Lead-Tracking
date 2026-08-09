import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads, trackingNumbers } from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { ensureSourceId, isHardSpamNumber, resolveInboundAttribution } from "@/lib/twilio/inbound";
import { recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { getDefaultForwardNumber } from "@/lib/routing";
import {
  DEFAULT_RECORDING_NOTICE,
  forwardTwiml,
  rejectTwiml,
  fallbackTwiml,
  xmlResponse,
} from "@/lib/twilio/twiml";
import { normalizePhone } from "@/lib/phone";

export const runtime = "nodejs";
// This webhook must answer in well under 3s or the caller hears dead air.
export const maxDuration = 10;

export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  const signature = req.headers.get("x-twilio-signature");

  // Tri-state: reject only a confirmed-bad signature. "unresolved" (no token) fails
  // OPEN — we forward rather than drop a real call.
  if ((await validateTwilioSignature(signature, url, params)) === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }

  const callSid = params.CallSid;
  const fromRaw = params.From;
  const calledNumber = params.To; // the tracking number that was dialed
  const fromE164 = normalizePhone(fromRaw);

  // Account-level forwarding default (Settings → Routing, over env). A matched tracking number may
  // override this with its own destination below.
  const accountDefault = await getDefaultForwardNumber();
  let destination = accountDefault;

  try {
    // 1) Resolve which tracking number was called.
    const [tn] = await db
      .select()
      .from(trackingNumbers)
      .where(eq(trackingNumbers.phoneNumber, calledNumber))
      .limit(1);

    if (!tn) {
      // Unknown number — just forward to the office so no call is lost.
      return xmlResponse(fallbackTwiml());
    }

    // Per-number routing override (falls back to the account default).
    destination = tn.forwardDestination ?? accountDefault;

    // 2) Resolve attribution.
    //    Static numbers map straight to their source; pooled numbers resolve to
    //    the most-recent (active or recently-released) session lease.
    const { sourceKey, assignmentId } = await resolveInboundAttribution(tn);

    // 3) Spam pre-check (hard rules only — keep it fast).
    if (fromE164 && (await isHardSpamNumber(fromE164))) {
      await recordCall({ callSid, fromE164, tn, assignmentId, sourceKey, destination, status: "rejected_spam" });
      return xmlResponse(rejectTwiml());
    }

    // 4) Persist the call + lead immediately (status callbacks fill in the rest).
    await recordCall({ callSid, fromE164, tn, assignmentId, sourceKey, destination, status: "ringing" });

    // 5) Forward with an optional pre-call message + whisper + (optional) recording.
    //    All three are per-number overrides.
    //
    //    `greetingEnabled: false` is honoured as a DELIBERATE opt-out (passed as null),
    //    rather than being silently overridden by the recording notice as it was before.
    //    The toggle previously did nothing whenever recording was on, which made the UI
    //    lie about the call's actual behaviour.
    //
    //    ⚠️ Turning it off means the app plays NO recording notice, so the disclosure
    //    rests entirely on the forward destination announcing it. That holds today only
    //    because +16182059924 is Chloe, who opens with "on a recorded line" — and note
    //    that is model-generated (Retell `begin_message` is null), not a fixed script.
    //    Re-enable the greeting for any number pointed at a human or a bare voicemail.
    // NO default whisper. A whisper is TwiML on <Number url=…>, which plays into the
    // ANSWERING party's ear before the caller is bridged — and the forward destination
    // is Retell's voice agent (Chloe), not a human rep. Retell's ASR transcribes the
    // whisper as the caller's opening words and Chloe answers it: a "Tree lead from
    // direct" whisper came back as `User: Direct.` with Chloe cut off mid-greeting
    // (2026-08-08, first real call after the CallRail cutover). Because answerOnBridge
    // is on, the caller hears ringback throughout and lands mid-confusion.
    // Opt in per number only — meaningful again if a number ever forwards to a human.
    const whisper = tn.whisperMessage || undefined;
    const greeting = tn.greetingEnabled ? (tn.greetingMessage || DEFAULT_RECORDING_NOTICE) : null;
    return xmlResponse(
      forwardTwiml({
        destination,
        whisper,
        record: tn.recordCalls,
        greeting,
      }),
    );
  } catch (err) {
    // Never leave the caller in dead air — forward to the office on any error.
    console.error("[twilio/voice] error", err);
    return xmlResponse(fallbackTwiml());
  }
}

async function recordCall(args: {
  callSid: string;
  fromE164: string | null;
  tn: typeof trackingNumbers.$inferSelect;
  assignmentId: string | null;
  sourceKey: string | null;
  destination: string;
  status: string;
}) {
  const { callSid, fromE164, tn, assignmentId, sourceKey, destination, status } = args;

  // Resolve source id (best-effort) for the denormalized lead row.
  const sourceId = await ensureSourceId(sourceKey);

  // Repeat-caller detection (one quick indexed lookup — keep the webhook fast).
  // Runs BEFORE the call insert so it doesn't count this very call.
  let isFirstTime = true;
  if (fromE164) {
    const prior = await db.select({ id: calls.id }).from(calls).where(eq(calls.fromNumber, fromE164)).limit(1);
    isFirstTime = prior.length === 0;
  }

  // Idempotent on twilio_call_sid — the voice webhook can fire more than once,
  // concurrently. Insert the call row FIRST so the unique index arbitrates the
  // race; a check-then-insert here let two deliveries both create a lead. Only
  // the delivery that actually inserted the call goes on to create its lead.
  const [inserted] = await db
    .insert(calls)
    .values({
      twilioCallSid: callSid,
      trackingNumberId: tn.id,
      numberAssignmentId: assignmentId,
      fromNumber: fromE164,
      toDestination: destination,
      direction: "inbound",
      status,
    })
    .onConflictDoNothing({ target: calls.twilioCallSid })
    .returning({ id: calls.id });

  // Another delivery won the race — its call row (and lead) already exist.
  if (!inserted) return;

  const [lead] = await db
    .insert(leads)
    .values({
      type: "call",
      status: status === "rejected_spam" ? "spam" : "new",
      phoneE164: fromE164,
      sourceId,
      location: tn.location ?? "unknown",
      isSpam: status === "rejected_spam",
      isFirstTime,
    })
    .returning({ id: leads.id });

  // Thread it, so a text from the same caller to the same number joins this
  // conversation instead of starting a parallel one. Best-effort: the inbox is a
  // read surface, and a threading failure must never cost us the forward TwiML.
  let conversationId: string | null = null;
  if (fromE164) {
    try {
      const thread = await upsertThread(
        { contactKey: fromE164, endpointKey: tn.phoneNumber },
        { leadId: lead.id, trackingNumberId: tn.id, numberAssignmentId: assignmentId, sourceId },
      );
      conversationId = thread?.id ?? null;
      if (conversationId) {
        await recordThreadActivity(conversationId, {
          channel: "call",
          direction: "inbound",
          preview: status === "rejected_spam" ? "Blocked as spam" : "Inbound call",
        });
      }
    } catch (err) {
      console.error("[twilio/voice] threading failed (call recorded)", err);
    }
  }

  await db.update(calls).set({ leadId: lead.id, conversationId }).where(eq(calls.id, inserted.id));
}
