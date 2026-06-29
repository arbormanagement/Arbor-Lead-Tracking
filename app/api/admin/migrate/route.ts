import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * One-time, secret-gated DB bootstrap — runs from inside Vercel (whose network can
 * reach Neon) because the build/CI sandbox is egress-blocked from Neon. Applies the
 * Drizzle migrations and seeds the canonical sources. Idempotent: the migrator
 * tracks its journal and the seed uses onConflictDoNothing. Secured by CRON_SECRET.
 *
 * Trigger: GET /api/admin/migrate with `Authorization: Bearer <CRON_SECRET>`.
 */
const SEED_SOURCES: Array<{ key: string; displayName: string; platform: "google" | "google_lsa" | "facebook" | "other"; costModel: string }> = [
  { key: "google/cpc", displayName: "Google Ads (Search)", platform: "google", costModel: "cpc" },
  { key: "google/lsa", displayName: "Google Local Services", platform: "google_lsa", costModel: "cpl" },
  { key: "facebook/paid", displayName: "Facebook / Instagram Ads", platform: "facebook", costModel: "cpc" },
  { key: "organic/seo", displayName: "Organic Search", platform: "other", costModel: "none" },
  { key: "gbp", displayName: "Google Business Profile", platform: "other", costModel: "none" },
  { key: "direct", displayName: "Direct", platform: "other", costModel: "none" },
  { key: "referral", displayName: "Referral", platform: "other", costModel: "none" },
];

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

  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  try {
    // 1) Migrate
    const migrator = drizzle(neon(url));
    await migrate(migrator, { migrationsFolder: "lib/db/migrations" });

    // 2) Seed canonical sources (idempotent)
    for (const s of SEED_SOURCES) {
      await db
        .insert(sources)
        .values({ key: s.key, displayName: s.displayName, platform: s.platform, defaultCostModel: s.costModel })
        .onConflictDoNothing({ target: sources.key });
    }
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
      sources: count,
      tables: { integration_credentials: credsTableExists },
    });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
