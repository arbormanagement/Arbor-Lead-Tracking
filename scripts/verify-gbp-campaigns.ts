/**
 * Exercises the GBP listing-campaign wiring against a real Postgres.
 *
 *   npm run verify:campaigns
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production. It seeds numbers and leads and leaves them behind.
 *
 * Same reason `verify:hcp` exists: there is no test runner here, and none of what
 * this covers is visible to `tsc`. The seed's two backfills are conditional UPDATEs
 * whose whole correctness is in their WHERE clause — fill only a NULL, only a static
 * number, only an exactly-delimited tag — and every way of getting them wrong still
 * compiles. Getting them wrong is also expensive in one direction: an UPDATE that
 * overwrote a hand-corrected campaign would be re-applied on every deploy.
 *
 * Set up a throwaway instance:
 *   initdb -D /var/tmp/pgt/data -U postgres --auth=trust
 *   pg_ctl -D /var/tmp/pgt/data -o "-p 55432" start
 *   createdb -h 127.0.0.1 -p 55432 -U postgres arbor_scratch
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/arbor_scratch npx drizzle-kit push --force
 *   DATABASE_URL=... APP_BASE_URL=http://localhost:3000 ADMIN_EMAIL=a@b.com \
 *     COOKIE_SIGNING_SECRET=0123456789abcdef0123 npm run verify:campaigns
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { adSpend, attributions, calls, campaigns, leads, numberAssignments, roiDaily, sources, trackingNumbers, visitors, webSessions } from "@/lib/db/schema";
import { seedDefaults } from "@/lib/db/seed-data";
import { campaignIdFromUrl, resolveCampaignId, SPEND_REPULL_DAYS } from "@/lib/campaigns";
import { classifySource } from "@/lib/attribution/classify";
import { CANARY_SESSION_ID, CANARY_TERM, CANARY_VISITOR_ID } from "@/lib/dni/canary";
import { reclassifyUnmappedSources } from "@/lib/sources/reclassify";
import { setLeadAttribution } from "@/lib/leads/attribution";
import { resolveInboundAttribution } from "@/lib/twilio/inbound";
import { applyNumberPatch } from "@/lib/twilio/numbers";
import { listTrackingNumbers } from "@/lib/queries/numbers";
import { runAttribution } from "@/lib/sync/attribution";

let failures = 0;
const ok = (c: boolean, m: string) => {
  if (!c) failures++;
  console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`);
};

/** Fixture numbers, deliberately in the 555 reserved range so they can never be
 *  mistaken for the real Google Business Profile lines. Cleaned up at the START of
 *  each run — both `phone_number` and `twilio_sid` are unique, so a second run would
 *  otherwise just collide. */
const FIXTURES = ["+16185550001", "+16185550002", "+16185550003", "+16185550004"];

/** A duplicate NAME across two campaigns — the shape that misrouted every Google Ads
 *  lead for two weeks. Ids are outside any real account's range. */
const DUP_NAME = "Verify | Duplicate Name";
const DUP_LIVE = "99900001";
const DUP_DEAD = "99900002";
/** Every fixture campaign id, so the cleanup below is exhaustive rather than a list
 *  that quietly falls behind the fixtures each time one is added. */
const FIXTURE_CAMPAIGNS = ["99900001", "99900002", "99900003", "99900004", "99900005", "99900006"];

