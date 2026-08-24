import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { classifyCallLead } from "@/lib/transcription/classify-lead";

/**
 * Manual lead override — the Lead/Not toggle, shared by POST
 * /api/leads/[id]/classify and the MCP `classify_lead` tool.
 *
 * Setting a boolean marks the lead and sets `is_lead_manual`, so
 * auto-classification (AI/keyword) won't overwrite the human decision.
 * `isLead: null` clears the override back to auto — re-running the classifier
 * on the call transcript so the stale manual verdict doesn't linger, or
 * leaving is_lead null (unclassified) when there's no transcript to classify.
 *
 * Returns null when the lead does not exist.
 */
export async function setLeadClassification(
  id: string,
  isLead: boolean | null,
): Promise<{ id: string; isLead: boolean | null; isLeadManual: boolean } | null> {
  if (isLead !== null) {
    const [row] = await db
      .update(leads)
      .set({ isLead, isLeadManual: true, leadReason: isLead ? "manual: marked lead" : "manual: not a lead" })
      .where(eq(leads.id, id))
      .returning({ id: leads.id, isLead: leads.isLead, isLeadManual: leads.isLeadManual });
    return row ?? null;
  }

  // Clearing: re-run the automatic verdict rather than keeping the manual one in
  // is_lead. Same call pattern as lib/sync/transcribe.ts (spam floors is_lead to false).
  const [call] = await db
    .select({ transcript: calls.transcript })
    .from(calls)
    .where(eq(calls.leadId, id))
    .limit(1);

  let auto: { isLead: boolean | null; leadReason: string };
  if (call?.transcript) {
    const cls = await classifyCallLead(call.transcript);
    const spam = cls.spamScore >= 0.5; // mirrors SPAM_THRESHOLD in lib/sync/transcribe.ts
    auto = { isLead: spam ? false : cls.isLead, leadReason: cls.reason };
  } else {
    // No transcript to classify — back to unclassified.
    auto = { isLead: null, leadReason: "auto (override cleared)" };
  }

  const [row] = await db
    .update(leads)
    .set({ isLeadManual: false, ...auto })
    .where(eq(leads.id, id))
    .returning({ id: leads.id, isLead: leads.isLead, isLeadManual: leads.isLeadManual });

  return row ?? null;
}
