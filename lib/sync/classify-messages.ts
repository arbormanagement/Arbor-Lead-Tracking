import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, messages } from "@/lib/db/schema";
import { classifyCallLead } from "@/lib/transcription/classify-lead";
import { notManuallyDispositioned } from "@/lib/leads/classify-override";
import { withSyncRun } from "./run";

/** Mirrors SPAM_THRESHOLD in lib/sync/transcribe.ts. */
const SPAM_THRESHOLD = 0.5;
/** Enough of a thread to judge intent without paying for a long back-and-forth. */
const MAX_MESSAGES = 10;

/**
 * Decide whether inbound texts are real estimate requests.
 *
 * The SMS webhook deliberately leaves `is_lead` NULL — it has a Twilio timeout to
 * respect and an unclassified text must not be presumed a lead. This job closes
 * that loop, exactly as the transcription sync does for calls, which is what keeps
 * the Leads list to confirmed estimate requests only.
 *
 * Classification reads the whole inbound side of the thread, not just the newest
 * text: people split "Hi" / "do you do stump grinding?" / "in Edwardsville" across
 * three messages, and any one of them alone reads as noise.
 *
 * Idempotent and self-healing: it only picks up leads still sitting at NULL, and a
 * failure just leaves the row for the next tick. Manual overrides are never touched.
 */
export async function syncMessageClassification({ limit = 25 }: { limit?: number } = {}) {
  return withSyncRun("messages.classify", async () => {
    const pending = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.type, "sms"), isNull(leads.isLead), eq(leads.isLeadManual, false)))
      .orderBy(desc(leads.occurredAt))
      .limit(limit);

    let classified = 0;
    let qualified = 0;
    let spam = 0;
    let failed = 0;

    for (const lead of pending) {
      try {
        const thread = await db
          .select({ body: messages.body })
          .from(messages)
          .where(and(eq(messages.leadId, lead.id), eq(messages.direction, "inbound")))
          .orderBy(asc(messages.occurredAt))
          .limit(MAX_MESSAGES);

        const text = thread
          .map((m) => m.body?.trim())
          .filter(Boolean)
          .join("\n");

        // No words to judge (an MMS with no caption, say) — leave it NULL so it
        // stays out of Leads and gets another look if more text arrives.
        if (!text) continue;

        const cls = await classifyCallLead(text, "text");
        const isSpam = cls.spamScore >= SPAM_THRESHOLD;

        await db
          .update(leads)
          .set({
            disposition: isSpam ? "spam" : cls.isLead ? "requested_work" : "not_business",
            dispositionReason: cls.reason,
            isLead: isSpam ? false : cls.isLead,
            leadReason: cls.reason,
            ...(cls.selfReportedSource ? { selfReportedSource: cls.selfReportedSource } : {}),
            ...(isSpam ? { isSpam: true, status: "spam" as const } : {}),
          })
          // Re-check the override: a human may have decided while this ran.
          .where(and(eq(leads.id, lead.id), notManuallyDispositioned));

        classified++;
        if (isSpam) spam++;
        else if (cls.isLead) qualified++;
      } catch (err) {
        failed++;
        console.error("[classify-messages] failed for lead", lead.id, err);
      }
    }

    return { pending: pending.length, classified, qualified, flaggedSpam: spam, failed };
  });
}
