import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe for Railway's healthcheck (railway.json →
 * `deploy.healthcheckPath`). Railway holds the new deployment out of the load
 * balancer until this returns 2xx, so a broken build or an unreachable database
 * fails the release instead of taking calls down.
 *
 * It checks Postgres deliberately: this app's whole job is to persist inbound
 * calls, and a process that is up but can't write is worse than one that never
 * took traffic. Unauthenticated by design (probes can't hold a session) and it
 * leaks nothing beyond up/down and latency.
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", latencyMs: Date.now() - startedAt });
  } catch (err) {
    // Detail stays in the logs: pg error messages carry internal hostnames and
    // usernames (pg_hba lines), and this endpoint is unauthenticated.
    console.error("[health] db check failed:", err);
    return Response.json({ ok: false }, { status: 503 });
  }
}
