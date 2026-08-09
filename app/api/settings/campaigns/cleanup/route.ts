import { inArray } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { attributions, conversionExports, facebookLeads, leads } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Delete leads already captured against a campaign now flagged as
 * non-customer-acquisition (recruiting). Admin-gated + destructive.
 *
 * Flagging a campaign keeps its leads out of every ROI number immediately; this is
 * the separate, explicit step that also clears them out of the inbox. Dependents go
 * first (conversion_exports, attributions, facebook_leads), then the leads.
 * Ad spend is deliberately kept — it stays as history, just uncounted.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const excluded = await excludedCampaignIds();
  if (!excluded.length) {
    return Response.json({ ok: true, removed: 0, note: "No campaigns are flagged — nothing to remove." });
  }

  const rows = await db.select({ id: leads.id }).from(leads).where(inArray(leads.campaignId, excluded));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return Response.json({ ok: true, removed: 0 });

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await db.delete(conversionExports).where(inArray(conversionExports.leadId, chunk));
    await db.delete(attributions).where(inArray(attributions.leadId, chunk));
    await db.delete(facebookLeads).where(inArray(facebookLeads.leadId, chunk));
    await db.delete(leads).where(inArray(leads.id, chunk));
  }

  return Response.json({ ok: true, removed: ids.length });
}
