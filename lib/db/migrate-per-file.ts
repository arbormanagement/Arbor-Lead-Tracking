import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Apply pending migrations ONE TRANSACTION PER FILE, with Drizzle's own bookkeeping.
 *
 * Drizzle's migrator applies every pending file inside a single transaction. That
 * is fine for a deploy that adds one file and fatal for an empty database: 0011
 * does `ALTER TYPE lead_status ADD VALUE 'cancelled'` and 0035/0036 use that value,
 * and Postgres refuses to use an enum value added in the same transaction
 * (`unsafe use of new value`, check_safe_enum_use). Production never saw it because
 * each deploy applied only its own new files; it bit the "starting fresh" path and
 * `/api/admin/migrate` on a blank database, i.e. disaster recovery, found 2026-09-05
 * while proving 0049. A transaction per FILE is what every deploy effectively did,
 * and it is also the smallest unit that still works: 0027 creates an
 * `ON COMMIT DROP` temp table it reads later in the same file, so per statement is
 * too fine.
 *
 * Bookkeeping is byte-for-byte Drizzle's — schema `drizzle`, table
 * `__drizzle_migrations(id, hash, created_at)`, "pending" = journal `when` newer than
 * the last recorded `created_at`, one row per applied file with the sha256 of its
 * SQL — so `drizzle-kit migrate` and this runner can be used interchangeably and
 * each sees the other's work.
 */
const SCHEMA = "drizzle";
const TABLE = "__drizzle_migrations";

export async function migratePerFile(db: NodePgDatabase<Record<string, unknown>>, migrationsFolder: string): Promise<{ applied: string[] }> {
  const migrations = readMigrationFiles({ migrationsFolder });

  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(SCHEMA)}`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  const last = await db.execute<{ created_at: string | number | null }>(
    sql`select created_at from ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} order by created_at desc limit 1`,
  );
  const lastCreatedAt = last.rows[0]?.created_at == null ? -1 : Number(last.rows[0].created_at);

  const applied: string[] = [];
  for (const m of migrations) {
    if (m.folderMillis <= lastCreatedAt) continue;
    await db.transaction(async (tx) => {
      for (const stmt of m.sql) {
        if (stmt.trim()) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(
        sql`insert into ${sql.identifier(SCHEMA)}.${sql.identifier(TABLE)} ("hash", "created_at") values (${m.hash}, ${m.folderMillis})`,
      );
    });
    applied.push(String(m.folderMillis));
  }
  return { applied };
}
