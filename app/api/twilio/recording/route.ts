import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { xmlResponse } from "@/lib/twilio/twiml";

export const runtime = "nodejs";

/**
 * Recording-ready callback. Stores the recording reference on the call. The heavy
 * lifting (copy to Vercel Blob + Deepgram transcription) is handed to Inngest so
 * this handler stays fast and Twilio doesn't retry on a slow response.
 *
 * Phase 5 wires the `call.recording.ready` event to the transcription pipeline;
 * for now we persist the URL so recordings are listenable in the dashboard.
 */
export async function POST(req: Request) {
  const { params, url } = await parseTwilioForm(req);
  if ((await validateTwilioSignature(req.headers.get("x-twilio-signature"), url, params)) === "invalid") {
    return new Response("invalid signature", { status: 403 });
  }

  const callSid = params.CallSid;
  const recordingUrl = params.RecordingUrl;
  const recordingSid = params.RecordingSid;
  const recordingDuration = params.RecordingDuration ? Number(params.RecordingDuration) : undefined;
  // Reliable: the voicemail <Record> callback is tagged ?src=voicemail; the <Dial>
  // recording is ?src=dial. (Old heuristic on a missing field could mislabel answers.)
  const isVoicemail = new URL(url).searchParams.get("src") === "voicemail";

  if (callSid && recordingUrl) {
    await db
      .update(calls)
      .set({
        // Twilio recordings need .mp3 appended and auth to fetch; Phase 5 copies
        // them to Vercel Blob. Store the canonical Twilio URL for now.
        recordingUrl: `${recordingUrl}.mp3`,
        recordingSid,
        recordingDurationSec: Number.isFinite(recordingDuration) ? recordingDuration : undefined,
        voicemail: isVoicemail,
      })
      .where(eq(calls.twilioCallSid, callSid));

    // Transcription runs via the batch job `syncTranscriptions` (POST /api/sync/transcribe,
    // Inngest cron at deploy) which picks up calls with a recording and no transcript.
    // A per-call Inngest event can replace the batch poll once Inngest is wired.
  }

  return xmlResponse("<Response/>");
}
