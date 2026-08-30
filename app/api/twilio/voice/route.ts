import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads, numberAssignments, trackingNumbers } from "@/lib/db/schema";
import { resolveCampaignIdByName } from "@/lib/campaigns";
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
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Hard ceiling on attribution work before we forward anyway. Twilio gives the
 * webhook ~15s, but the caller hears silence the whole time, so the real budget is
 * well under 3s.
 *
 * A try/catch alone does NOT enforce this: it fires on a thrown error, never on
 * slowness. A saturated-but-alive pool (max 5 connections, shared with the
 * dashboard) or a DB accepting connections but responding slowly would block this
 * route through its sequential round-trips with no bail-out — the caller hears
 * dead air until Twilio times out and falls back. This deadline is what makes the
 * "never leave a caller in dead air" promise actually hold.
 */
const VOICE_DEADLINE_MS = 2_000;

export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  const signature = req.headers.get("x-twilio-signature");

  // Tri-state: reject only a confirmed-bad signature. "unresolved" (no token) fails
  // OPEN — we forward rather than drop a real call.
  if ((await validateTwilioSignature(signature, url, params)) === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }

  // Best destination known so far, read by the deadline timer below — so it must
  // stay a plain synchronous read. Upgraded as we learn more (env default →
  // account default → per-number override) so a bail-out rings the most correct
  // number available rather than always the env one.
  const dest = { current: env.TWILIO_DEFAULT_DESTINATION };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[twilio/voice] exceeded ${VOICE_DEADLINE_MS}ms — forwarding without attribution`);
      resolve(fallbackTwiml(dest.current));
    }, VOICE_DEADLINE_MS);
  });

  try {
    // The losing side keeps running: `recordCall` is idempotent on
    // twilio_call_sid, so a lookup that lands after the deadline still records
    // the call and threads it. We trade attribution-in-the-TwiML for never
    // stalling the caller.
    return xmlResponse(await Promise.race([buildCallTwiml(params, dest), deadline]));
  } finally {
    clearTimeout(timer);
  }
}

async function buildCallTwiml(params: Record<string, string>, dest: { current: string }): Promise<string> {
  const callSid = params.CallSid;
  const fromRaw = params.From;
  const calledNumber = params.To; // the tracking number that was dialed
  const fromE164 = normalizePhone(fromRaw);

  try {
    // Account-level forwarding default (Settings → Routing, over env). A matched tracking number may
    // override this with its own destination below.
    const accountDefault = await getDefaultForwardNumber();
    dest.current = accountDefault;
    let destination = accountDefault;

    // 1) Resolve which tracking number was called.
    const [tn] = await db
      .select()
      .from(trackingNumbers)
      .where(eq(trackingNumbers.phoneNumber, calledNumber))
      .limit(1);

    if (!tn) {
      // Unknown number — just forward to the office so no call is lost.
      return fallbackTwiml(destination);
    }

    // Per-number routing override (falls back to the account default).
    destination = tn.forwardDestination ?? accountDefault;
    dest.current = destination;

    // 2) Resolve attribution.
    //    Static numbers map straight to their source; pooled numbers resolve to
    //    the most-recent (active or recently-released) session lease.
    const { sourceKey, assignmentId, lease, conversionPage, staticCampaignId } = await resolveInboundAttribution(tn);

    // 3) Spam pre-check (hard rules only — keep it fast).
    if (fromE164 && (await isHardSpamNumber(fromE164))) {
      await recordCall({ callSid, fromE164, tn, assignmentId, lease, conversionPage, staticCampaignId, sourceKey, destination, status: "rejected_spam" });
      return rejectTwiml();
    }

    // 4) Persist the call + lead immediately (status callbacks fill in the rest).
    await recordCall({ callSid, fromE164, tn, assignmentId, lease, conversionPage, staticCampaignId, sourceKey, destination, status: "ringing" });

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
    //    A CUSTOM greeting no longer suppresses the notice — forwardTwiml appends it
    //    unless the configured text already mentions recording.
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
    return forwardTwiml({
      destination,
      whisper,
      record: tn.recordCalls,
      greeting,
    });
  } catch (err) {
    // Never leave the caller in dead air — forward to the office on any error.
    console.error("[twilio/voice] error", err);
    return fallbackTwiml(dest.current);
  }
}

async function recordCall(args: {
  callSid: string;
  fromE164: string | null;
  tn: typeof trackingNumbers.$inferSelect;
  assignmentId: string | null;
  lease: typeof numberAssignments.$inferSelect | null;
  /** Last page of the leased session — what the caller was reading when they dialled. */
  conversionPage: string | null;
  /** Set only for a static number that names a campaign — see resolveInboundAttribution. */
  staticCampaignId: string | null;
  sourceKey: string | null;
  destination: string;
  status: string;
}) {
  const { callSid, fromE164, tn, assignmentId, lease, conversionPage, staticCampaignId, sourceKey, destination, status } = args;

  // Resolve source id (best-effort) for the denormalized lead row.
  const sourceId = await ensureSourceId(sourceKey);

  // Link to an EXISTING campaign by the lease's `utm_campaign` text. Shared with
  // the form and SMS paths so all three agree on what a match means.
  //
  // A STATIC number has no lease, so it names its campaign directly. Checked first
  // because it is a configured fact about the number rather than an inference from
  // whatever a visitor's URL happened to carry — and the two cannot both apply, as
  // only a pooled number ever has a lease.
  const campaignId = staticCampaignId ?? (await resolveCampaignIdByName(lease?.campaign));

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

  // Thread it FIRST, so the lead is born already attached to the caller's
  // conversation — a returning customer's new call joins the thread that already
  // holds their form submission and last month's texts. Best-effort: the inbox is
  // a read surface, and a threading failure must never cost us the forward TwiML.
  let thread: Awaited<ReturnType<typeof upsertThread>> = null;
  try {
    thread = await upsertThread(
      { phone: fromE164 },
      {
        endpointKey: tn.phoneNumber,
        trackingNumberId: tn.id,
        numberAssignmentId: assignmentId,
        sourceId,
      },
    );
  } catch (err) {
    console.error("[twilio/voice] threading failed (call still recorded)", err);
  }

  // Carry the DNI lease's frozen attribution onto the lead. Copying only the
  // source discarded the campaign, keyword, click ids, landing page and the
  // session/visitor link — all captured at assign time and all sitting on the
  // lease. Nothing backfilled them, so every DNI call lead reached `attributions`
  // and campaign-level roi_daily with a NULL campaign and NULL gclid: paid calls
  // could be credited to a source but never to the campaign or click that actually
  // produced them, and the offline-conversion upload had no gclid to send.
  const [lead] = await db
    .insert(leads)
    .values({
      type: "call",
      status: status === "rejected_spam" ? "spam" : "new",
      phoneE164: fromE164,
      conversationId: thread?.conversationId ?? null,
      contactId: thread?.contactId ?? null,
      sourceId,
      location: tn.location ?? "unknown",
      isSpam: status === "rejected_spam",
      isFirstTime,
      campaignId,
      medium: lease?.medium ?? null,
      keyword: lease?.keyword ?? null,
      gclid: lease?.gclid ?? null,
      gbraid: lease?.gbraid ?? null,
      wbraid: lease?.wbraid ?? null,
      fbclid: lease?.fbclid ?? null,
      landingPage: lease?.landingPage ?? null,
      conversionPage,
      visitorId: lease?.visitorId ?? null,
      webSessionId: lease?.webSessionId ?? null,
    })
    .returning({ id: leads.id });

  if (thread) {
    try {
      await recordThreadActivity(thread.conversationId, {
        channel: "call",
        direction: "inbound",
        preview: status === "rejected_spam" ? "Blocked as spam" : "Inbound call",
      });
    } catch (err) {
      console.error("[twilio/voice] thread activity failed (call still recorded)", err);
    }
  }

  await db
    .update(calls)
    .set({ leadId: lead.id, conversationId: thread?.conversationId ?? null })
    .where(eq(calls.id, inserted.id));
}
