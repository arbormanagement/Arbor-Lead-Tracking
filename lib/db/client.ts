import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * Two interchangeable drivers behind one `db` export, chosen by `DB_DRIVER`:
 *
 * - `pg` (default) — node-postgres over a long-lived TCP pool. Correct for a
 *   persistent server process (Railway): the connection is reused across
 *   requests instead of paying an HTTPS round-trip per query, and it supports
 *   interactive transactions, which the Phase 4 DNI lease
 *   (`SELECT … FOR UPDATE SKIP LOCKED`) needs. Works against any Postgres —
 *   Neon's pooled endpoint or a Railway Postgres instance.
 * - `neon-http` — Neon's stateless HTTPS driver. Needed on serverless/edge
 *   runtimes (no warm process to hold a socket) and in networks that block raw
 *   Postgres TCP but allow HTTPS.
 *
 * Both expose the same Drizzle query builder, so nothing downstream changes; the
 * exported type is the node-postgres flavour since that is the default.
 */
type DrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;

const config = { schema, casing: "snake_case" as const };

function createDb(): DrizzleDb {
  if (env.DB_DRIVER === "neon-http") {
    // Same query surface; only `db.execute()`'s raw result shape differs, and the
    // two callers of it already narrow with a cast.
    return drizzleHttp(neon(env.DATABASE_URL), config) as unknown as DrizzleDb;
  }

  // Next.js dev reloads this module on every edit; without the global cache each
  // reload would leak a pool and eventually exhaust Postgres connections.
  const globalForPool = globalThis as typeof globalThis & { __arborPgPool?: Pool };
  const pool =
    globalForPool.__arborPgPool ??
    new Pool({
      connectionString: env.DATABASE_URL,
      // Small ceiling: the app is single-tenant, and Neon's pooler and Railway
      // Postgres both have modest connection limits that the web service and the
      // cron worker share.
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  if (env.NODE_ENV !== "production") globalForPool.__arborPgPool = pool;

  return drizzlePg(pool, config);
}

export const db = createDb();
export { schema };
export type Db = typeof db;
