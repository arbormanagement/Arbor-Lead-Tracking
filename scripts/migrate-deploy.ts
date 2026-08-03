/**
 * Apply DB migrations + seed defaults as a RELEASE step, so schema changes ship
 * with the code and no manual /api/admin/migrate click is ever needed.
 *
 * Invoked by `npm run db:deploy`, which Railway runs as the deploy's
 * `preDeployCommand` (see railway.json) — after the image is built, before the
 * new version takes traffic. A non-zero exit aborts the release and leaves the
 * previous version serving, which is exactly what we want: better a blocked
 * deploy than a half-migrated one.
 *
 * Runs whenever invoked — the caller decides when. Deliberately NOT part of
 * `npm run build`: the build has no business talking to production Postgres, and
 * a build-time migration would also fire on every preview/CI build.
 *
 * Idempotent: the Drizzle migrator tracks its journal and the seeds use
 * onConflictDoNothing, so re-running is a no-op.
 *
 * Transport follows DB_DRIVER (see lib/db/client.ts): `pg` over TCP by default,
 * `neon-http` over HTTPS for networks where raw Postgres egress is blocked.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { migrate as migrateHttp } from "drizzle-orm/neon-http/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";

// Prefer the direct (unpooled) endpoint: migrations issue session-level
// statements and take locks that a PgBouncer-style transaction pooler mishandles.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const driver = process.env.DB_DRIVER === "neon-http" ? "neon-http" : "pg";

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
  if (!url) {
    throw new Error("[migrate-deploy] DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  }

  const config = { schema, casing: "snake_case" as const };
  const migrationsFolder = "lib/db/migrations";

  console.log(`[migrate-deploy] applying migrations via ${driver}…`);
  let db: ReturnType<typeof drizzlePg<typeof schema>>;
  let close: () => Promise<void>;

  if (driver === "neon-http") {
    db = drizzleHttp(neon(url), config) as unknown as ReturnType<typeof drizzlePg<typeof schema>>;
    await migrateHttp(db as never, { migrationsFolder });
    close = async () => {};
  } else {
    const pool = new Pool({ connectionString: url, max: 1 });
    db = drizzlePg(pool, config);
    await migratePg(db, { migrationsFolder });
    close = () => pool.end();
  }

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
  await close();
}

main().catch((e) => {
  console.error("[migrate-deploy] FAILED:", e);
  process.exit(1);
});
