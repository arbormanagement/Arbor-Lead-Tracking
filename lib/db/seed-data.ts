import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "./schema";
import { displayNameFor } from "@/lib/sources/naming";
import type { Db } from "./client";

/**
 * The canonical dimension rows the app cannot function without: the `sources`
 * every attribution maps onto, and the `pools` every tracking number belongs to.
 *
 * Single definition on purpose — these lists were previously copy-pasted across
 * `scripts/seed.ts`, `scripts/migrate-deploy.ts`, and `/api/admin/migrate`, where
 * they could silently drift and leave whichever path you happened to run seeding
 * a different world.
 */
type Platform = (typeof schema.platformEnum.enumValues)[number];

export const SEED_SOURCES: Array<{
  key: string;
  displayName: string;
  platform: Platform;
  costModel: string;
}> = [
  { key: "google/cpc", displayName: "Google Ads (Search)", platform: "google", costModel: "cpc" },
  { key: "google/lsa", displayName: "Google Local Services", platform: "google_lsa", costModel: "cpl" },
  { key: "facebook/paid", displayName: "Meta Ads", platform: "facebook", costModel: "cpc" },
  { key: "organic/seo", displayName: "Organic Search", platform: "other", costModel: "none" },
  { key: "gbp", displayName: "Google Business Profile", platform: "other", costModel: "none" },
  { key: "direct", displayName: "Direct", platform: "other", costModel: "none" },
  { key: "referral", displayName: "Referral", platform: "other", costModel: "none" },
  // The newsletter/broadcast list (SendGrid). Owned media, so no per-click cost —
  // ROI on it is revenue against zero spend, which is the honest answer.
  { key: "email/newsletter", displayName: "Email Newsletter", platform: "other", costModel: "none" },
  // Catch-all for traffic we do not recognise. See lib/sources/naming.ts.
  { key: "other", displayName: "Other / Unmapped", platform: "other", costModel: "none" },
  // Estimates written before tracking existed. Not a channel — a stand-in so they
  // stop sharing a nameless blank row with genuinely unattributed work.
  // See PRE_TRACKING_SOURCE_KEY in lib/sources/naming.ts.
  { key: "n/a", displayName: "N/A (before tracking)", platform: "other", costModel: "none" },
];

/**
 * Campaigns that are not an ad platform's, so no sync can discover them.
 *
 * The two Google Business Profiles are one SOURCE (`gbp`) and two listings, and the
 * listing is what is worth comparing — they are separate assets with separate
 * reviews, photos and posts, optimised separately. That distinction used to ride on
 * `location`, which was the wrong field for it: `location` reads as the customer's
 * city, and for GBP it is not. Measured over the 12 GBP wins to 2026-08-30, the
 * profile and the service-address city DISAGREE half the time — the Edwardsville
 * listing produced work in Granite City, Bethalto, Alton, Fairview Heights and
 * Collinsville, and the O'Fallon listing produced work in Swansea. A visitor
 * searches "tree service near me" and clicks whichever listing Google shows them;
 * where the tree is does not enter into it. So the listing is a marketing asset —
 * a campaign — and `location` is free to mean where the WORK is.
 *
 * `platform: "other"` is load-bearing: `campaigns_platform_extid_uq` is
 * (platform, external_campaign_id), and no spend sync ever writes `other`
 * (PLATFORM_SOURCE_KEY covers google / google_lsa / facebook), so these can never
 * collide with a synced row.
 *
 * `externalCampaignId` holds the `utm_campaign` token each profile tags its website
 * link with, verbatim — that is what `resolveCampaignIdByName` matches web clicks
 * on, which is why the display name is free to be prettier than the token.
 */
export const SEED_CAMPAIGNS: Array<{
  sourceKey: string;
  externalCampaignId: string;
  name: string;
  location: (typeof schema.locationEnum.enumValues)[number];
}> = [
  { sourceKey: "gbp", externalCampaignId: "edwardsville", name: "Edwardsville", location: "edwardsville" },
  { sourceKey: "gbp", externalCampaignId: "ofallon", name: "O'Fallon", location: "ofallon" },
];

// `isDni` = website DNI draws rotating numbers from this pool; the rest are
// buckets for organizing static numbers.
export const SEED_POOLS: Array<{
  key: string;
  displayName: string;
  description: string;
  isDni: boolean;
}> = [
  { key: "reserved", displayName: "Reserved", description: "Default bucket for static / test numbers", isDni: false },
  { key: "google", displayName: "Google Ads", description: "DNI rotation for paid Google visitors", isDni: true },
  { key: "facebook", displayName: "Facebook / Instagram", description: "DNI rotation for Meta visitors", isDni: true },
  { key: "organic", displayName: "Organic / GBP", description: "DNI rotation for organic + GBP visitors", isDni: true },
  { key: "direct", displayName: "Direct", description: "DNI rotation for direct / unknown visitors", isDni: true },
  { key: "lsa", displayName: "Local Services Ads", description: "Static LSA tracking numbers", isDni: false },
  { key: "print", displayName: "Print / Signage", description: "Yard signs, flyers, truck wraps", isDni: false },
];

