import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { adSpend, campaigns } from "@/lib/db/schema";
import { businessDate } from "@/lib/tz";

/**
 * Ad spend by platform and campaign — the MCP `spend_summary` tool.
 *
 * Reads `ad_spend` directly (what the platforms billed), not `roi_daily` (which
 * carries only the spend that survived the recruiting-campaign exclusion). Excluded
 * campaigns are therefore VISIBLE here, flagged rather than dropped: exclusion is
 * applied when reading ROI, never by refusing to record — and "what did we actually
 * pay the platforms?" is a question about the bill, not about ROI.
 *
 * `ad_spend.date` is the platform's account-timezone day (America/Chicago for both
 * accounts), so the window edge is a business date. Money is integer CENTS.
 */
export interface SpendRow {
  platform: string;
  campaignId: string | null;
  campaignName: string | null;
  /** True for recruiting/brand campaigns — kept out of every ROI number. */
  excluded: boolean;
  impressions: number;
  clicks: number;
  spend: number;
}

export async function spendSummary(opts: { days: number; platform?: string }): Promise<{
  rows: SpendRow[];
  totals: { spend: number; excludedSpend: number };
}> {
  const since = businessDate(new Date(Date.now() - opts.days * 86_400_000));

  const where: SQL[] = [gte(adSpend.date, since)];
  if (opts.platform) where.push(eq(adSpend.platform, opts.platform as never));

  const rows = await db
    .select({
      platform: adSpend.platform,
      campaignId: adSpend.campaignId,
      campaignName: campaigns.name,
      excluded: sql<boolean>`coalesce(${campaigns.excluded}, false)`,
      impressions: sql<number>`coalesce(sum(${adSpend.impressions}),0)::int`,
      clicks: sql<number>`coalesce(sum(${adSpend.clicks}),0)::int`,
      spend: sql<number>`coalesce(sum(${adSpend.spendCents}),0)::int`,
    })
    .from(adSpend)
    .leftJoin(campaigns, eq(adSpend.campaignId, campaigns.id))
    .where(and(...where))
    .groupBy(adSpend.platform, adSpend.campaignId, campaigns.name, campaigns.excluded)
    .orderBy(desc(sql`coalesce(sum(${adSpend.spendCents}),0)`));

  const totals = rows.reduce(
    (a, r) => ({
      spend: a.spend + r.spend,
      excludedSpend: a.excludedSpend + (r.excluded ? r.spend : 0),
    }),
    { spend: 0, excludedSpend: 0 },
  );

  return { rows, totals };
}
