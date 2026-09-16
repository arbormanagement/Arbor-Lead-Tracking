import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

/**
 * node-postgres over a long-lived TCP pool. Correct for a persistent server process
 * (Railway): the connection is reused across requests instead of paying a round-trip
 * per query, and it supports the interactive transactions the DNI lease
 * (`SELECT … FOR UPDATE SKIP LOCKED`) needs.
 *
 * Until 2026-09-16 a second driver (`neon-http`, Neon's stateless HTTPS transport)
 * sat behind `DB_DRIVER`. It was Neon-only by construction and the Neon project is
 * gone, so it went with it. `DB_DRIVER` is still accepted (Railway sets it) but `pg`
 * is the only value.
 */
type DrizzleDb = ReturnType<typeof drizzlePg<typeof schema>>;

const config = { schema, casing: "snake_case" as const };

function createDb(): DrizzleDb {
  // Next.js dev reloads this module on every edit; without the global cache each
  // reload would leak a pool and eventually exhaust Postgres connections.
  const globalForPool = globalThis as typeof globalThis & { __arborPgPool?: Pool };
  const pool =
    globalForPool.__arborPgPool ??
    new Pool({
      connectionString: env.DATABASE_URL,
      // Small ceiling: the app is single-tenant, and Railway Postgres has a modest
      // connection limit that the web service and the cron worker share.
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
