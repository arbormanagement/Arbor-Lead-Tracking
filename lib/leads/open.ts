import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, leads } from "@/lib/db/schema";
import { isOpenLead } from "@/lib/leads/stage";

/**
 * The still-open lead on this conversation, if there is one.
 *
 * "One thread, many leads": a follow-up joins the enquiry already in flight, while
 * contact arriving after the last one was won, lost or cancelled is genuinely new
 * business and gets its own lead, so repeat customers still count. Open is derived
 * from the estimate (`isOpenLead`), never from a stored stage.
 *
 * Web forms and Meta lead forms did not consult this and minted a lead per
 * submission, which is how one person became two rows eighteen seconds apart
 * (2026-08-13): someone submitted, changed something, and submitted again. The
 * `(session, form, sorted fields)` dedupe key cannot catch that by construction — a
 * corrected resubmission is a different set of fields, and no field comparison can
 * tell it apart from a genuine second enquiry.
 *
 * Answering "does this person already have an enquiry open?" can, and it is the same
 * question texts have always asked. It also catches the cross-channel case that no
 * per-channel dedupe ever could: a Meta lead form followed a minute later by the
 * website form is one person asking once.
 *
 * The submission itself is always still recorded — `form_submissions` keeps every
 * event, and the thread shows both. Only the second LEAD is not created.
 */
export async function findOpenLead(conversationId: string | null | undefined): Promise<string | null> {
  if (!conversationId) return null;
  const [open] = await db
    .select({ id: leads.id })
    .from(leads)
    .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
    .where(and(eq(leads.conversationId, conversationId), isOpenLead))
    .orderBy(desc(leads.occurredAt))
    .limit(1);
  return open?.id ?? null;
}
