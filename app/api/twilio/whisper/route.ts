import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { whisperTwiml, xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

/**
 * The whisper leg: spoken to the answering rep before the caller is bridged, so
 * they know it's a tracked lead and from which source. Twilio fetches this via
 * the <Number url="..."> in the dial verb.
 *
 * Signature-checked like the other webhooks; "unresolved" fails OPEN here — this
 * is read-only TwiML, so a credentials misconfig must not break the whisper leg.
 */
async function handle(req: Request): Promise<Response> {
  const { params, url } = await parseTwilioForm(req);
  if ((await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }

  const text = new URL(url).searchParams.get("text") ?? "Tree lead";
  return xmlResponse(whisperTwiml(text));
}

export const GET = handle;
export const POST = handle;