async function main() {
  for (const phone of FIXTURES) {
    // Leads are matched on the caller number rather than the tracking number:
    // `leads` has no tracking_number_id, and a delete on a column that does not
    // exist compiles to a broken WHERE rather than an error.
    //
    // `attributions` first, and it has to be: this script runs a real
    // runAttribution, which writes a touch row per lead, and that FK makes the lead
    // delete fail on the NEXT run rather than this one. A verifier that only passes
    // on a virgin database is a verifier nobody runs twice.
    const stale = db.select({ id: leads.id }).from(leads).where(eq(leads.phoneE164, phone));
    await db.delete(attributions).where(inArray(attributions.leadId, stale));
    await db.delete(calls).where(inArray(calls.leadId, stale));
    const sessionIds = db.select({ id: leads.webSessionId }).from(leads).where(eq(leads.phoneE164, phone));
    await db.delete(leads).where(eq(leads.phoneE164, phone));
    await db.delete(webSessions).where(inArray(webSessions.id, sessionIds));
    const numberIds = db.select({ id: trackingNumbers.id }).from(trackingNumbers).where(eq(trackingNumbers.phoneNumber, phone));
    await db.delete(numberAssignments).where(inArray(numberAssignments.trackingNumberId, numberIds));
    await db.delete(trackingNumbers).where(eq(trackingNumbers.phoneNumber, phone));
  }

  // ad_spend before campaigns — it holds the FK, and the spend rows are what decide
  // whether a duplicate name is safe to rename, so a leftover row from the last run
  // would silently change the answer.
  await db.delete(adSpend).where(inArray(adSpend.externalCampaignId, FIXTURE_CAMPAIGNS));
  await db.delete(campaigns).where(inArray(campaigns.externalCampaignId, FIXTURE_CAMPAIGNS));

  // Seed first, so this runs against a database straight out of `drizzle-kit push`
  // rather than one someone remembered to seed by hand. The fixtures below hang off
  // the `gbp` source, and on a fresh database that row does not exist yet.
  await seedDefaults(db);

  const [gbp] = await db.select().from(sources).where(eq(sources.key, "gbp")).limit(1);
  if (!gbp) throw new Error("seedDefaults did not create the gbp source — nothing else here can be trusted");

  // Pre-existing rows that predate the change: two static GBP numbers, each
  // identifiable only by the listing `location` it was provisioned for.
  const [edwNum] = await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[0], twilioSid: "PNverifyEdw", friendlyName: "GBP Edwardsville", pool: "reserved",
    isStatic: true, staticSourceId: gbp.id, location: "edwardsville",
  }).returning();
  await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[1], twilioSid: "PNverifyOfa", friendlyName: "GBP O'Fallon", pool: "reserved",
    isStatic: true, staticSourceId: gbp.id, location: "ofallon",
  });
  // A POOLED number that happens to name a location — must NOT be touched.
  const [pooled] = await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[2], twilioSid: "PNverifyPool", pool: "website", isStatic: false, location: "edwardsville",
  }).returning();

  // A GBP lead with nothing at all identifying the listing — must stay unassigned
  // rather than be guessed at.
  const [unknownLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[1],
  }).returning();
  // The real shape of a GBP contact the call path could not place: a pool-number
  // call whose lease carried the listing. The landing page says everything.
  const [poolCallLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[2],
    landingPage: "https://arbor-mgmt.com/?utm_source=google+my+business&utm_medium=organic&utm_campaign=ofallon",
  }).returning();

  await seedDefaults(db);

  const camps = await db.select().from(campaigns).where(eq(campaigns.sourceId, gbp.id));
  ok(camps.length === 2, `two campaigns under gbp (got ${camps.length})`);
  ok(camps.every((c) => c.platform === "other"), "platform 'other' — cannot collide with a spend sync");
  ok(camps.every((c) => c.excluded === false), "not excluded, so they count in ROI");
  const edw = camps.find((c) => c.externalCampaignId === "edwardsville")!;
  const ofa = camps.find((c) => c.externalCampaignId === "ofallon")!;
  ok(edw?.name === "Edwardsville" && ofa?.name === "O'Fallon", `display names (${edw?.name} / ${ofa?.name})`);

  // Web path: utm_campaign token resolves despite the prettier display name.
  ok((await resolveCampaignId({ name: "edwardsville" })) === edw.id, "utm_campaign=edwardsville → Edwardsville");
  ok((await resolveCampaignId({ name: "ofallon" })) === ofa.id, "utm_campaign=ofallon → O'Fallon");
  ok((await resolveCampaignId({ name: "Edwardsville" })) === edw.id, "display name still resolves");
  ok((await resolveCampaignId({ name: "nope" })) === null, "unknown utm_campaign still mints nothing");

  // Call path.
  const [edwNumAfter] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, edwNum.id));
  ok(edwNumAfter.staticCampaignId === edw.id, "static GBP number wired to its listing");
  const [pooledAfter] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, pooled.id));
  ok(pooledAfter.staticCampaignId === null, "pooled number NOT wired (its campaign comes from the lease)");

  // `applyNumberPatch` is what both Settings → Numbers and the MCP
  // `arbor_update_number` tool call, so pointing a number at a campaign has to work
  // through it and not only through the seed.
  const patched = await applyNumberPatch(edwNum.id, { staticCampaignId: ofa.id });
  ok(patched?.staticCampaignId === ofa.id, "applyNumberPatch re-points a number's campaign");
  const cleared = await applyNumberPatch(edwNum.id, { staticCampaignId: null });
  ok(cleared?.staticCampaignId === null, "…and null clears it");
  const untouched = await applyNumberPatch(edwNum.id, { friendlyName: "GBP Edwardsville" });
  ok(untouched?.staticSourceId === gbp.id, "…while an unrelated field leaves the source alone");
  ok((await applyNumberPatch("no-such-id", { friendlyName: "x" })) === null, "…and an unknown id returns null, not a throw");
  await applyNumberPatch(edwNum.id, { staticCampaignId: edw.id });

  const listed = (await listTrackingNumbers()).find((n) => n.id === edwNum.id);
  ok(listed?.sourceKey === "gbp" && listed?.campaignName === "Edwardsville",
    "list_numbers resolves the source key and campaign name, so a caller needs no second lookup");

  const [edwNumAfter2] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, edwNum.id));
  const att = await resolveInboundAttribution(edwNumAfter2);
  ok(att.staticCampaignId === edw.id, "resolveInboundAttribution returns it for a static number");
  ok(att.lease === null && att.sourceKey === "gbp", "…alongside the source, with no lease");
  const pooledAtt = await resolveInboundAttribution(pooledAfter);
  ok(pooledAtt.staticCampaignId === null, "…and null for a pooled number");

  // ── The canary's lease must never be the answer for a caller ─────────────────
  // The 2026-09-05 shape: a customer leased this number from a Google ad an hour
  // ago, the canary took it ten minutes ago and released it. Release leaves
  // `expires_at` in the future and the lookup ranks by newest, so without the
  // exclusion the monitor's `direct` snapshot won and the paid click was lost.
  await db.insert(visitors).values({ id: CANARY_VISITOR_ID }).onConflictDoNothing();
  await db
    .insert(webSessions)
    .values({ id: CANARY_SESSION_ID, visitorId: CANARY_VISITOR_ID, landingPage: "https://arbor-mgmt.com" })
    .onConflictDoNothing();
  const min = 60_000;
  const [customerLease] = await db.insert(numberAssignments).values({
    trackingNumberId: pooled.id, webSessionId: null, source: "google/cpc", medium: "cpc", gclid: "verify-gclid",
    assignedAt: new Date(Date.now() - 60 * min), expiresAt: new Date(Date.now() - 45 * min), releasedAt: new Date(Date.now() - 45 * min),
  }).returning();
  await db.insert(numberAssignments).values({
    trackingNumberId: pooled.id, webSessionId: CANARY_SESSION_ID, visitorId: CANARY_VISITOR_ID, source: "direct", keyword: CANARY_TERM,
    assignedAt: new Date(Date.now() - 10 * min), expiresAt: new Date(Date.now() + 5 * min), releasedAt: new Date(Date.now() - 10 * min + 5_000),
    landingPage: "https://arbor-mgmt.com",
  });
  const shadowed = await resolveInboundAttribution(pooledAfter);
  ok(shadowed.sourceKey === "google/cpc" && shadowed.lease?.keyword !== CANARY_TERM,
    "a caller resolves to the customer's lease, not the canary's newer one");
  await db.delete(numberAssignments).where(eq(numberAssignments.id, customerLease.id));
  const alone = await resolveInboundAttribution(pooledAfter);
  ok(alone.lease === null && alone.sourceKey === null,
    "…and with only the canary's lease on the number the answer is NO lease, not the monitor's snapshot");

  // Backfill.
  const [unknownAfter] = await db.select().from(leads).where(eq(leads.id, unknownLead.id));
  ok(unknownAfter.campaignId === null, "gbp lead with no tag left alone");
  const [poolAfter] = await db.select().from(leads).where(eq(leads.id, poolCallLead.id));
  ok(poolAfter.campaignId === ofa.id, "pool-number gbp call recovered from its landing-page tag");

  // The tag is matched with its delimiters, so a longer token cannot collide.
  const [decoy] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[0],
    landingPage: "https://arbor-mgmt.com/?utm_campaign=ofallon-print-2026",
  }).returning();
  await seedDefaults(db);
  const [decoyAfter] = await db.select().from(leads).where(eq(leads.id, decoy.id));
  ok(decoyAfter.campaignId === null, "utm_campaign=ofallon-print-2026 does NOT match ofallon");

  // ---------------------------------------------------------------------------
  // The TRANSPOSED tag: `?utm_campaign=gmb&utm_source=ofallon`, which is what both
  // profiles' "Request a quote" buttons carried from April to September 2026 — the
  // listing in the source slot, the channel in the campaign slot, no utm_medium at
  // all. It classified as `other` with a null campaign, so a $7,705 estimate on
  // 2026-09-01 reached /sources as "Other / Unmapped". The buttons are fixed; these
  // are the checks that the cached and bookmarked copies of them still land right.
  // ---------------------------------------------------------------------------
  ok(classifySource({ utmCampaign: "gmb", utmSource: "ofallon" }).sourceKey === "gbp",
    "transposed GBP tag classifies as gbp, not other");
  ok(classifySource({ utmSource: "gmb", utmMedium: "organic" }).sourceKey === "gbp",
    "`gmb` in the source slot is gbp too — the abbreviation used to miss");
  ok(classifySource({ utmSource: "google+my+business", utmMedium: "organic", utmCampaign: "ofallon" }).sourceKey === "gbp",
    "the CORRECT tag is unaffected");
  // The paid tests sit in front of this, and must stay there: a campaign token can
  // never be allowed to turn a click that carries ad evidence into organic traffic.
  ok(classifySource({ gclid: "abc", utmCampaign: "gmb" }).sourceKey === "google/cpc",
    "a gclid still wins over a gbp campaign token");
  ok(classifySource({ utmSource: "google", utmMedium: "cpc", utmCampaign: "gmb" }).sourceKey === "google/cpc",
    "an explicit medium=cpc still wins over a gbp campaign token");
  // A campaign slot alone says which ASSET was clicked, not where the visitor came
  // from — so it must not bury an otherwise-identifiable visit in `other`.
  ok(classifySource({ utmCampaign: "spring-sale", referrer: "https://google.com/" }).sourceKey === "organic/seo",
    "an unrecognised campaign alone falls through to the referrer, not into other");
  ok(classifySource({ utmSource: "mystery" }).sourceKey === "other",
    "…while a source we do not know is still unmapped");
  // Referrer rules: one seeded `referral`, never a source per host.
  ok(classifySource({ referrer: "https://www.yelp.com/biz/arbor", currentUrl: "https://arbor-mgmt.com/" }).sourceKey === "referral",
    "a referring host classifies as the seeded `referral`, not `<host>/referral`");
  ok(classifySource({ referrer: "https://m.facebook.com/", currentUrl: "https://arbor-mgmt.com/" }).sourceKey === "facebook/organic",
    "…facebook/organic for a Meta referrer without a click id (now seeded)");
  ok(classifySource({ referrer: "https://arbor-mgmt.com/services", currentUrl: "https://arbor-mgmt.com/contact" }).sourceKey === "direct",
    "…and an internal navigation is not a referral");

  const [transposed] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[3],
    landingPage: "https://arbor-mgmt.com/get-a-quote?utm_campaign=gmb&utm_source=ofallon",
  }).returning();
  // The same delimiter rule has to hold in the source slot as in the campaign slot.
  const [srcDecoy] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[0],
    landingPage: "https://arbor-mgmt.com/?utm_source=ofallon-yardsign",
  }).returning();
  await seedDefaults(db);
  const [transposedAfter] = await db.select().from(leads).where(eq(leads.id, transposed.id));
  ok(transposedAfter.campaignId === ofa.id, "listing recovered from the utm_SOURCE slot when the tag was transposed");
  const [srcDecoyAfter] = await db.select().from(leads).where(eq(leads.id, srcDecoy.id));
  ok(srcDecoyAfter.campaignId === null, "utm_source=ofallon-yardsign does NOT match ofallon");
  // Fill-only-a-NULL survives the widened match: a listing already decided stays put.
  await db.update(leads).set({ campaignId: edw.id }).where(eq(leads.id, transposed.id));
  await seedDefaults(db);
  const [transposedHeld] = await db.select().from(leads).where(eq(leads.id, transposed.id));
  ok(transposedHeld.campaignId === edw.id, "…and a campaign already set is never overwritten by either slot");

  // ── reclassify reads the RAW tag from the entry URL, never web_sessions.source ──
  // `web_sessions.source` holds the CLASSIFIED key. For a lead on `other` that is
  // the string "other", and feeding it back in as utm_source returns "other" forever
  // — so until 2026-09-05 a session-backed lead could only be rescued through
  // `medium` or `utm_campaign`, and a mapping keyed on the source slot alone reached
  // only leads with no session. The form shape is the hard one: the lead's own
  // landing page is the FORM page and carries no tag; the session's entry url does.
  const [otherSrc] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, "other")).limit(1);
  if (!otherSrc) throw new Error("seedDefaults did not create the other source");
  const [rcVisitor] = await db.insert(visitors).values({}).returning();
  const [rcSession] = await db.insert(webSessions).values({
    visitorId: rcVisitor.id, source: "other", medium: "referral", landingPage: "https://arbor-mgmt.com/?utm_source=gmb",
  }).returning();
  const [rcLead] = await db.insert(leads).values({
    type: "web_form", sourceId: otherSrc.id, occurredAt: new Date(), phoneE164: FIXTURES[3],
    landingPage: "https://arbor-mgmt.com/get-a-quote", webSessionId: rcSession.id,
  }).returning();
  const [ctrlSession] = await db.insert(webSessions).values({
    visitorId: rcVisitor.id, source: "other", medium: "referral", landingPage: "https://arbor-mgmt.com/?utm_source=mystery",
  }).returning();
  const [ctrlLead] = await db.insert(leads).values({
    type: "web_form", sourceId: otherSrc.id, occurredAt: new Date(), phoneE164: FIXTURES[0],
    landingPage: "https://arbor-mgmt.com/get-a-quote", webSessionId: ctrlSession.id,
  }).returning();
  const dry = await reclassifyUnmappedSources({ apply: false });
  ok(dry.moves.some((m) => m.leadId === rcLead.id && m.to === "gbp"),
    "reclassify rescues a session-backed `other` lead from its ENTRY url's raw utm_source");
  ok(!dry.moves.some((m) => m.leadId === ctrlLead.id),
    "…and leaves one whose entry url names a source it does not know");

  // Does the backfill actually REACH the dashboards? /sources reads roi_daily, not
  // leads, so a backfilled lead is invisible until the rollup is rebuilt over its
  // date. runAttribution rebuilds a 365-day window, and tracking only began
  // 2026-08-08, so every tracked lead there has ever been is inside it — but that is
  // an argument, and this is the check. A lead dated 60 days back, backfilled from
  // its landing-page tag, must appear in roi_daily under the campaign.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  const [oldPoolCall] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: sixtyDaysAgo, phoneE164: FIXTURES[2],
    landingPage: "https://arbor-mgmt.com/?utm_campaign=edwardsville",
  }).returning();
  await seedDefaults(db);
  const [oldAfter] = await db.select().from(leads).where(eq(leads.id, oldPoolCall.id));
  ok(oldAfter.campaignId === edw.id, "a 60-day-old lead is backfilled too");

  await runAttribution({ windowDays: 90, roiWindowDays: 365 });
  const rolled = await db.select().from(roiDaily).where(eq(roiDaily.campaignId, edw.id));
  ok(rolled.length > 0, `roi_daily carries the campaign after a rebuild (${rolled.length} row(s))`);
  ok(
    rolled.some((r) => r.contactsCount > 0),
    "…and the historical contact is counted under it, so /sources shows it",
  );

  // ── Two campaigns, one name ────────────────────────────────────────────────
  // Inserted dead-first so the naive `limit(1)` with no ordering would tend to
  // return the wrong one, which is what actually happened in production.
  const [dead] = await db.insert(campaigns).values({
    platform: "google", externalCampaignId: DUP_DEAD, name: DUP_NAME,
  }).returning();
  const [live] = await db.insert(campaigns).values({
    platform: "google", externalCampaignId: DUP_LIVE, name: DUP_NAME,
  }).returning();

  const today = new Date();
  const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const spendOn = (campaignId: string, date: string, extId: string) =>
    db
      .insert(adSpend)
      .values({ platform: "google", externalCampaignId: extId, campaignId, date, spendCents: 100 })
      .onConflictDoNothing();

  // Recent spend on the live one BEFORE any seed runs. Without it both fixtures are
  // stale, the very first seedDefaults below correctly suffixes both, and the
  // one-live-one-stale case can never be reached — which is what happened when this
  // was written in the order the assertions appear.
  await spendOn(live.id, daysAgo(1), DUP_LIVE);

  const adUrl = `https://arbor-mgmt.com/?utm_campaign=${encodeURIComponent(DUP_NAME)}&gad_campaignid=${DUP_LIVE}&gclid=x`;
  ok(campaignIdFromUrl(adUrl) === DUP_LIVE, "gad_campaignid is read off the URL");
  ok(campaignIdFromUrl("https://arbor-mgmt.com/?campaign_id=99900001") === DUP_LIVE, "campaign_id is read too");
  ok(campaignIdFromUrl("https://arbor-mgmt.com/?gad_campaignid=notanid") === null, "a non-numeric id is ignored");
  ok(campaignIdFromUrl("https://arbor-mgmt.com/") === null, "an untagged URL yields nothing");

  ok(
    (await resolveCampaignId({ name: DUP_NAME, url: adUrl })) === live.id,
    "the URL's campaign id beats the shared name",
  );
  ok(
    (await resolveCampaignId({ name: DUP_NAME, url: `https://arbor-mgmt.com/?gad_campaignid=${DUP_DEAD}` })) === dead.id,
    "…and picks the other one when the URL says so, so it is reading the id and not just preferring newer",
  );
  const noUrl = await resolveCampaignId({ name: DUP_NAME });
  ok(noUrl === live.id || noUrl === dead.id, "a name with no URL still resolves (ambiguously — hence the diagnostic)");
  ok(
    (await resolveCampaignId({ name: DUP_NAME, url: "https://arbor-mgmt.com/?gad_campaignid=99999999" })) !== null,
    "an unknown URL id falls back to the name rather than dropping the campaign",
  );

  // The repair: a lead filed under the dead campaign whose own URL names the live one.
  const [misrouted] = await db.insert(leads).values({
    type: "web_form", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[0],
    campaignId: dead.id, landingPage: adUrl,
  }).returning();
  const [untagged] = await db.insert(leads).values({
    type: "web_form", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[1],
    campaignId: dead.id, landingPage: "https://arbor-mgmt.com/?utm_campaign=whatever",
  }).returning();

  // The web-form shape: the lead's own landing page is the page the FORM was on and
  // names no campaign, while the SESSION it belongs to entered on the tagged ad URL.
  // This is what the five leads still stranded on the removed campaign turned out to
  // be, and the first version of the repair could not see them.
  const [visitor] = await db.insert(visitors).values({}).returning();
  const [session] = await db.insert(webSessions).values({
    visitorId: visitor.id,
    landingPage: adUrl,
    lastPage: "https://arbor-mgmt.com/services",
  }).returning();
  const [formLead] = await db.insert(leads).values({
    type: "web_form", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[2],
    campaignId: dead.id,
    landingPage: "https://arbor-mgmt.com/services/tree-and-plant-healthcare",
    webSessionId: session.id,
  }).returning();

  await seedDefaults(db);
  const [formFixed] = await db.select().from(leads).where(eq(leads.id, formLead.id));
  ok(formFixed.campaignId === live.id, "a form lead is repaired from its SESSION's entry URL");
  const [fixed] = await db.select().from(leads).where(eq(leads.id, misrouted.id));
  ok(fixed.campaignId === live.id, "a misrouted lead is repaired from its own landing page");
  const [left] = await db.select().from(leads).where(eq(leads.id, untagged.id));
  ok(left.campaignId === dead.id, "a lead whose URL names no campaign is left alone");

  await seedDefaults(db);
  const [stillFixed] = await db.select().from(leads).where(eq(leads.id, misrouted.id));
  ok(stillFixed.campaignId === live.id, "the repair is a no-op on re-run, not a flip-flop");

  // ── A human correction outranks every automatic pass ────────────────────────
  // The repair pass above is the ONE that overwrites a set value. Point a lead at the
  // dead campaign BY HAND while its URL names the live one: without the lock the next
  // seed would flip it back, silently, with nothing saying which value was live.
  const [cpcSrc] = await db.select({ id: sources.id, key: sources.key }).from(sources).where(eq(sources.key, "google/cpc")).limit(1);
  if (!cpcSrc) throw new Error("seed did not create google/cpc");
  const [pinned] = await db.insert(leads).values({
    type: "call", sourceId: cpcSrc.id, occurredAt: new Date(), phoneE164: FIXTURES[3],
    campaignId: live.id, landingPage: `https://arbor-mgmt.com/?gad_campaignid=${DUP_LIVE}`,
  }).returning();
  const pin = await setLeadAttribution(pinned.id, { campaignId: dead.id, note: "verify: pinned by hand" });
  ok(pin.ok && pin.lead.campaignId === dead.id, "setLeadAttribution points a lead at a campaign its URL disagrees with");
  await seedDefaults(db);
  const [pinnedAfter] = await db.select().from(leads).where(eq(leads.id, pinned.id));
  ok(pinnedAfter.campaignId === dead.id, "…and the URL-repair pass leaves the hand-set campaign alone on the next seed");
  // The fill-only-NULL listing pass must also respect a deliberately CLEARED campaign.
  const [clearedGbp] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[0],
    campaignId: ofa.id, landingPage: "https://arbor-mgmt.com/?utm_campaign=ofallon",
  }).returning();
  await setLeadAttribution(clearedGbp.id, { campaignId: null, note: "verify: no listing, on purpose" });
  await seedDefaults(db);
  const [clearedAfter] = await db.select().from(leads).where(eq(leads.id, clearedGbp.id));
  ok(clearedAfter.campaignId === null, "…and the listing backfill does not refill a campaign a human cleared");
  await setLeadAttribution(clearedGbp.id, { manual: false });
  await seedDefaults(db);
  const [refilled] = await db.select().from(leads).where(eq(leads.id, clearedGbp.id));
  ok(refilled.campaignId === ofa.id, "…until the lock is released, when the backfill fills it as usual");

  // ── Disambiguating a shared name ───────────────────────────────────────────
  // The rule is "suffix a duplicate-named campaign that has no spend inside the
  // spend sync's re-pull window", and the window is the whole safety argument, so
  // all three cases are exercised rather than just Arbor's.
  // Case 1: one live, one stale — Arbor's. Only the stale one is renamed. The
  // seeds above have already run the pass; this reads the result.
  const [liveAfter] = await db.select().from(campaigns).where(eq(campaigns.id, live.id));
  const [deadAfter] = await db.select().from(campaigns).where(eq(campaigns.id, dead.id));
  ok(liveAfter.name === DUP_NAME, "the campaign still spending keeps the bare name");
  ok(deadAfter.name === `${DUP_NAME} (${DUP_DEAD})`, "the stale one is suffixed with its platform id");

  // …and the bare name now resolves to exactly one campaign, which is the point.
  ok((await resolveCampaignId({ name: DUP_NAME })) === live.id, "a name-only lead now resolves to the live campaign");

  // Idempotent: the group no longer exists, so nothing is suffixed twice.
  await seedDefaults(db);
  const [deadAgain] = await db.select().from(campaigns).where(eq(campaigns.id, dead.id));
  ok(deadAgain.name === `${DUP_NAME} (${DUP_DEAD})`, "re-running does not suffix it twice");

  // Case 2: BOTH inside the re-pull window — neither may be touched, or this pass
  // and ensureCampaigns would rename each other's rows every few hours.
  const BOTH = "Verify | Both Live";
  const [bl1] = await db.insert(campaigns).values({ platform: "google", externalCampaignId: "99900003", name: BOTH }).returning();
  const [bl2] = await db.insert(campaigns).values({ platform: "google", externalCampaignId: "99900004", name: BOTH }).returning();
  await spendOn(bl1.id, daysAgo(2), "99900003");
  await spendOn(bl2.id, daysAgo(3), "99900004");
  await seedDefaults(db);
  const bothAfter = await db.select().from(campaigns).where(inArray(campaigns.id, [bl1.id, bl2.id]));
  ok(bothAfter.every((c) => c.name === BOTH), "two actively-spending campaigns are left alone, so no rename flip-flop");

  // Case 3: both stale — both suffixed, so the bare name resolves to nothing at all.
  const NEITHER = "Verify | Both Stale";
  const [ns1] = await db.insert(campaigns).values({ platform: "google", externalCampaignId: "99900005", name: NEITHER }).returning();
  const [ns2] = await db.insert(campaigns).values({ platform: "google", externalCampaignId: "99900006", name: NEITHER }).returning();
  await spendOn(ns1.id, daysAgo(SPEND_REPULL_DAYS + 5), "99900005");
  await seedDefaults(db);
  const staleAfter = await db.select().from(campaigns).where(inArray(campaigns.id, [ns1.id, ns2.id]));
  ok(staleAfter.every((c) => c.name !== NEITHER), "two stale campaigns are both suffixed");
  ok((await resolveCampaignId({ name: NEITHER })) === null, "…so the shared name resolves to nothing rather than a coin flip");

  // ── a static number's campaign reaching the calls already taken ────────────
  // /voice stamps static_campaign_id at call time, so pointing a number at a
  // campaign leaves earlier calls uncampaigned. This is the shape of the Google Ads
  // call asset: a static number whose callers carry no gclid and no landing page.
  const [assetNum] = await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[3], twilioSid: "PNverifyAsset", pool: "reserved",
    isStatic: true, staticSourceId: gbp.id, staticCampaignId: live.id,
  }).returning();
  const [callLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[3],
  }).returning();
  const [alreadyAttributed] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, occurredAt: new Date(), phoneE164: FIXTURES[3], campaignId: dead.id,
  }).returning();
  await db.insert(calls).values([
    { twilioCallSid: "CAverify1", trackingNumberId: assetNum.id, leadId: callLead.id },
    { twilioCallSid: "CAverify2", trackingNumberId: assetNum.id, leadId: alreadyAttributed.id },
  ]);

  await seedDefaults(db);
  const [callFixed] = await db.select().from(leads).where(eq(leads.id, callLead.id));
  ok(callFixed.campaignId === live.id, "an uncampaigned call inherits its static number's campaign");
  const [notClobbered] = await db.select().from(leads).where(eq(leads.id, alreadyAttributed.id));
  ok(notClobbered.campaignId === dead.id,
    "…and a call that already had a campaign keeps it — the number is the coarsest signal, not the winner");

  await db.delete(calls).where(inArray(calls.twilioCallSid, ["CAverify1", "CAverify2"]));
  await db.delete(leads).where(inArray(leads.id, [callLead.id, alreadyAttributed.id]));
  await db.delete(trackingNumbers).where(eq(trackingNumbers.id, assetNum.id));

  // Idempotency + non-destructiveness.
  await db.update(leads).set({ campaignId: edw.id }).where(eq(leads.id, poolCallLead.id));
  await db.update(trackingNumbers).set({ staticCampaignId: ofa.id }).where(eq(trackingNumbers.id, edwNum.id));
  await seedDefaults(db);
  const after2 = await db.select().from(campaigns).where(eq(campaigns.sourceId, gbp.id));
  ok(after2.length === 2, "re-seed creates no duplicates");
  const [leadAfter2] = await db.select().from(leads).where(eq(leads.id, poolCallLead.id));
  ok(leadAfter2.campaignId === edw.id, "re-seed does NOT overwrite a corrected lead");
  const [numAfter2] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, edwNum.id));
  ok(numAfter2.staticCampaignId === ofa.id, "re-seed does NOT overwrite a corrected number");
}
main()
  .then(() => {
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
