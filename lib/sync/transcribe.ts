import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { transcribeRecording } from "@/lib/transcription/deepgram";
import { analyzeCall } from "@/lib/transcription/analyze";
import { withSyncRun } from "./run";

const SPAM_THRESHOLD = 0.5;

type PendingCall = { id: string; leadId: string | null; recordingUrl: string | null };

/**
 * Transcribe one call's recording, label intent, score spam, and flip the lead to
 * spam if over threshold. Idempotent: no-ops if there's no recording or a transcript
 * already exists (so the per-call trigger and the batch backstop can't double-work).
 * Returns what happened for logging.
 */
async function runTranscription(call: PendingCall): Promise<"transcribed" | "spam" | "skipped"> {
  if (!call.recordingUrl) return "skipped";

  const { transcript, confidence, provider } = await transcribeRecording(call.recordingUrl);
  const { intent, spamScore } = analyzeCall(transcript);

  await db
    .update(calls)
    .set({
      transcript,
      transcriptConfidence: confidence != null ? confidence.toFixed(3) : null,
      transcriptProvider: provider,
      intentLabel: intent,
      spamScore: spamScore.toFixed(3),
    })
    .where(eq(calls.id, call.id));

  if (spamScore >= SPAM_THRESHOLD && call.leadId) {
    await db.update(leads).set({ isSpam: true, status: "spam" }).where(eq(leads.id, call.leadId));
    return "spam";
  }
  return "transcribed";
}

/**
 * Event-driven entrypoint: transcribe a single call by id, right after its recording
 * lands. Fired from the Twilio recording callback via `after()` so Twilio still gets
 * an instant response. Re-reads the row so it's safe against races and reuses the same
 * idempotency guard as the batch job (recording present, transcript absent).
 */
export async function transcribeCall(callId: string): Promise<"transcribed" | "spam" | "skipped"> {
  const [call] = await db
    .select({
      id: calls.id,
      leadId: calls.leadId,
      recordingUrl: calls.recordingUrl,
      transcript: calls.transcript,
    })
    .from(calls)
    .where(eq(calls.id, callId))
    .limit(1);

  if (!call || !call.recordingUrl || call.transcript) return "skipped";
  return runTranscription(call);
}

/**
 * transcription.process — backstop batch: transcribe any calls that have a recording
 * but no transcript yet (e.g. if a per-call trigger was missed or Deepgram was down).
 * The recording webhook now transcribes per-call in real time; this keeps the system
 * self-healing on the 10-minute cron.
 */
export async function syncTranscriptions({ limit = 25 }: { limit?: number } = {}) {
  return withSyncRun("transcription.process", async () => {
    const pending = await db
      .select({ id: calls.id, leadId: calls.leadId, recordingUrl: calls.recordingUrl })
      .from(calls)
      .where(and(isNotNull(calls.recordingUrl), isNull(calls.transcript)))
      .limit(limit);

    let done = 0;
    let spam = 0;
    for (const call of pending) {
      try {
        const result = await runTranscription(call);
        if (result === "spam") spam++;
        if (result !== "skipped") done++;
      } catch (err) {
        console.error("[transcribe] failed for call", call.id, err);
      }
    }

    return { transcribed: done, flaggedSpam: spam, pending: pending.length };
  });
}
