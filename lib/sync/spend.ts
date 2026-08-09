import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { adSpend, campaigns, leads, sources } from "@/lib/db/schema";
import { activeSpendProviders, type SpendProvider, type SpendRow } from "@/lib/integrations";
import { PLATFORM_SOURCE_KEY } from "./attribution";
import { withSyncRun } from "./run";

/** Rolling re-pull window: wide enough that platform restatements (≤28d on Meta)
 *  and multi-day outages (expired token noticed late) self-heal without manual
 *  intervention. Re-pulling is idempotent (unique on platform+campaign+date). */
const ROLLING_DAYS = 35;
/** Hard ceiling for the automatic cold-start backfill. */
const MAX_HISTORY_DAYS = 365;

/**
 * spend.sync.daily — pull daily campaign spend from every configured ad platform
 * and upsert into `ad_spend`. Self-healing by design, no manual backfills:
 * normal runs re-pull a rolling ROLLING_DAYS window (restatements, missed runs),
 * and a provider with no history older than that window gets an automatic
 * cold-start pull reaching back to ITS OWN earliest lead — spend without leads
 * to match against is deliberately not fetched (it would only pollute ROI with
 * unmatched history), so each platform backfills exactly the span its lead data
 * covers. An explicit `sinceDays` (the /api/sync ?days=N override) bypasses the
 * window choice.
 */
