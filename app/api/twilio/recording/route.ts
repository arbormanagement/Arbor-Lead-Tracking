import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { validateTwilioSignature, parseTwilioForm } from "@/lib/twilio/signature";
import { xmlResponse } from "@/lib/twilio/twiml";
import { transcribeCall } from "@/lib/sync/transcribe";

export const runtime = "nodejs";

/**
 * Recording-ready callback. Stores the recording reference on the call, then kicks
 * off transcription for THIS call via `after()` — the work runs after the response
 * is flushed, so Twilio still gets an instant reply and won't retry on a slow
 * Deepgram call. The 10-minute `syncTranscriptions` cron remains as a backstop for any
 * call this trigger misses (idempotent: it skips calls that already have a transcript).
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
    const [row] = await db
      .update(calls)
      .set({
        // Twilio recordings need .mp3 appended and auth to fetch; Phase 5 copies
        // them to Vercel Blob. Store the canonical Twilio URL for now.
        recordingUrl: `${recordingUrl}.mp3`,
        recordingSid,
        recordingDurationSec: Number.isFinite(recordingDuration) ? recordingDuration : undefined,
        voicemail: isVoicemail,
      })
      .where(eq(calls.twilioCallSid, callSid))
      .returning({ id: calls.id });

    // Transcribe THIS call now (after the response flushes). Voicemails still get a
    // transcript; the batch cron backstops anything this misses. Never throws to Twilio.
    if (row?.id) {
      after(async () => {
        try {
          await transcribeCall(row.id);
        } catch (err) {
          console.error("[recording] per-call transcription failed for", row.id, err);
        }
      });
    }
  }

  return xmlResponse("<Response/>");
}
