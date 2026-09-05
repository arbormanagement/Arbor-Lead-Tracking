import { and, eq, isNull, sql } from "drizzle-orm";
import * as schema from "./schema";
import { SPEND_REPULL_DAYS } from "@/lib/campaigns";
import { displayNameFor } from "@/lib/sources/naming";
import { businessDate } from "@/lib/tz";
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
//
// ONE DNI pool, on purpose. Until 0049 there were four — `google`, `facebook`,
// `organic` and `direct` — named as if a Google visitor were handed a Google number.
// They never were: `leaseNumber` is one flat rotation over every `is_dni` pool, and
// the visitor's source is frozen onto the LEASE, not read off the number (that is
// what lets six numbers serve every channel). Three of the four sat empty for a
// month while all six pool numbers lived in `direct`, so the names described routing
// that did not exist. `website` says what the pool actually is.
export const SEED_POOLS: Array<{
  key: string;
  displayName: string;
  description: string;
  isDni: boolean;
}> = [
  { key: "reserved", displayName: "Reserved", description: "Default bucket for static / test numbers", isDni: false },
  { key: "website", displayName: "Website (DNI)", description: "The rotation track.js leases from — one pool for every source; attribution rides on the lease", isDni: true },
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

    // 2. Leads whose listing is legible only from the LANDING PAGE, which is a
    //    bigger group than it sounds and is the case that settled the design. A GBP
    //    visitor handed a DNI pool number who then rings it reaches /voice, and a
    //    pool number carries no static campaign — even though the lease it just
    //    resolved holds `utm_campaign=edwardsville` verbatim.
    //
    //    Forward-going leads no longer need this — /voice matches the lease's
    //    campaign text now — so it exists to repair the rows written before that.
    //    The half of the repair that read the retired `location` column ran once, in
    //    migration 0043, on the way to dropping it.
    //    Matched on the tag with its delimiter so `ofallon` cannot also match a
    //    hypothetical `ofallon-something`.
    //
    //    The listing token is looked for in the utm_SOURCE slot as well, because a
    //    tag written by hand is a tag that can be written in the wrong order: both
    //    profiles' "Request a quote" buttons carried
    //    `?utm_campaign=gmb&utm_source=ofallon` from April to September 2026, i.e.
    //    the listing in the source slot and the channel in the campaign slot. Those
    //    URLs are cached, bookmarked and shared long after the buttons were fixed.
    //    Reading both slots is safe HERE in a way it would not be generally, because
    //    this pass is already scoped to leads on the `gbp` source with no campaign:
    //    the only question left is WHICH listing, and either slot naming one is a
    //    better answer than null.
    await db
      .update(schema.leads)
      .set({ campaignId: row.id })
      .where(
        and(
          eq(schema.leads.sourceId, src.id),
          isNull(schema.leads.campaignId),
          sql`${schema.leads.landingPage} ~ ${`[?&]utm_(campaign|source)=${c.externalCampaignId}(&|$)`}`,
        ),
      );
  }

  // Give a shared campaign NAME back to whichever campaign still owns it.
  //
  // A name is supposed to identify a campaign and sometimes does not: Arbor has two
  // called `Search | Tree Services`, and one of them is `status: REMOVED` in Google
  // Ads with no impression since 2026-03-09. REMOVED is terminal — it cannot be
  // re-enabled and cannot be renamed — so the collision can never be resolved
  // upstream, and the diagnostic that warns about it would have stayed red forever.
  // A check that can never go green is a check that gets ignored.
  //
  // So a campaign that shares its name and has NOT been paid for inside the spend
  // sync's re-pull window gets its platform id appended. `SPEND_REPULL_DAYS` is the
  // whole safety argument and not a tuning knob: a campaign inside that window is in
  // every pull, so `ensureCampaigns` would rename it straight back and the two passes
  // would flip-flop every few hours. Outside it, the sync produces no rows for the
  // campaign and never touches its name again.
  //
  // Three cases, one rule:
  //  · one live, one stale (Arbor's) — the stale one is suffixed, the live one keeps
  //    the name, and a lead carrying only `utm_campaign=<name>` now resolves to the
  //    campaign that actually served it.
  //  · both live — neither is suffixed and the warning stands, which is right: that
  //    is a real configuration problem needing a human, not one to paper over.
  //  · both stale — both are suffixed, so nothing resolves by that name at all. That
  //    is the trade this codebase makes everywhere: a coarse null beats a confident
  //    wrong answer.
  //
  // Idempotent by construction — once suffixed the name is unique, so the group it
  // belonged to no longer exists. Self-healing too: if a suffixed campaign ever spends
  // again, `ensureCampaigns` restores its platform name and this pass re-evaluates the
  // group with the roles the other way round.
  // Cutoff computed here rather than as `current_date - N` in SQL: the bound
  // parameter has no inferable type there, so Postgres rejects `date >= integer`.
  // A business date also keeps the boundary in the same timezone as `ad_spend.date`,
  // which the platforms report per account-day.
  const spendCutoff = businessDate(new Date(Date.now() - SPEND_REPULL_DAYS * 86_400_000));
  const disambiguated = await db.execute(sql`
    update ${schema.campaigns} as c
       set name = c.name || ' (' || c.external_campaign_id || ')', updated_at = now()
     where c.name is not null
       and exists (
             select 1 from ${schema.campaigns} d
              where d.name = c.name and d.id <> c.id
           )
       and not exists (
             select 1 from ${schema.adSpend} s
              where s.campaign_id = c.id
                and s.date >= ${spendCutoff}
           )
  `);
  if (disambiguated.rowCount) {
    onRow?.(`disambiguated ${disambiguated.rowCount} campaign name(s) that were shared`);
  }

  // Give a call the campaign its own tracking NUMBER names.
  //
  // `/voice` stamps `static_campaign_id` onto a lead at call time, so pointing a
  // number at a campaign fixes future calls and leaves the ones already taken
  // uncampaigned. That gap is not theoretical: the Google Ads call asset
  // +16184145907 is a static number, its callers carry no gclid and no landing page,
  // and 13 of them sat under `google/cpc` with no campaign while the campaign that
  // paid for them showed the spend.
  //
  // Fill-only-a-NULL, so it cannot overwrite a campaign resolved from a click id or
  // a hand correction — the number is the coarsest of the three signals and only
  // ever answers where nothing better did.
  //
  // `distinct on` picks the lead's EARLIEST call rather than letting Postgres choose
  // among several: a lead with two calls on differently-configured numbers would
  // otherwise get a campaign that changed between runs.
  const fromNumber = await db.execute(sql`
    update ${schema.leads} as l
       set campaign_id = sub.campaign_id, updated_at = now()
      from (
        select distinct on (c.lead_id) c.lead_id as lead_id, tn.static_campaign_id as campaign_id
          from ${schema.calls} c
          join ${schema.trackingNumbers} tn on tn.id = c.tracking_number_id
         where c.lead_id is not null and tn.static_campaign_id is not null
         order by c.lead_id, c.created_at asc
      ) sub
     where sub.lead_id = l.id
       and l.campaign_id is null
  `);
  if (fromNumber.rowCount) {
    onRow?.(`attributed ${fromNumber.rowCount} call lead(s) to their number's campaign`);
  }

  // Repair leads whose campaign was decided by a NAME that two campaigns share.
  //
  // Arbor has two campaigns called `Search | Tree Services` — 23633267649, which
  // spends, and 22596055602, which has not spent since before tracking began — and
  // the `{campaignname}` template emits a string both of them match. The tie went to
  // whichever row Postgres returned first, which for two weeks running was the dead
  // one. Measured 2026-08-30: every google/cpc lead with a landing page carried
  // `gad_campaignid=23633267649` and none carried the other id, while 51 of 67 were
  // filed under the other id. Campaign CPE read 5.3x too high and ROAS 7.6x too low
  // on the campaign that actually spends.
  //
  // The landing page is the authority and it was there all along: Google stamps the
  // serving campaign into the URL itself. `resolveCampaignId` reads it for new leads;
  // this fixes the ones written before it did.
  //
  // The SESSION's landing page is checked as well as the lead's, and for a WEB FORM
  // it is the only place the answer lives. `leads.landing_page` deliberately holds
  // the page the FORM was on for a form lead (app/api/track/route.ts) — where the
  // visitor converted, which is the more useful fact about the lead — while the page
  // the visit ENTERED on, the one carrying the ad's query string, stays on
  // `web_sessions`. So a visitor who arrives on a tagged ad URL and submits from a
  // clean inner page has a lead whose own landing page names no campaign and a
  // session whose landing page names it exactly. Measured 2026-08-31: 8 of the 41
  // paid web-form leads are that shape, and the five still sitting on the removed
  // campaign after the first repair were all of them. Ingest never had this problem —
  // `resolveCampaignId` is already handed `sess.landingPage` there.
  //
  // Self-limiting rather than fill-only-a-NULL, which is the difference from the
  // passes above: it rewrites a campaign that is DEMONSTRABLY wrong — the lead's own
  // URL names a different one — and once corrected it matches nothing, so re-running
  // is a no-op. That is also why it is safe on every deploy: the only thing it can
  // ever do is make a lead agree with the URL it arrived on.
  const repaired = await db.execute(sql`
    update ${schema.leads} as l
       set campaign_id = c.id, updated_at = now()
      from ${schema.campaigns} as c
     where c.external_campaign_id = coalesce(
             substring(l.landing_page from '[?&]gad_campaignid=([0-9]+)'),
             substring(l.landing_page from '[?&]campaign_id=([0-9]+)'),
             (
               select coalesce(
                        substring(ws.landing_page from '[?&]gad_campaignid=([0-9]+)'),
                        substring(ws.landing_page from '[?&]campaign_id=([0-9]+)')
                      )
                 from ${schema.webSessions} ws
                where ws.id = l.web_session_id
             )
           )
       and l.campaign_id is distinct from c.id
  `);
  if (repaired.rowCount) onRow?.(`repaired ${repaired.rowCount} lead campaign(s) from the landing page`);

  for (const p of SEED_POOLS) {
    await db
      .insert(schema.pools)
      .values({ key: p.key, displayName: p.displayName, description: p.description, isDni: p.isDni })
      .onConflictDoNothing({ target: schema.pools.key });
    onRow?.(`pool ${p.key}`);
  }
  return { sources: SEED_SOURCES.length, campaigns: SEED_CAMPAIGNS.length, pools: SEED_POOLS.length };
}
