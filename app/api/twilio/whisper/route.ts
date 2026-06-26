import { whisperTwiml, xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

/**
 * The whisper leg: spoken to the answering rep before the caller is bridged, so
 * they know it's a tracked lead and from which source. Twilio fetches this via
 * the <Number url="..."> in the dial verb.
 */
function handle(req: Request): Response {
  const text = new URL(req.url).searchParams.get("text") ?? "Tree lead";
  return xmlResponse(whisperTwiml(text));
}

export const GET = handle;
export const POST = handle;
