import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { transcribeRecording } from "@/lib/transcription/deepgram";
import { classifyCallLead } from "@/lib/transcription/classify-lead";
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
  // AI (or keyword) decides intent, spam, AND whether the caller is an actual lead
  // (requested an estimate) — that gates the call into the Leads inbox.
  const cls = await classifyCallLead(transcript);

  await db
    .update(calls)
    .set({
      transcript,
      transcriptConfidence: confidence != null ? confidence.toFixed(3) : null,
      transcriptProvider: provider,
      intentLabel: cls.intent,
      summary: cls.summary,
      selfReportedSource: cls.selfReportedSource,
      spamScore: cls.spamScore.toFixed(3),
    })
    .where(eq(calls.id, call.id));

  if (call.leadId) {
    const spam = cls.spamScore >= SPAM_THRESHOLD;
    // Self-reported source is data, not judgment — set it regardless of the manual
    // is_lead override below.
    if (cls.selfReportedSource) {
      await db.update(leads).set({ selfReportedSource: cls.selfReportedSource }).where(eq(leads.id, call.leadId));
    }
    // Skip if a human manually set is_lead — their decision wins over auto-classify.
    await db
      .update(leads)
      .set({
        isLead: spam ? false : cls.isLead,
        leadReason: cls.reason,
        ...(spam ? { isSpam: true, status: "spam" as const } : {}),
      })
      .where(and(eq(leads.id, call.leadId), eq(leads.isLeadManual, false)));
    if (spam) return "spam";
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
