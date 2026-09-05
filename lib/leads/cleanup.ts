import { inArray } from "drizzle-orm";
import { excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { attributions, conversionExports, facebookLeads, leads } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { FB_INCLUDED_FORMS_KEY } from "@/lib/sync/facebook-leads";

/**
 * Removing leads that were captured against something since marked "not ours" — a
 * campaign flagged recruiting, or a Facebook lead form unchecked.
 *
 * Shared by the two Settings cleanup routes and the MCP `arbor_cleanup_inquiries` tool.
 *
 * These are the only operations in this app that HARD DELETE leads, which is why
 * they are structured as collect-then-delete rather than one statement: the caller
 * can see exactly what would go before anything goes, and the MCP tool defaults to
 * not applying. Everything else here tombstones (see the HCP sync notes in
 * CLAUDE.md); this is the exception because a recruiting applicant in the customer
 * inbox is not data anyone wants kept.
 *
 * Ad spend is deliberately untouched. Flagging a campaign already keeps its dollars
 * out of every ROI number; deleting the spend row would destroy the history instead
 * of merely uncounting it, and the re-pull only reaches back 35 days.
 */
export type CleanupScope = "excluded_campaigns" | "unselected_facebook_forms";

export interface CleanupPlan {
  scope: CleanupScope;
  leadIds: string[];
  /** Why nothing would be removed, when that is the answer. */
  note?: string;
}

/** What a cleanup WOULD remove. Reads only. */
export async function planLeadCleanup(scope: CleanupScope): Promise<CleanupPlan> {
  if (scope === "excluded_campaigns") {
    const excluded = await excludedCampaignIds();
    if (!excluded.length) {
      return { scope, leadIds: [], note: "No campaigns are flagged as recruiting/brand, so nothing is excluded." };
    }
    const rows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.campaignId, excluded));
    return { scope, leadIds: rows.map((r) => r.id) };
  }

  // An EMPTY allowlist means every form is allowed, so nothing is excluded — the
  // opposite of "no forms selected, remove everything", which is how this would go
  // catastrophically wrong if the empty case were not handled first.
  const selected = await getSetting<string[]>(FB_INCLUDED_FORMS_KEY, []);
  if (!selected.length) {
    return { scope, leadIds: [], note: "No forms are excluded (an empty selection means all forms are allowed)." };
  }
  const rows = await db
    .select({ leadId: facebookLeads.leadId, formId: facebookLeads.fbFormId })
    .from(facebookLeads);
  const leadIds = rows
    .filter((r) => r.leadId && r.formId && !selected.includes(r.formId))
    .map((r) => r.leadId as string);
  return { scope, leadIds };
}

/**
 * Delete leads and their dependents, in FK order. Chunked because the id list is
 * unbounded and a single `in (...)` of a few thousand is a bad query plan.
 */
export async function deleteLeadsCascade(leadIds: string[]): Promise<number> {
  if (!leadIds.length) return 0;
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100);
    await db.delete(conversionExports).where(inArray(conversionExports.leadId, chunk));
    await db.delete(attributions).where(inArray(attributions.leadId, chunk));
    await db.delete(facebookLeads).where(inArray(facebookLeads.leadId, chunk));
    await db.delete(leads).where(inArray(leads.id, chunk));
  }
  return leadIds.length;
}

/** Plan and, when `apply`, carry out. Returns what was (or would be) removed. */
export async function runLeadCleanup(scope: CleanupScope, apply: boolean) {
  const plan = await planLeadCleanup(scope);
  const removed = apply ? await deleteLeadsCascade(plan.leadIds) : 0;
  return { scope, applied: apply, wouldRemove: plan.leadIds.length, removed, note: plan.note };
}
