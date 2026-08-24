import { eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";

/**
 * Campaigns flagged as non-customer-acquisition — arborist recruiting, brand
 * awareness, anything whose leads are not prospective customers.
 *
 * Their spend and any already-captured leads stay in the database as history, but
 * they are kept out of every ROI number: recruiting dollars otherwise land in the
 * denominator of the channel's ROAS while producing no customer revenue, which
 * quietly understates the channel that paid for them.
 */
export async function excludedCampaignIds(): Promise<string[]> {
  const rows = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.excluded, true));
  return rows.map((r) => r.id);
}

/**
 * Predicate for a campaign-id column: keep only rows whose campaign isn't excluded.
 * Rows with no campaign are kept — `NOT IN` alone would silently drop them, since
 * `null NOT IN (…)` evaluates to null rather than true. Returns undefined when
 * nothing is excluded, so `and(...)` drops the clause entirely.
 */
export function campaignNotExcluded(col: AnyPgColumn, excludedIds: string[]): SQL | undefined {
  if (excludedIds.length === 0) return undefined;
  return or(isNull(col), notInArray(col, excludedIds));
}

/**
 * Link a lead to an EXISTING campaign by the `utm_campaign` text it arrived with.
 *
 * Campaigns are keyed `(platform, external_campaign_id)` by the spend sync, so the
 * only bridge from a URL to one of those rows is the name — which is why the Google
 * Ads tracking template must carry `{campaignname}` and not `{campaignid}`. A name
 * that matches nothing resolves to null rather than creating a row: minting
 * campaigns from arbitrary query-string text would pollute the dimension that ROI
 * groups on and that the recruiting-exclusion UI lists, and anyone can put any
 * `utm_campaign` they like on a link to the site.
 *
 * Extracted from /api/twilio/voice, which was the only path doing this. Web-form
 * and SMS leads set no campaign at all — so a form fill from a tagged ad click was
 * recorded with the right source and no campaign, and every campaign-level number
 * under-counted by however much of its volume arrived as a form rather than a call.
 * One implementation now, because three copies of a lookup are three chances for
 * the paths to disagree about what a campaign match means.
 */
export async function resolveCampaignIdByName(name: string | null | undefined): Promise<string | null> {
  if (!name) return null;
  const [c] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.name, name)).limit(1);
  return c?.id ?? null;
}

/**
 * Flag or unflag ONE campaign as non-customer-acquisition — the MCP
 * `set_campaign_excluded` tool. The settings page replaces the whole flagged set
 * at once (right for a form); a conversational change is one campaign at a time,
 * so this is deliberately a different write with the same meaning.
 *
 * Exclusion is applied when READING, never by refusing to record — the campaign's
 * spend and any captured leads stay in the database as history.
 *
 * Returns the updated row, or null when the id matches no campaign.
 */
export async function setCampaignExcluded(
  id: string,
  excluded: boolean,
): Promise<{ id: string; name: string | null; excluded: boolean } | null> {
  const [row] = await db
    .update(campaigns)
    .set({ excluded })
    .where(eq(campaigns.id, id))
    .returning({ id: campaigns.id, name: campaigns.name, excluded: campaigns.excluded });
  return row ?? null;
}
