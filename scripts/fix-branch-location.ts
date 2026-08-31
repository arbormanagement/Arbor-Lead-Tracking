/**
 * One-off repair: clear branch locations that were never branch touches.
 *
 * `/api/track` used to infer a location from the PAGE URL as well as the campaign,
 * so any visitor who landed on or submitted a form from a page whose path contains
 * "edwardsville" or "ofallon" was recorded as a contact from that Google Business
 * Profile — including paid traffic that had nothing to do with either profile.
 *
 * A branch touch is exactly one of two things:
 *   • a call or text to that profile's own tracking number, or
 *   • a web touch carrying that profile's utm_campaign, which is recorded as the
 *     "Edwardsville" / "O'Fallon" campaign.
 *
 * Everything else is `unknown`. This clears the rest, then leaves roi_daily alone:
 * `attribution.run` is a full idempotent rebuild over a rolling window, so the
 * rollup re-derives itself from the corrected leads on its next pass.
 *
 * Run:  npx tsx scripts/fix-branch-location.ts [--apply]
 * Without --apply it only reports, so the blast radius is visible first.
 */
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, leads, webSessions } from "@/lib/db/schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const branchCampaigns = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(inArray(campaigns.externalCampaignId, ["edwardsville", "ofallon"]));
  const branchIds = branchCampaigns.map((c) => c.id);
  console.log(`branch campaigns: ${branchCampaigns.map((c) => `${c.name} (${c.id})`).join(", ") || "none"}`);
  if (!branchIds.length) {
    console.error("No branch campaigns found — refusing to run, since every lead would look unjustified.");
    process.exit(1);
  }

  // A lead keeps its branch only if it came through a branch campaign. Calls and
  // texts are already covered: their campaign is resolved from the tracking number
  // that rang, which is the same campaign.
  const suspect = and(
    ne(leads.location, "unknown"),
    isNotNull(leads.location),
    sql`(${leads.campaignId} is null or ${leads.campaignId} not in ${branchIds})`,
  );
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(suspect);
  console.log(`leads carrying a branch with no branch campaign: ${n}`);

  const sessSuspect = and(
    ne(webSessions.location, "unknown"),
    isNotNull(webSessions.location),
    sql`lower(coalesce(${webSessions.campaign}, '')) not like '%edwardsville%'`,
    sql`lower(coalesce(${webSessions.campaign}, '')) not like '%ofallon%'`,
  );
  const [{ m }] = await db.select({ m: sql<number>`count(*)::int` }).from(webSessions).where(sessSuspect);
  console.log(`web sessions carrying a branch with no branch utm_campaign: ${m}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to clear them.");
    return;
  }
  await db.update(leads).set({ location: "unknown" }).where(suspect);
  await db.update(webSessions).set({ location: "unknown" }).where(sessSuspect);
  console.log(`\nCleared ${n} lead(s) and ${m} session(s). roi_daily re-derives on the next attribution.run.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
