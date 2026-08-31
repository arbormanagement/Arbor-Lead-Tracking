import { eq, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
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
/**
 * How far back the spend sync re-pulls on every run.
 *
 * Lives here rather than in `lib/sync/spend.ts` because a second thing depends on
 * it: a campaign with NO spend inside this window produces no rows in the pull, so
 * `ensureCampaigns` never sees it and can never rewrite its name. That is exactly
 * what makes such a campaign safe to rename locally — and renaming one INSIDE the
 * window would be undone on the next sync, i.e. a rename/restore flip-flop every
 * few hours. The two numbers must therefore be the same number.
 */
export const SPEND_REPULL_DAYS = 35;

/**
 * The campaign id a platform stamped into its own landing-page URL.
 *
 * `gad_campaignid` is added by Google's auto-tagging at click time; `campaign_id`
 * comes from the account's tracking template. Either one names the campaign that
 * actually served the ad, and neither can be ambiguous the way a name can.
 * Auto-tagging is preferred because it is not ours to mis-configure.
 *
 * Digits only: these are platform ids, and anything else is a tag someone hand-wrote.
 */
export function campaignIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    /[?&]gad_campaignid=(\d+)(?:&|$)/.exec(url) ?? /[?&]campaign_id=(\d+)(?:&|$)/.exec(url);
  return m?.[1] ?? null;
}

/**
 * Resolve a lead's campaign from what the visit carried.
 *
 * **The URL's campaign id wins over `utm_campaign` text, and that ordering is the
 * whole point of this function.** A name does not identify a campaign: Arbor has two
 * called `Search | Tree Services` (23633267649, live, and 22596055602, which has not
 * spent since before tracking began), the `{campaignname}` template emits a string
 * both of them match, and the tie went to whichever row Postgres returned first —
 * which for two weeks was consistently the dead one. Measured 2026-08-30: every
 * `google/cpc` lead with a landing page carried `gad_campaignid=23633267649` and not
 * one carried the other id, while 51 of 67 were filed under the other id. Campaign
 * CPE read 5.3x too high and ROAS 7.6x too low on the campaign that spends.
 *
 * The id is on the URL because GOOGLE put it there, so this keeps working if the
 * tracking template changes, and it needs no rename in the Ads UI — which matters,
 * because a rename there would not reach us anyway: `ensureCampaigns` only touches
 * campaigns present in the spend pull, and a campaign that has stopped spending
 * produces no rows to be renamed by.
 *
 * Still an exact match against EXISTING rows, never a create: minting campaigns from
 * query-string text is what this function exists to prevent.
 */
export async function resolveCampaignId(touch: {
  /** `utm_campaign` as the visit carried it. */
  name?: string | null;
  /** The landing page, whose query string may name the campaign outright. */
  url?: string | null;
}): Promise<string | null> {
  const urlId = campaignIdFromUrl(touch.url);
  const name = touch.name ?? null;
  if (!urlId && !name) return null;

  // One round trip: this runs on the /voice hot path, which has a sub-3s budget and
  // where a MISS is the common case, so a second query would cost every call.
  const candidates: SQL[] = [];
  if (urlId) candidates.push(eq(campaigns.externalCampaignId, urlId));
  if (name) candidates.push(eq(campaigns.name, name), eq(campaigns.externalCampaignId, name));

  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(or(...candidates))
    // Ranked rather than left to the planner, so the answer cannot depend on physical
    // row order — which is exactly how the dead campaign came to win. A campaign that
    // stops spending stops being UPDATEd by the spend sync, so its row stops moving
    // later in the heap, and it drifts to the front of a sequential scan: dying made
    // it MORE attractive to the matcher.
    .orderBy(
      sql`case
            when ${urlId ?? null}::text is not null and ${campaigns.externalCampaignId} = ${urlId ?? null} then 0
            when ${name ?? null}::text is not null and ${campaigns.name} = ${name ?? null} then 1
            else 2
          end`,
    )
    .limit(1);
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
