import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { migrate as migrateHttp } from "drizzle-orm/neon-http/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migratePerFile } from "./migrate-per-file";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * A one-off connection for schema work (migrate + seed), separate from the shared
 * request-path client in `client.ts`.
 *
 * It exists so every provisioning path — the pre-deploy step, `npm run db:seed`,
 * and the `/api/admin/migrate` escape hatch — resolves its driver the same way.
 * They used to each hardcode Neon's HTTP driver, which meant they silently only
 * worked against Neon; pointing the app at any other Postgres would leave you
 * with a working request path and three broken provisioning paths.
 *
 * Callers pass the URL explicitly because they want the DIRECT (unpooled)
 * endpoint: migrations issue session-level statements and take locks that a
 * transaction pooler mishandles.
 */
export type DbDriver = "pg" | "neon-http";

export function resolveDriver(value?: string | null): DbDriver {
  return value === "neon-http" ? "neon-http" : "pg";
}

export type AdminConnection = {
  db: Db;
  driver: DbDriver;
  /** Apply pending migrations from lib/db/migrations. */
  migrate: () => Promise<void>;
  /** Release the connection. No-op on the HTTP driver, which holds no socket. */
  close: () => Promise<void>;
};

const MIGRATIONS_FOLDER = "lib/db/migrations";

export function connectForSchemaWork(url: string, driver: DbDriver = "pg"): AdminConnection {
  const config = { schema, casing: "snake_case" as const };

  if (driver === "neon-http") {
    // Neon-only: this driver builds an HTTPS endpoint from the connection
    // string's hostname, so it cannot reach a non-Neon Postgres.
    const db = drizzleHttp(neon(url), config) as unknown as Db;
    return {
      db,
      driver,
      migrate: () => migrateHttp(db as never, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: async () => {},
    };
  }

  // max: 1 — schema work is strictly sequential, and this keeps a deploy step from
  // eating connection slots the running app needs.
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzlePg(pool, config);
  return {
    db,
    driver,
    // One transaction per FILE, not Drizzle's one-for-everything: the full history
    // cannot apply to an empty database otherwise (see lib/db/migrate-per-file.ts).
    // Same bookkeeping table, so `drizzle-kit migrate` still agrees with it.
    migrate: async () => {
      await migratePerFile(db, MIGRATIONS_FOLDER);
    },
    close: () => pool.end(),
  };
}
