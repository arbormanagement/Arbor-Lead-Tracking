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
 * number, only a named location — and every way of getting them wrong still
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
import { attributions, campaigns, leads, roiDaily, sources, trackingNumbers } from "@/lib/db/schema";
import { seedDefaults } from "@/lib/db/seed-data";
import { resolveCampaignIdByName } from "@/lib/campaigns";
import { resolveInboundAttribution } from "@/lib/twilio/inbound";
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
const FIXTURES = ["+16185550001", "+16185550002", "+16185550003"];

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
    await db.delete(leads).where(eq(leads.phoneE164, phone));
    await db.delete(trackingNumbers).where(eq(trackingNumbers.phoneNumber, phone));
  }

  const [gbp] = await db.select().from(sources).where(eq(sources.key, "gbp")).limit(1);

  // Pre-existing rows that predate the change: a static GBP number and a lead,
  // both carrying only `location`.
  const [edwNum] = await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[0], twilioSid: "PNverifyEdw", friendlyName: "GBP Edwardsville", pool: "reserved",
    isStatic: true, staticSourceId: gbp.id, location: "edwardsville",
  }).returning();
  await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[1], twilioSid: "PNverifyOfa", friendlyName: "GBP O'Fallon", pool: "reserved",
    isStatic: true, staticSourceId: gbp.id, location: "ofallon",
  });
  // A POOLED number that happens to sit at a location — must NOT be touched.
  const [pooled] = await db.insert(trackingNumbers).values({
    phoneNumber: FIXTURES[2], twilioSid: "PNverifyPool", pool: "direct", isStatic: false, location: "edwardsville",
  }).returning();

  const [oldLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, location: "ofallon", occurredAt: new Date(), phoneE164: FIXTURES[0],
  }).returning();
  const [unknownLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, location: "unknown", occurredAt: new Date(), phoneE164: FIXTURES[1],
  }).returning();
  // The real shape of every unknown-location GBP contact: a pool-number call whose
  // lease carried the listing, which /voice threw away by reading location off the
  // number. Location says nothing; the landing page says everything.
  const [poolCallLead] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, location: "unknown", occurredAt: new Date(), phoneE164: FIXTURES[2],
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
  ok((await resolveCampaignIdByName("edwardsville")) === edw.id, "utm_campaign=edwardsville → Edwardsville");
  ok((await resolveCampaignIdByName("ofallon")) === ofa.id, "utm_campaign=ofallon → O'Fallon");
  ok((await resolveCampaignIdByName("Edwardsville")) === edw.id, "display name still resolves");
  ok((await resolveCampaignIdByName("nope")) === null, "unknown utm_campaign still mints nothing");

  // Call path.
  const [edwNumAfter] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, edwNum.id));
  ok(edwNumAfter.staticCampaignId === edw.id, "static GBP number wired to its listing");
  const [pooledAfter] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, pooled.id));
  ok(pooledAfter.staticCampaignId === null, "pooled number NOT wired (its campaign comes from the lease)");

  const att = await resolveInboundAttribution(edwNumAfter);
  ok(att.staticCampaignId === edw.id, "resolveInboundAttribution returns it for a static number");
  ok(att.lease === null && att.sourceKey === "gbp", "…alongside the source, with no lease");
  const pooledAtt = await resolveInboundAttribution(pooledAfter);
  ok(pooledAtt.staticCampaignId === null, "…and null for a pooled number");

  // Backfill.
  const [leadAfter] = await db.select().from(leads).where(eq(leads.id, oldLead.id));
  ok(leadAfter.campaignId === ofa.id, "existing gbp lead backfilled from its location");
  const [unknownAfter] = await db.select().from(leads).where(eq(leads.id, unknownLead.id));
  ok(unknownAfter.campaignId === null, "gbp lead with no location and no tag left alone");
  const [poolAfter] = await db.select().from(leads).where(eq(leads.id, poolCallLead.id));
  ok(poolAfter.campaignId === ofa.id, "pool-number gbp call recovered from its landing-page tag");

  // The tag is matched with its delimiters, so a longer token cannot collide.
  const [decoy] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, location: "unknown", occurredAt: new Date(), phoneE164: FIXTURES[0],
    landingPage: "https://arbor-mgmt.com/?utm_campaign=ofallon-print-2026",
  }).returning();
  await seedDefaults(db);
  const [decoyAfter] = await db.select().from(leads).where(eq(leads.id, decoy.id));
  ok(decoyAfter.campaignId === null, "utm_campaign=ofallon-print-2026 does NOT match ofallon");

  // Does the backfill actually REACH the dashboards? /sources reads roi_daily, not
  // leads, so a backfilled lead is invisible until the rollup is rebuilt over its
  // date. runAttribution rebuilds a 365-day window, and tracking only began
  // 2026-08-08, so every tracked lead there has ever been is inside it — but that is
  // an argument, and this is the check. A lead dated 60 days back, backfilled from
  // its location, must appear in roi_daily under the campaign.
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
  const [oldPoolCall] = await db.insert(leads).values({
    type: "call", sourceId: gbp.id, location: "edwardsville", occurredAt: sixtyDaysAgo,
    phoneE164: FIXTURES[2],
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

  // Idempotency + non-destructiveness.
  await db.update(leads).set({ campaignId: edw.id }).where(eq(leads.id, oldLead.id));
  await db.update(trackingNumbers).set({ staticCampaignId: ofa.id }).where(eq(trackingNumbers.id, edwNum.id));
  await seedDefaults(db);
  const after2 = await db.select().from(campaigns).where(eq(campaigns.sourceId, gbp.id));
  ok(after2.length === 2, "re-seed creates no duplicates");
  const [leadAfter2] = await db.select().from(leads).where(eq(leads.id, oldLead.id));
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
