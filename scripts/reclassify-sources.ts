/**
 * Move leads off the `other` ("Other / Unmapped") source once `classifySource`
 * learns a channel it previously did not recognise.
 *   npm run db:reclassify-sources           # dry run — prints what would change
 *   npm run db:reclassify-sources -- --apply
 *
 * The logic lives in lib/sources/reclassify.ts, shared with
 * POST /api/admin/reclassify-sources — which is the only way to run this against
 * production, since the Railway Postgres has no public TCP proxy. This script is
 * for a local database, or for a Railway one-off job with the internal DATABASE_URL.
 */
import { reclassifyUnmappedSources } from "../lib/sources/reclassify";

const APPLY = process.argv.includes("--apply");

if (!process.env.DATABASE_URL_UNPOOLED && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
}

async function main() {
  const result = await reclassifyUnmappedSources({ apply: APPLY });
  console.log(`${result.scanned} lead(s) on "other".`);
  for (const m of result.moves) {
    console.log(`  ${m.occurredAt ?? "(no date)"} ${m.type.padEnd(16)} ${m.from} → ${m.to}`);
  }
  const summary = Object.entries(result.byKey)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  console.log(`\n${result.moved} lead(s) ${APPLY ? "moved" : "would move"}: ${summary || "none"}`);
  console.log(result.note);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
