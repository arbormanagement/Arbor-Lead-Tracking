import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migratePerFile } from "./migrate-per-file";
import { Pool } from "pg";
import * as schema from "./schema";
import type { Db } from "./client";

/**
 * A one-off connection for schema work (migrate + seed), separate from the shared
 * request-path client in `client.ts`.
 *
 * It exists so every provisioning path — the pre-deploy step, `npm run db:seed`,
 * and the `/api/admin/migrate` escape hatch — resolves its driver the same way.
 * They used to each hardcode a Neon-only HTTP driver, which meant they silently only
 * worked against Neon; pointing the app at any other Postgres would leave you
 * with a working request path and three broken provisioning paths. (That driver
 * was removed 2026-09-16 with the Neon project; `pg` is the only driver now.)
 *
 * Callers pass the URL explicitly because they want the DIRECT (unpooled)
 * endpoint: migrations issue session-level statements and take locks that a
 * transaction pooler mishandles.
 */
export type DbDriver = "pg";

export function resolveDriver(_value?: string | null): DbDriver {
  return "pg";
}

export type AdminConnection = {
  db: Db;
  driver: DbDriver;
  /** Apply pending migrations from lib/db/migrations. */
  migrate: () => Promise<void>;
  /** Release the connection. */
  close: () => Promise<void>;
};

const MIGRATIONS_FOLDER = "lib/db/migrations";

export function connectForSchemaWork(url: string, driver: DbDriver = "pg"): AdminConnection {
  const config = { schema, casing: "snake_case" as const };

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
