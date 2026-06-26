/**
 * Seeds the canonical `sources` dimension. Idempotent — safe to re-run.
 *   npm run db:seed
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { sql } from "drizzle-orm";
import * as schema from "../lib/db/schema";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be set");

const db = drizzle(neon(url), { schema, casing: "snake_case" });

type Platform = (typeof schema.platformEnum.enumValues)[number];

const SOURCES: Array<{ key: string; displayName: string; platform: Platform; costModel: string }> = [
  { key: "google/cpc", displayName: "Google Ads (Search)", platform: "google", costModel: "cpc" },
  { key: "google/lsa", displayName: "Google Local Services", platform: "google_lsa", costModel: "cpl" },
  { key: "facebook/paid", displayName: "Facebook / Instagram Ads", platform: "facebook", costModel: "cpc" },
  { key: "organic/seo", displayName: "Organic Search", platform: "other", costModel: "none" },
  { key: "gbp", displayName: "Google Business Profile", platform: "other", costModel: "none" },
  { key: "direct", displayName: "Direct", platform: "other", costModel: "none" },
  { key: "referral", displayName: "Referral", platform: "other", costModel: "none" },
];

async function main() {
  for (const s of SOURCES) {
    await db
      .insert(schema.sources)
      .values({
        key: s.key,
        displayName: s.displayName,
        platform: s.platform,
        defaultCostModel: s.costModel,
      })
      .onConflictDoNothing({ target: schema.sources.key });
    console.log(`✓ source ${s.key}`);
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.sources);
  console.log(`Done — ${count} sources total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
