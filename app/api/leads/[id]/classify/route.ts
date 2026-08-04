import { z } from "zod";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { classifyCallLead } from "@/lib/transcription/classify-lead";

export const runtime = "nodejs";

/**
 * Manual lead override: mark a lead as a lead / not-a-lead by hand. Sets is_lead_manual
 * so auto-classification (AI/keyword) won't overwrite the human decision. `isLead:null`
 * clears the override back to auto — re-running the classifier on the call transcript
 * so the stale manual verdict doesn't linger, or leaving is_lead null (unclassified)
 * when there's no transcript to classify. Admin-gated.
 */
const Body = z.object({ isLead: z.boolean().nullable() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  if (parsed.data.isLead !== null) {
    const [row] = await db
      .update(leads)
      .set({ isLead: parsed.data.isLead, isLeadManual: true, leadReason: parsed.data.isLead ? "manual: marked lead" : "manual: not a lead" })
      .where(eq(leads.id, id))
      .returning({ id: leads.id, isLead: leads.isLead, isLeadManual: leads.isLeadManual });
    if (!row) return Response.json({ error: "lead not found" }, { status: 404 });
    return Response.json({ ok: true, ...row });
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

  if (!row) return Response.json({ error: "lead not found" }, { status: 404 });
  return Response.json({ ok: true, ...row });
}
