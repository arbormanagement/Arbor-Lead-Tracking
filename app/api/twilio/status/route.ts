import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { xmlResponse, voicemailTwiml } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

// Dial outcomes where the callee never picked up — the caller is still on the
// line, so we take a voicemail. ("canceled" means the CALLER hung up; skip it.)
const UNANSWERED = new Set(["no-answer", "busy", "failed"]);

/**
 * Dial status callback — fills in answered/duration once the call leg completes.
 * This is the <Dial> `action` URL: Twilio replaces the original TwiML with our
 * response, so voicemail on an unanswered dial MUST be returned from here (any
 * verbs after <Dial> in the original document never execute).
 */
export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  if ((await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }

  const callSid = params.CallSid;
  const dialStatus = params.DialCallStatus ?? params.CallStatus;
  const durationSec = params.DialCallDuration
    ? Number(params.DialCallDuration)
    : params.CallDuration
      ? Number(params.CallDuration)
      : undefined;

  if (callSid) {
    await db
      .update(calls)
      .set({
        status: dialStatus,
        answered: dialStatus === "completed" || dialStatus === "answered",
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
      })
      .where(eq(calls.twilioCallSid, callSid));
  }

  // Unanswered dial leg (only the <Dial> action sends DialCallStatus; the
  // number-level status callback doesn't, and its response is ignored anyway) —
  // the caller is still connected, so take a voicemail.
  if (params.DialCallStatus && UNANSWERED.has(params.DialCallStatus)) {
    return xmlResponse(voicemailTwiml());
  }

  // Answered/completed — nothing more to do on this leg.
  return xmlResponse("<Response/>");
}
