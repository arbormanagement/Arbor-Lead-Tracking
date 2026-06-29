import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

/**
 * Dial status callback — fills in answered/duration once the call leg completes.
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

  // Empty TwiML — nothing more to do on this leg.
  return xmlResponse("<Response/>");
}
