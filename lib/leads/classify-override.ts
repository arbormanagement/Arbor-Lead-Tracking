import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { classifyCallLead } from "@/lib/transcription/classify-lead";

export type LeadDisposition = (typeof leads.$inferSelect)["disposition"];

/**
 * Set an enquiry's DISPOSITION by hand — why nothing (or something) came of it.
 * Shared by POST /api/leads/[id]/disposition and the MCP `arbor_set_lead_disposition`
 * tool. See `leadDispositionEnum` in lib/db/schema.ts for what each value means and
 * why `requested_work` exists at all.
 *
 * A value sets `disposition_manual`, so the transcript / text classifiers never
 * overwrite the human decision. `null` clears the override back to automatic: the
 * classifier is re-run on the call transcript so a stale manual verdict does not
 * linger, or the row goes back to pending when there is nothing to classify.
 *
 * Returns null when the lead does not exist.
 */
export async function setLeadDisposition(
  id: string,
  disposition: LeadDisposition,
  reason?: string | null,
): Promise<{ id: string; disposition: LeadDisposition; dispositionManual: boolean; dispositionReason: string | null } | null> {
  if (disposition !== null) {
    const [row] = await db
      .update(leads)
      .set({
        disposition,
        dispositionManual: true,
        dispositionReason: reason ?? `manual: ${disposition.replace("_", " ")}`,
        // Both leave every count the way spam always has; the disposition says why.
        ...(disposition === "spam" || disposition === "test" ? { isSpam: true } : {}),
      })
      .where(eq(leads.id, id))
      .returning({
        id: leads.id,
        disposition: leads.disposition,
        dispositionManual: leads.dispositionManual,
        dispositionReason: leads.dispositionReason,
      });
    return row ?? null;
  }

  // Clearing: re-run the automatic verdict rather than keeping the manual one.
  // Same call pattern as lib/sync/transcribe.ts (spam floors the verdict).
  const [call] = await db.select({ transcript: calls.transcript }).from(calls).where(eq(calls.leadId, id)).limit(1);

  let auto: { disposition: LeadDisposition; dispositionReason: string };
  if (call?.transcript) {
    const cls = await classifyCallLead(call.transcript);
    const spam = cls.spamScore >= 0.5; // mirrors SPAM_THRESHOLD in lib/sync/transcribe.ts
    auto = { disposition: spam ? "spam" : cls.isLead ? "requested_work" : "not_business", dispositionReason: cls.reason };
  } else {
    auto = { disposition: null, dispositionReason: "auto (override cleared)" };
  }

  const [row] = await db
    .update(leads)
    .set({ dispositionManual: false, ...auto })
    .where(eq(leads.id, id))
    .returning({
      id: leads.id,
      disposition: leads.disposition,
      dispositionManual: leads.dispositionManual,
      dispositionReason: leads.dispositionReason,
    });
  return row ?? null;
}

/**
 * The Lead/Not toggle, kept for the existing route and MCP tool: a boolean is the
 * two-valued slice of the disposition (true = requested_work, false = not_business),
 * and null clears the override exactly as before.
 */
export async function setLeadClassification(
  id: string,
  isLead: boolean | null,
): Promise<{ id: string; isLead: boolean | null; isLeadManual: boolean } | null> {
  const row = await setLeadDisposition(id, isLead === null ? null : isLead ? "requested_work" : "not_business");
  if (!row) return null;
  return {
    id: row.id,
    isLead: row.disposition === null ? null : row.disposition === "requested_work",
    isLeadManual: row.dispositionManual,
  };
}

/** The guard every automatic classifier applies: a human decision is never overwritten. */
export const notManuallyDispositioned = eq(leads.dispositionManual, false);
