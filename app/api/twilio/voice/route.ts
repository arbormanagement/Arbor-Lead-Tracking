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
import { getTwilioConfig } from "@/lib/twilio/client";
import {
  forwardTwiml,
  rejectTwiml,
  fallbackTwiml,
  xmlResponse,
} from "@/lib/twilio/twiml";
import { normalizePhone } from "@/lib/phone";
import { env } from "@/lib/env";

export const runtime = "nodejs";
// This webhook must answer in well under 3s or the caller hears dead air.
export const maxDuration = 10;

const GRACE_MS = 15 * 60 * 1000; // resolve a recently-released lease to its source

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

  // Account-level forwarding default (DB over env). A matched tracking number may
  // override this with its own destination below.
  const accountDefault = (await getTwilioConfig()).defaultDestination ?? env.TWILIO_DEFAULT_DESTINATION;
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
      return xmlResponse(rejectTwiml());
    }

    // 4) Persist the call + lead immediately (status callbacks fill in the rest).
    await recordCall({ callSid, fromE164, tn, assignmentId, sourceKey, destination, status: "ringing" });

    // 5) Forward with whisper + (optional) dual-channel recording. Per-number
    //    whisper/recording overrides win over the source-derived defaults.
    const whisper = tn.whisperMessage ?? (sourceKey ? `Tree lead from ${sourceKey}` : "Tree lead");
    return xmlResponse(
      forwardTwiml({
        destination,
        whisper,
        record: tn.recordCalls,
        recordingNotice: "This call may be recorded for quality.",
      }),
    );
  } catch (err) {
    // Never leave the caller in dead air — forward to the office on any error.
    console.error("[twilio/voice] error", err);
    return xmlResponse(fallbackTwiml());
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
      return fromE164.includes(r.pattern);
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

  // Resolve source id (best-effort) for the denormalized lead row.
  let sourceId: string | null = null;
  if (sourceKey) {
    const [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, sourceKey)).limit(1);
    sourceId = src?.id ?? null;
  }

  // Idempotent on twilio_call_sid — the voice webhook can fire more than once.
  const existing = await db.select({ id: calls.id }).from(calls).where(eq(calls.twilioCallSid, callSid)).limit(1);
  if (existing.length) return;

  // Repeat-caller detection (one quick indexed lookup — keep the webhook fast).
  let isFirstTime = true;
  if (fromE164) {
    const prior = await db.select({ id: calls.id }).from(calls).where(eq(calls.fromNumber, fromE164)).limit(1);
    isFirstTime = prior.length === 0;
  }

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

  await db.insert(calls).values({
    leadId: lead.id,
    twilioCallSid: callSid,
    trackingNumberId: tn.id,
    numberAssignmentId: assignmentId,
    fromNumber: fromE164,
    toDestination: destination,
    direction: "inbound",
    status,
  });
}
