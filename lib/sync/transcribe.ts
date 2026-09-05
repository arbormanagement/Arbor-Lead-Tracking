import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads, trackingNumbers } from "@/lib/db/schema";
import { transcribeRecording } from "@/lib/transcription/deepgram";
import { getTwilioClient } from "@/lib/twilio/client";
import { classifyCallLead } from "@/lib/transcription/classify-lead";
import { notManuallyDispositioned } from "@/lib/leads/classify-override";
import { preview, recordThreadActivity } from "@/lib/messaging/thread";
import { withSyncRun } from "./run";

const SPAM_THRESHOLD = 0.5;
/** Poison-pill guard: a call past this many failed attempts is dropped from the
 *  batch backlog (its transcribe_error keeps the last failure for inspection). */
const MAX_TRANSCRIBE_ATTEMPTS = 3;

type PendingCall = {
  id: string;
  leadId: string | null;
  recordingUrl: string | null;
  conversationId: string | null;
  createdAt: Date;
};

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
      // Success clears the retry bookkeeping.
      transcribeAttempts: 0,
      transcribeError: null,
    })
    .where(eq(calls.id, call.id));

  // Upgrade the inbox preview from "Inbound call" to what the call was actually
  // about. Passing the call's own timestamp means `recordThreadActivity` leaves
  // it alone if anything newer has landed since — a late transcript must not
  // bury a text that arrived in the meantime.
  if (call.conversationId && cls.summary) {
    try {
      await recordThreadActivity(call.conversationId, {
        channel: "call",
        direction: "inbound",
        preview: preview(cls.summary),
        occurredAt: call.createdAt,
        markUnread: false, // already counted when the call came in
      });
    } catch (err) {
      console.error("[transcribe] thread preview update failed", err);
    }
  }

  if (call.leadId) {
    const spam = cls.spamScore >= SPAM_THRESHOLD;
    // Self-reported source is data, not judgment — set it regardless of the manual
    // is_lead override below.
    if (cls.selfReportedSource) {
      await db.update(leads).set({ selfReportedSource: cls.selfReportedSource }).where(eq(leads.id, call.leadId));
    }
    // Skip if a human set the disposition — their decision wins over auto-classify.
    await db
      .update(leads)
      .set({
        disposition: spam ? "spam" : cls.isLead ? "requested_work" : "not_business",
        dispositionReason: cls.reason,
        isLead: spam ? false : cls.isLead,
        leadReason: cls.reason,
        ...(spam ? { isSpam: true, status: "spam" as const } : {}),
      })
      .where(and(eq(leads.id, call.leadId), notManuallyDispositioned));
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
      conversationId: calls.conversationId,
      createdAt: calls.createdAt,
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
    // Recover recordings whose status callback never landed, BEFORE selecting the
    // batch, so anything repaired is transcribed on this same tick.
    const recovered = await recoverMissingRecordings(limit);

    // Newest first, and skip calls past the retry cap — without both, 25
    // permanently-failing rows in planner order would starve the whole queue.
    const pending = await db
      .select({
        id: calls.id,
        leadId: calls.leadId,
        recordingUrl: calls.recordingUrl,
        conversationId: calls.conversationId,
        createdAt: calls.createdAt,
      })
      .from(calls)
      .where(
        and(
          isNotNull(calls.recordingUrl),
          isNull(calls.transcript),
          lt(calls.transcribeAttempts, MAX_TRANSCRIBE_ATTEMPTS),
        ),
      )
      .orderBy(desc(calls.createdAt))
      .limit(limit);

    let done = 0;
    let spam = 0;
    let failed = 0;
    for (const call of pending) {
      try {
        const result = await runTranscription(call);
        if (result === "spam") spam++;
        if (result !== "skipped") done++;
      } catch (err) {
        failed++;
        console.error("[transcribe] failed for call", call.id, err);
        await db
          .update(calls)
          .set({
            transcribeAttempts: sql`${calls.transcribeAttempts} + 1`,
            transcribeError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          })
          .where(eq(calls.id, call.id));
      }
    }

    return { transcribed: done, flaggedSpam: spam, failed, pending: pending.length, recoveredRecordings: recovered };
  });
}

/** Only look at calls old enough that the recording callback has certainly had its
 *  chance — a recording is not available the instant a call ends. */
const RECORDING_GRACE_MIN = 15;

/**
 * Repair calls that should have a recording but don't.
 *
 * `recordingStatusCallback` is the ONLY writer of calls.recording_url, and Twilio
 * does not retry it. One failed delivery (a deploy, a DB blip, the auth token
 * briefly unset — which happened for weeks in 2026) therefore loses the recording
 * permanently as far as this app is concerned: the audio still exists at Twilio,
 * but nothing ever looks for it again, so no transcript, no spam score, and no
 * is_lead classification is ever produced for that call. The transcription
 * backstop can't help, because it only scans calls that ALREADY have a URL.
 *
 * So ask Twilio directly, keyed on the CallSid we already hold.
 */
async function recoverMissingRecordings(limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - RECORDING_GRACE_MIN * 60_000);
  const orphans = await db
    .select({ id: calls.id, sid: calls.twilioCallSid })
    .from(calls)
    .innerJoin(trackingNumbers, eq(calls.trackingNumberId, trackingNumbers.id))
    .where(
      and(
        isNull(calls.recordingUrl),
        eq(calls.answered, true),
        eq(trackingNumbers.recordCalls, true),
        lt(calls.createdAt, cutoff),
        // Bound the search window: an old call whose recording was never fetched
        // has likely aged past Twilio's retention, and re-asking forever would turn
        // this into an unbounded scan on every tick.
        gte(calls.createdAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    )
    .orderBy(desc(calls.createdAt))
    .limit(limit);
  if (!orphans.length) return 0;

  let fixed = 0;
  for (const o of orphans) {
    try {
      const client = await getTwilioClient();
      const recordings = await client.recordings.list({ callSid: o.sid, limit: 1 });
      const rec = recordings[0];
      if (!rec) continue;
      // Match the shape the webhook stores (no extension — the fetchers add auth
      // and Twilio content-negotiates).
      const url = `https://api.twilio.com${rec.uri.replace(/\.json$/, "")}`;
      await db
        .update(calls)
        .set({ recordingUrl: url, recordingSid: rec.sid, recordingDurationSec: Number(rec.duration) || null })
        .where(eq(calls.id, o.id));
      fixed++;
      console.warn(`[transcribe] recovered missing recording for call ${o.sid} — its status callback never landed`);
    } catch (err) {
      console.error("[transcribe] recording recovery failed for", o.sid, err);
    }
  }
  return fixed;
}
