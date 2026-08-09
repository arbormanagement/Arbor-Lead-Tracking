import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  calls,
  leads,
  numberAssignments,
  sources,
  spamRules,
  trackingNumbers,
} from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
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

const GRACE_MS = 15 * 60 * 1000; // resolve a recently-released lease to its source

/**
 * Hard ceiling on attribution work before we forward anyway. Twilio gives the
 * webhook ~15s, but the caller hears silence the whole time, so the real budget is
 * well under 3s.
 *
 * A try/catch alone does NOT enforce this: it fires on a thrown error, never on
 * slowness. A saturated-but-alive pool (max 5 connections, shared with the
 * dashboard) or a DB accepting connections but responding slowly would block this
 * route through ~8-11 sequential round-trips with no bail-out — the caller hears
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
    // the call. We trade attribution-in-the-TwiML for never stalling the caller.
    return xmlResponse(await Promise.race([buildCallTwiml(params, dest), deadline]));
  } finally {
    clearTimeout(timer);
  }
}

async function buildCallTwiml(
  params: Record<string, string>,
  dest: { current: string },
): Promise<string> {
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
    let sourceKey: string | null = null;
    let assignmentId: string | null = null;

    if (tn.isStatic && tn.staticSourceId) {
      const [src] = await db
        .select({ key: sources.key })
        .from(sources)
        .where(eq(sources.id, tn.staticSourceId))
        .limit(1);
      sourceKey = src?.key ?? null;
    } else {
      const graceCutoff = new Date(Date.now() - GRACE_MS);
      const [assignment] = await db
        .select()
        .from(numberAssignments)
        .where(
          and(
            eq(numberAssignments.trackingNumberId, tn.id),
            or(isNull(numberAssignments.releasedAt), gt(numberAssignments.releasedAt, graceCutoff)),
          ),
        )
        .orderBy(desc(numberAssignments.assignedAt))
        .limit(1);
      if (assignment) {
        assignmentId = assignment.id;
        sourceKey = assignment.source ?? null;
      }
    }

    // 3) Spam pre-check (hard rules only — keep it fast).
    if (fromE164 && (await isHardSpam(fromE164))) {
      await recordCall({ callSid, fromE164, tn, assignmentId, sourceKey, destination, status: "rejected_spam" });
      return rejectTwiml();
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

async function isHardSpam(fromE164: string): Promise<boolean> {
  const rules = await db
    .select()
    .from(spamRules)
    .where(and(eq(spamRules.field, "from_number"), eq(spamRules.enabled, true), eq(spamRules.action, "reject")));
  return rules.some((r) => {
    try {
      return new RegExp(r.pattern).test(fromE164);
    } catch {
      // A bad pattern must never 500 the hot path — skip the rule and surface it.
      console.warn("[twilio/voice] invalid spam rule pattern — skipping:", r.pattern);
      return false;
    }
  });
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

  // Resolve source id (best-effort) for the denormalized lead row. Create the
  // row when missing — a DNI lease can freeze a key (e.g. facebook/organic)
  // before any pageview reached /api/track to create it (ad-blocked snippet).
  let sourceId: string | null = null;
  if (sourceKey) {
    let [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, sourceKey)).limit(1);
    if (!src) {
      await db
        .insert(sources)
        .values({ key: sourceKey, displayName: sourceKey })
        .onConflictDoNothing({ target: sources.key });
      [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, sourceKey)).limit(1);
    }
    sourceId = src?.id ?? null;
  }

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

  await db.update(calls).set({ leadId: lead.id }).where(eq(calls.id, inserted.id));
}
