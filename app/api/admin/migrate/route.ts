import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/lib/db/client";
import { connectForSchemaWork } from "@/lib/db/connect";
import { seedDefaults } from "@/lib/db/seed-data";
import { sources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Secret-gated DB bootstrap — the escape hatch for when the normal path (Railway's
 * pre-deploy `npm run db:deploy`) isn't available or has failed. Applies the
 * Drizzle migrations and seeds the canonical sources/pools. Idempotent: the
 * migrator tracks its journal and the seed uses onConflictDoNothing.
 *
 * Trigger: GET /api/admin/migrate with `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(req: Request) {
  // Accept the secret via Authorization header OR ?secret= query param (so it can be
  // triggered from a browser, since the sandbox can't reach the SSO-protected URL).
  const auth = req.headers.get("authorization");
  const querySecret = new URL(req.url).searchParams.get("secret");
  const authorized =
    !!env.CRON_SECRET && (auth === `Bearer ${env.CRON_SECRET}` || querySecret === env.CRON_SECRET);
  if (!authorized) {
    return new Response("unauthorized", { status: 401 });
  }

  // Direct endpoint for the migration itself; the shared request-path client
  // handles the seed writes.
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  const migrator = connectForSchemaWork(url, env.DB_DRIVER);
  try {
    // 1) Migrate
    await migrator.migrate();

    // 2) Seed canonical sources + pools (idempotent)
    await seedDefaults(db);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sources);

    // 3) Report which key tables exist so we can confirm 0001 actually applied
    //    (a prior migrate may have run on a build that predated this migration).
    const res = await db.execute(
      sql`select to_regclass('public.integration_credentials')::text as creds_table`,
    );
    const rows = (res as unknown as { rows?: Array<{ creds_table: string | null }> }).rows ?? [];
    const credsTableExists = !!rows[0]?.creds_table;

    return Response.json({
      ok: true,
      migrated: true,
      driver: migrator.driver,
      sources: count,
      tables: { integration_credentials: credsTableExists },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    await migrator.close();
  }
}
