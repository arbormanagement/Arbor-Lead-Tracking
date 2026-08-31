/**
 * CLI wrapper for the Arbor-Automations import — the logic lives in
 * lib/reviews/import-automations.ts, shared with the admin route
 * (POST /api/admin/import-automations), which is how production runs it: neither
 * Postgres has a public TCP proxy, so only the web service can reach both ends
 * (the old DB via a temporary Railway TCP proxy, deleted after the cutover).
 *
 *   OLD_DATABASE_URL=postgres://... npm run db:import-automations           # dry run
 *   OLD_DATABASE_URL=postgres://... npm run db:import-automations -- --apply
 */
import { importAutomationsData } from "@/lib/reviews/import-automations";

async function main() {
  const oldUrl = process.env.OLD_DATABASE_URL;
  if (!oldUrl) throw new Error("OLD_DATABASE_URL must be set (the Arbor-Automations Postgres)");
  const apply = process.argv.includes("--apply");

  const r = await importAutomationsData({ oldUrl, apply });
  console.log(`source: ${r.sourceReviews} review_requests, ${r.sourceCatchups} catchup_texts`);
  if (!apply) {
    if (r.dryRunSample) {
      console.log("dry run — newest review row would import as:");
      console.log(r.dryRunSample);
    }
    console.log("pass --apply to write");
    return;
  }
  console.log(`reviews: ${r.reviewsUpserted} upserted (state-advancing on re-run)`);
  if (r.mergedDuplicateTrackingIds.length) {
    console.log(`         ${r.mergedDuplicateTrackingIds.length} old-DB duplicate(s) merged into their (invoice, phone) sibling: ${r.mergedDuplicateTrackingIds.join(", ")}`);
  }
  console.log(`catchup: ${r.catchupsImported} imported, ${r.catchupsSkipped} already present`);
  if (r.rowErrors.length) {
    console.error(`✗ ${r.rowErrors.length} row(s) failed:`);
    for (const e of r.rowErrors.slice(0, 10)) console.error(`   ${e}`);
  }
  if (r.missingTrackingIds.length) {
    console.error(`✗ ${r.missingTrackingIds.length} tracking ids did NOT import: ${r.missingTrackingIds.slice(0, 5).join(", ")}…`);
    process.exit(1);
  }
  console.log(`✓ all ${r.sourceReviews} tracking ids resolve`);
  if (r.rowErrors.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
