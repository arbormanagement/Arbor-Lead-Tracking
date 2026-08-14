import { eq } from "drizzle-orm";
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
  { key: "facebook/paid", displayName: "Facebook / Instagram Ads", platform: "facebook", costModel: "cpc" },
  { key: "organic/seo", displayName: "Organic Search", platform: "other", costModel: "none" },
  { key: "gbp", displayName: "Google Business Profile", platform: "other", costModel: "none" },
  { key: "direct", displayName: "Direct", platform: "other", costModel: "none" },
  { key: "referral", displayName: "Referral", platform: "other", costModel: "none" },
  // Catch-all for traffic we do not recognise. See lib/sources/naming.ts.
  { key: "other", displayName: "Other / Unmapped", platform: "other", costModel: "none" },
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

  for (const p of SEED_POOLS) {
    await db
      .insert(schema.pools)
      .values({ key: p.key, displayName: p.displayName, description: p.description, isDni: p.isDni })
      .onConflictDoNothing({ target: schema.pools.key });
    onRow?.(`pool ${p.key}`);
  }
  return { sources: SEED_SOURCES.length, pools: SEED_POOLS.length };
}
