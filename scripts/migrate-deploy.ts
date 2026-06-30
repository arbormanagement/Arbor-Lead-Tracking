/**
 * Auto-apply DB migrations + seed defaults during the Vercel PRODUCTION build, so
 * schema changes ship with the code and no manual /api/admin/migrate click is ever
 * needed again.
 *
 * Runs as the first step of `npm run build`. Guarded so it ONLY does work on a
 * Vercel production build (VERCEL_ENV=production) — preview builds and local builds
 * skip it. Vercel's build network can reach Neon over HTTPS via the neon-http
 * driver (unlike this project's CI sandbox, which is egress-blocked from Neon —
 * the reason migrations historically ran from inside a deployed function instead).
 *
 * Idempotent: the Drizzle migrator tracks its journal, the seeds use
 * onConflictDoNothing. On any failure it exits non-zero to FAIL the build loudly
 * (better than a silent half-migrated deploy).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import * as schema from "../lib/db/schema";

const VERCEL_ENV = process.env.VERCEL_ENV; // 'production' | 'preview' | 'development' | undefined
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

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

const POOLS: Array<{ key: string; displayName: string; description: string; isDni: boolean }> = [
  { key: "reserved", displayName: "Reserved", description: "Default bucket for static / test numbers", isDni: false },
  { key: "google", displayName: "Google Ads", description: "DNI rotation for paid Google visitors", isDni: true },
  { key: "facebook", displayName: "Facebook / Instagram", description: "DNI rotation for Meta visitors", isDni: true },
  { key: "organic", displayName: "Organic / GBP", description: "DNI rotation for organic + GBP visitors", isDni: true },
  { key: "direct", displayName: "Direct", description: "DNI rotation for direct / unknown visitors", isDni: true },
  { key: "lsa", displayName: "Local Services Ads", description: "Static LSA tracking numbers", isDni: false },
  { key: "print", displayName: "Print / Signage", description: "Yard signs, flyers, truck wraps", isDni: false },
];

async function main() {
  if (VERCEL_ENV !== "production") {
    console.log(`[migrate-deploy] skip — VERCEL_ENV=${VERCEL_ENV ?? "unset"} (runs only on production builds)`);
    return;
  }
  if (!url) {
    throw new Error("[migrate-deploy] DATABASE_URL(_UNPOOLED) is not set on a production build");
  }

  const db = drizzle(neon(url), { schema, casing: "snake_case" });

  console.log("[migrate-deploy] applying migrations…");
  await migrate(db, { migrationsFolder: "lib/db/migrations" });

  console.log("[migrate-deploy] seeding defaults…");
  for (const s of SOURCES) {
    await db
      .insert(schema.sources)
      .values({ key: s.key, displayName: s.displayName, platform: s.platform, defaultCostModel: s.costModel })
      .onConflictDoNothing({ target: schema.sources.key });
  }
  for (const p of POOLS) {
    await db
      .insert(schema.pools)
      .values({ key: p.key, displayName: p.displayName, description: p.description, isDni: p.isDni })
      .onConflictDoNothing({ target: schema.pools.key });
  }

  console.log("[migrate-deploy] ✓ migrations applied + defaults seeded");
}

main().catch((e) => {
  console.error("[migrate-deploy] FAILED:", e);
  process.exit(1);
});
