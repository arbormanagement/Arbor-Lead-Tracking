/**
 * Logical backup: a compressed pg_dump of the whole database.
 *
 * This complements Railway's built-in volume backups rather than replacing them.
 * A volume snapshot restores the entire Postgres service to a moment in time; a
 * logical dump is portable — you can restore it into any Postgres, on any host,
 * inspect it, or pull a single table out of it. If the Railway project itself is
 * ever the problem, the volume snapshot is inside the thing that broke.
 *
 * Dumps the FULL database, not just `public`. Drizzle's migration journal lives in
 * a separate `drizzle` schema, and a dump without it restores your data but leaves
 * the next deploy trying to re-apply migration 0000 onto populated tables.
 *
 * Usage:
 *   npm run db:backup                       # → $BACKUP_DIR
 *   BACKUP_RETAIN=30 npm run db:backup      # keep the newest 30
 *
 * Restore (see DEPLOY.md):
 *   pg_restore --no-owner --no-acl --exit-on-error -d "$DATABASE_URL" arbor-<ts>.dump
 *
 * Env:
 *   DATABASE_URL / DATABASE_URL_UNPOOLED   source database (unpooled preferred)
 *   BACKUP_DIR                             output directory (default ./backups)
 *   BACKUP_RETAIN                          how many dumps to keep (default 14)
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const dir = process.env.BACKUP_DIR ?? "backups";
const retain = Number(process.env.BACKUP_RETAIN ?? 14);

const PREFIX = "arbor-";
const SUFFIX = ".dump";

function log(message: string) {
  console.log(`[db-backup] ${message}`);
}

async function requirePgDump() {
  try {
    const { stdout } = await execFileAsync("pg_dump", ["--version"]);
    return stdout.trim();
  } catch {
    throw new Error(
      "pg_dump not found on PATH. The Railway image needs the Postgres client — " +
        "see nixpacks.toml, and verify in a Railway shell with `pg_dump --version`.",
    );
  }
}

/** Keep the newest `retain` dumps; delete the rest. */
async function prune() {
  if (!Number.isFinite(retain) || retain <= 0) {
    log("retention disabled (BACKUP_RETAIN <= 0) — keeping everything");
    return;
  }
  const names = (await readdir(dir)).filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX));
  // Filenames are UTC timestamps, so lexicographic order is chronological.
  const stale = names.sort().reverse().slice(retain);
  for (const name of stale) {
    await unlink(path.join(dir, name));
    log(`pruned ${name}`);
  }
}

async function main() {
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  const version = await requirePgDump();

  await mkdir(dir, { recursive: true });
  // Colons are illegal in filenames on some targets; keep it filesystem-safe.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(dir, `${PREFIX}${stamp}${SUFFIX}`);

  log(`${version} → ${outFile}`);
  await execFileAsync(
    "pg_dump",
    [
      "--no-owner",
      "--no-acl",
      // Custom format: compressed, and pg_restore can filter/parallelize it.
      "--format=custom",
      "--compress=9",
      "--file",
      outFile,
      url,
    ],
    // Dumps are small today but this must not silently truncate as data grows.
    { maxBuffer: 64 * 1024 * 1024 },
  );

  const { size } = await stat(outFile);
  if (size === 0) throw new Error(`pg_dump produced an empty file: ${outFile}`);
  log(`✓ ${(size / 1024 / 1024).toFixed(2)} MB`);

  await prune();
  log("done");
}

main().catch((e) => {
  console.error("[db-backup] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
