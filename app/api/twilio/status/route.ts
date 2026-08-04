import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

/**
 * Dial status callback — fills in answered/duration once the dial leg completes.
 *
 * Two distinct Twilio event sources land here and must NOT be conflated:
 *  - the <Dial action> callback carries DialCallStatus/DialCallDuration — the
 *    dial-leg outcome, which is what answered/duration/status mean on `calls`;
 *  - the phone-number-level statusCallback (set in `provisionNumber`) fires
 *    CallStatus=completed on EVERY call with the whole-call duration and no
 *    DialCallStatus. Treating that as the dial outcome marked every call answered.
 * So we only write when DialCallStatus is present; number-level events are acked
 * and ignored.
 */
export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  const sig = await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params);
  if (sig === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }
  // Pure write endpoint — unlike /voice (which fails OPEN so a call is never
  // dropped), an unverifiable request must not be allowed to write in production.
  if (sig === "unresolved" && env.NODE_ENV === "production") {
    console.error(
      "[twilio/status] no auth token available to verify the Twilio signature — rejecting write. Fix the Twilio credentials.",
    );
    return new Response("signature unresolved", { status: 403 });
  }

  const callSid = params.CallSid;
  const dialStatus = params.DialCallStatus;

  if (callSid && dialStatus) {
    const durationSec = params.DialCallDuration ? Number(params.DialCallDuration) : undefined;
    await db
      .update(calls)
      .set({
        status: dialStatus,
        answered: dialStatus === "completed" || dialStatus === "answered",
        durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
      })
      .where(eq(calls.twilioCallSid, callSid));
  }

  // Empty TwiML — with no verbs after the <Dial>, the call simply ends here (the
  // forward destination's own voicemail/AI covers no-answers; app-side voicemail
  // is deliberately out). For number-level events this is a harmless ack.
  return xmlResponse("<Response/>");
}
