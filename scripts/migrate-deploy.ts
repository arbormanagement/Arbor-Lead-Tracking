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
 */
import { connectForSchemaWork, resolveDriver } from "../lib/db/connect";
import { seedDefaults } from "../lib/db/seed-data";

// Prefer the direct (unpooled) endpoint: migrations issue session-level
// statements and take locks that a PgBouncer-style transaction pooler mishandles.
// A single-URL Postgres (Railway) just sets DATABASE_URL and falls through here.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

async function main() {
  if (!url) {
    throw new Error("[migrate-deploy] DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  }

  const { db, driver, migrate, close } = connectForSchemaWork(url, resolveDriver(process.env.DB_DRIVER));
  try {
    console.log(`[migrate-deploy] applying migrations via ${driver}…`);
    await migrate();

    console.log("[migrate-deploy] seeding defaults…");
    const { sources, pools } = await seedDefaults(db);

    console.log(`[migrate-deploy] ✓ migrations applied + ${sources} sources / ${pools} pools seeded`);
  } finally {
    await close();
  }
}

main().catch((e) => {
  console.error("[migrate-deploy] FAILED:", e);
  process.exit(1);
});
