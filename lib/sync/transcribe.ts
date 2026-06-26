import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { transcribeRecording } from "@/lib/transcription/deepgram";
import { analyzeCall } from "@/lib/transcription/analyze";
import { withSyncRun } from "./run";

const SPAM_THRESHOLD = 0.5;

/**
 * transcription.process — transcribe call recordings that don't yet have a
 * transcript, then label intent + score spam. High-spam calls flip their lead to
 * spam (excluded from ROI). Batched so a run stays bounded; the recording webhook
 * can trigger this per-call once Inngest is wired.
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
      if (!call.recordingUrl) continue;
      try {
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
          spam++;
        }
        done++;
      } catch (err) {
        console.error("[transcribe] failed for call", call.id, err);
      }
    }

    return { transcribed: done, flaggedSpam: spam, pending: pending.length };
  });
}