/**
 * Insert the defaults. Idempotent via onConflictDoNothing, so it is safe on every
 * deploy and never overwrites edits made in the app.
 */
export async function seedDefaults(db: Db, onRow?: (label: string) => void) {
  for (const s of SEED_SOURCES) {
    await db
      .insert(schema.sources)
      .values({
        key: s.key,
        displayName: s.displayName,
        platform: s.platform,
        defaultCostModel: s.costModel,
      })
      .onConflictDoNothing({ target: schema.sources.key });
    onRow?.(`source ${s.key}`);
  }
  // Repair sources created before there was one place that named them: six call
  // sites used `displayName: key`, so anything outside this seed list rendered as a
  // raw slug on /sources. Idempotent, and only touches rows still carrying the
  // giveaway (name === key), so a name edited in the app is never overwritten.
  const slugNamed = await db
    .select({ key: schema.sources.key })
    .from(schema.sources)
    .where(eq(schema.sources.displayName, schema.sources.key));
  for (const row of slugNamed) {
    await db
      .update(schema.sources)
      .set({ displayName: displayNameFor(row.key) })
      .where(eq(schema.sources.key, row.key));
    onRow?.(`renamed source ${row.key}`);
  }

  // Non-platform campaigns, and the two backfills that stop the GBP history
  // splitting at the moment this shipped. Both only ever fill a NULL, so they are
  // safe to re-run on every deploy and cannot overwrite a later correction.
  for (const c of SEED_CAMPAIGNS) {
    const [src] = await db
      .select({ id: schema.sources.id })
      .from(schema.sources)
      .where(eq(schema.sources.key, c.sourceKey))
      .limit(1);
    if (!src) continue; // the source seed above failed; nothing to hang this on
    await db
      .insert(schema.campaigns)
      .values({
        sourceId: src.id,
        platform: "other",
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        status: "active",
        location: c.location,
      })
      .onConflictDoNothing({ target: [schema.campaigns.platform, schema.campaigns.externalCampaignId] });
    onRow?.(`campaign ${c.externalCampaignId}`);

    const [row] = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(
        and(
          eq(schema.campaigns.platform, "other"),
          eq(schema.campaigns.externalCampaignId, c.externalCampaignId),
        ),
      )
      .limit(1);
    if (!row) continue;

    // 1. The listing's own tracking number. A static number carries no DNI lease,
    //    so without this the CALLS — the large majority of GBP contacts — would
    //    still reach roi_daily with a null campaign while the web clicks resolved
    //    one, and the two halves of a profile would disagree exactly as they did
    //    before `inferLocation` learned to read utm_campaign.
    await db
      .update(schema.trackingNumbers)
      .set({ staticCampaignId: row.id })
      .where(
        and(
          eq(schema.trackingNumbers.isStatic, true),
          eq(schema.trackingNumbers.staticSourceId, src.id),
          eq(schema.trackingNumbers.location, c.location),
          isNull(schema.trackingNumbers.staticCampaignId),
        ),
      );

    // 2. Leads already on this source whose listing is known only from `location`.
    await db
      .update(schema.leads)
      .set({ campaignId: row.id })
      .where(
        and(
          eq(schema.leads.sourceId, src.id),
          eq(schema.leads.location, c.location),
          isNull(schema.leads.campaignId),
        ),
      );

    // 3. …and the ones whose listing is in the LANDING PAGE but not in `location`,
    //    which is a bigger group than it sounds and is the case that settled the
    //    design. A GBP visitor who is handed a DNI pool number and then rings it
    //    reaches /voice, which reads location off the tracking NUMBER — and a pool
    //    number has none, so the branch is dropped even though the lease it just
    //    resolved carries `utm_campaign=edwardsville` verbatim. Every one of the 13
    //    GBP contacts sitting at `location: unknown` on 2026-08-30 is this: 7
    //    Edwardsville and 6 O'Fallon, each with the tag in its landing page.
    //
    //    Forward-going leads no longer need this — /voice matches the lease's
    //    campaign text now — so it exists to repair the rows written before that.
    //    Matched on the tag with its delimiter so `ofallon` cannot also match a
    //    hypothetical `ofallon-something`.
    await db
      .update(schema.leads)
      .set({ campaignId: row.id })
      .where(
        and(
          eq(schema.leads.sourceId, src.id),
          isNull(schema.leads.campaignId),
          sql`${schema.leads.landingPage} ~ ${`[?&]utm_campaign=${c.externalCampaignId}(&|$)`}`,
        ),
      );
  }

  for (const p of SEED_POOLS) {
    await db
      .insert(schema.pools)
      .values({ key: p.key, displayName: p.displayName, description: p.description, isDni: p.isDni })
      .onConflictDoNothing({ target: schema.pools.key });
    onRow?.(`pool ${p.key}`);
  }
  return { sources: SEED_SOURCES.length, campaigns: SEED_CAMPAIGNS.length, pools: SEED_POOLS.length };
}
