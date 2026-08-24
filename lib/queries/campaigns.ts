import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { adSpend, campaigns, leads } from "@/lib/db/schema";

/**
 * Every known ad campaign with the spend and leads attached to it, plus which are
 * flagged as non-customer-acquisition (recruiting) — shared by GET
 * /api/settings/campaigns and the MCP `list_campaigns` tool.
 *
 * Campaigns are created by the spend sync and the Facebook lead ingest, so this is
 * a read of what the syncs have already seen — there is nothing to configure until
 * a platform has been pulled at least once.
 */
export interface CampaignRow {
  id: string;
  platform: string;
  externalCampaignId: string;
  name: string | null;
  excluded: boolean;
  spendCents: number;
  leadsCount: number;
}

export async function listCampaignsWithVolume(): Promise<CampaignRow[]> {
  const rows = await db
    .select({
      id: campaigns.id,
      platform: campaigns.platform,
      externalCampaignId: campaigns.externalCampaignId,
      name: campaigns.name,
      excluded: campaigns.excluded,
    })
    .from(campaigns);

  // Spend + lead volume per campaign — grouped separately and merged, so a campaign
  // with spend but no leads (or the reverse) still shows up with real numbers.
  const spendRows = await db
    .select({ campaignId: adSpend.campaignId, cents: sql<number>`coalesce(sum(${adSpend.spendCents}),0)::int` })
    .from(adSpend)
    .groupBy(adSpend.campaignId);
  const leadRows = await db
    .select({ campaignId: leads.campaignId, n: sql<number>`count(*)::int` })
    .from(leads)
    .groupBy(leads.campaignId);

  const spendBy = new Map(spendRows.map((r) => [r.campaignId, r.cents]));
  const leadsBy = new Map(leadRows.map((r) => [r.campaignId, r.n]));

  return rows
    .map((r) => ({ ...r, spendCents: spendBy.get(r.id) ?? 0, leadsCount: leadsBy.get(r.id) ?? 0 }))
    .sort((a, b) => b.spendCents - a.spendCents || (a.name ?? "").localeCompare(b.name ?? ""));
}