export async function syncSpend({ sinceDays }: { sinceDays?: number } = {}) {
  return withSyncRun("spend.sync.daily", async () => {
    const providers = await activeSpendProviders();
    let upserted = 0;
    const byProvider: Record<string, string> = {};
    const errors: string[] = [];

    // Per-provider isolation: one bad platform (expired token, API outage) must
    // not block the others' pull. Record the error and move on — the run only
    // fails (holding for a cron retry) if EVERY provider failed.
    for (const provider of providers) {
      try {
        const days = sinceDays ?? ((await hasHistory(provider)) ? ROLLING_DAYS : await coldStartDays(provider));
        const rows = await provider.getDailySpend({ sinceDays: days });
        upserted += await upsertSpendRows(rows);
        byProvider[provider.name] = `${rows.length} rows (${days}d window)`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[spend] ${provider.name} failed`, err);
        byProvider[provider.name] = `error: ${msg}`;
        errors.push(`${provider.name}: ${msg}`);
      }
    }
    if (providers.length > 0 && errors.length === providers.length) {
      throw new Error(`all spend providers failed — ${errors.join("; ")}`);
    }

    return { providers: providers.map((p) => p.name), upserted, byProvider, failedProviders: errors.length };
  });
}

/** Cold-start depth: back to the provider's earliest lead (its sources' first
 *  captured lead), clamped to [ROLLING_DAYS, MAX_HISTORY_DAYS]. No leads yet →
 *  stay on the rolling window; there is nothing for older spend to match. */
async function coldStartDays(provider: SpendProvider): Promise<number> {
  const keys = provider.platforms.map((p) => PLATFORM_SOURCE_KEY[p]).filter(Boolean);
  if (keys.length === 0) return ROLLING_DAYS;
  const [row] = await db
    .select({ first: sql<string | null>`min(${leads.occurredAt})::date::text` })
    .from(leads)
    .innerJoin(sources, eq(leads.sourceId, sources.id))
    .where(inArray(sources.key, keys));
  if (!row?.first) return ROLLING_DAYS;
  const days = Math.ceil((Date.now() - new Date(row.first).getTime()) / 86_400_000) + 1;
  return Math.min(MAX_HISTORY_DAYS, Math.max(ROLLING_DAYS, days));
}

/** True once the provider's platforms have any spend row older than the rolling
 *  window — i.e. history has been captured and the rolling re-pull suffices.
 *  An ad account genuinely younger than the window just re-pulls deep; harmless. */
async function hasHistory(provider: SpendProvider): Promise<boolean> {
  const cutoff = new Date(Date.now() - ROLLING_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adSpend)
    .where(and(inArray(adSpend.platform, provider.platforms), lt(adSpend.date, cutoff)));
  return (row?.n ?? 0) > 0;
}

/** Batched upsert — deep windows are hundreds of rows per campaign, so per-row
 *  round trips over Neon HTTP would blow the function's time budget. */
async function upsertSpendRows(rows: SpendRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Defensive dedupe on the conflict key: a multi-row upsert errors if two rows
  // in one statement hit the same (platform, campaign, date).
  const byKey = new Map<string, SpendRow>();
  for (const r of rows) byKey.set(`${r.platform}|${r.externalCampaignId}|${r.date}`, r);
  const unique = [...byKey.values()];

  // Campaigns are ensured for EVERY row, including excluded ones — the dimension row
  // is what Settings reads to offer the campaign, and dropping it would hide the
  // toggle that turns the campaign back on.
  const campaignIds = await ensureCampaigns(unique);

  // Excluded (recruiting/brand) campaigns get no ad_spend rows at all. Filtering
  // them downstream isn't enough on its own: the rolling 35-day re-pull would
  // reinsert the rows on the next tick and quietly undo any cleanup.
  const excluded = new Set(await excludedCampaignIds());
  const writable = unique.filter((r) => {
    const id = campaignIds.get(`${r.platform}|${r.externalCampaignId}`);
    return !id || !excluded.has(id);
  });
  if (writable.length === 0) return 0;

  const CHUNK = 200;
  for (let i = 0; i < writable.length; i += CHUNK) {
    const chunk = writable.slice(i, i + CHUNK);
    await db
      .insert(adSpend)
      .values(
        chunk.map((row) => ({
          date: row.date,
          platform: row.platform,
          campaignId: campaignIds.get(`${row.platform}|${row.externalCampaignId}`) ?? null,
          externalCampaignId: row.externalCampaignId,
          impressions: row.impressions,
          clicks: row.clicks,
          spendCents: row.spendCents,
          conversions: String(row.conversions),
          source: `direct:${row.platform}`,
          raw: row.raw,
        })),
      )
      .onConflictDoUpdate({
        target: [adSpend.platform, adSpend.externalCampaignId, adSpend.date],
        set: {
          campaignId: sql`excluded.campaign_id`,
          impressions: sql`excluded.impressions`,
          clicks: sql`excluded.clicks`,
          spendCents: sql`excluded.spend_cents`,
          conversions: sql`excluded.conversions`,
          raw: sql`excluded.raw`,
          updatedAt: new Date(),
        },
      });
  }
  return writable.length;
}

/** Ensure the campaign dimension exists for every distinct campaign in the pull,
 *  so spend links to a campaign. Returns `${platform}|${externalCampaignId}` → id. */
async function ensureCampaigns(rows: SpendRow[]): Promise<Map<string, string>> {
  // Providers guarantee every row carries a real campaign id (rows without one
  // are skipped at the source — external_campaign_id is NOT NULL).
  const distinct = new Map<string, SpendRow>();
  for (const row of rows) distinct.set(`${row.platform}|${row.externalCampaignId}`, row);

  const ids = new Map<string, string>();
  for (const [key, row] of distinct) {
    // Insert-first (no-op on the unique index) then select — select-then-insert
    // raced a concurrent run into a unique violation.
    await db
      .insert(campaigns)
      .values({
        platform: row.platform,
        externalCampaignId: row.externalCampaignId,
        name: row.campaignName,
      })
      .onConflictDoNothing({ target: [campaigns.platform, campaigns.externalCampaignId] });
    const [existing] = await db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(and(eq(campaigns.platform, row.platform), eq(campaigns.externalCampaignId, row.externalCampaignId)))
      .limit(1);
    if (!existing) continue; // unreachable: the row exists after the upsert
    ids.set(key, existing.id);
    if (row.campaignName && row.campaignName !== existing.name) {
      await db.update(campaigns).set({ name: row.campaignName }).where(eq(campaigns.id, existing.id));
    }
  }
  return ids;
}
