import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { adSpend, campaigns } from "@/lib/db/schema";
import { activeSpendProviders, type SpendRow } from "@/lib/integrations";
import { withSyncRun } from "./run";

/**
 * spend.sync.daily — pull a rolling window of daily campaign spend from every
 * configured ad platform and upsert into `ad_spend`. Re-pulling the window each
 * run is idempotent (unique on platform+campaign+date) and self-heals missed runs
 * and platform restatements.
 */
export async function syncSpend({ sinceDays = 7 }: { sinceDays?: number } = {}) {
  return withSyncRun("spend.sync.daily", async () => {
    const providers = activeSpendProviders();
    let upserted = 0;
    const byProvider: Record<string, number> = {};

    for (const provider of providers) {
      const rows = await provider.getDailySpend({ sinceDays });
      for (const row of rows) {
        await upsertSpendRow(row);
        upserted++;
      }
      byProvider[provider.name] = rows.length;
    }

    return { providers: providers.map((p) => p.name), upserted, byProvider };
  });
}

async function upsertSpendRow(row: SpendRow) {
  // Ensure the campaign dimension exists so spend links to a campaign.
  let campaignId: string | null = null;
  if (row.externalCampaignId && row.externalCampaignId !== "undefined") {
    const [existing] = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.platform, row.platform), eq(campaigns.externalCampaignId, row.externalCampaignId)))
      .limit(1);
    if (existing) {
      campaignId = existing.id;
      if (row.campaignName) {
        await db.update(campaigns).set({ name: row.campaignName }).where(eq(campaigns.id, existing.id));
      }
    } else {
      const [created] = await db
        .insert(campaigns)
        .values({
          platform: row.platform,
          externalCampaignId: row.externalCampaignId,
          name: row.campaignName,
        })
        .returning({ id: campaigns.id });
      campaignId = created.id;
    }
  }

  await db
    .insert(adSpend)
    .values({
      date: row.date,
      platform: row.platform,
      campaignId,
      externalCampaignId: row.externalCampaignId,
      impressions: row.impressions,
      clicks: row.clicks,
      spendCents: row.spendCents,
      conversions: String(row.conversions),
      source: `direct:${row.platform}`,
      raw: row.raw,
    })
    .onConflictDoUpdate({
      target: [adSpend.platform, adSpend.externalCampaignId, adSpend.date],
      set: {
        campaignId,
        impressions: row.impressions,
        clicks: row.clicks,
        spendCents: row.spendCents,
        conversions: String(row.conversions),
        raw: row.raw,
        updatedAt: new Date(),
      },
    });
}
