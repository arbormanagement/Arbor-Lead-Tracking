/**
 * Copy an entire database to another host — the Neon → Railway move, as one
 * auditable command that verifies itself.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… npm run db:transfer
 *   …                                            npm run db:transfer -- --clean
 *
 * Why a script rather than two pg_dump/pg_restore lines: the obvious hand-rolled
 * version has a silent failure mode. Dumping only the `public` schema leaves
 * Drizzle's migration journal (which lives in a separate `drizzle` schema) behind,
 * so every row arrives, nothing looks wrong, and the NEXT deploy re-applies
 * migration 0000 onto populated tables and dies. This always dumps the whole
 * database, restores with --exit-on-error (without it pg_restore reports success
 * having skipped failed statements), and then compares every table's row count on
 * both sides before declaring victory.
 *
 * Flags:
 *   --clean   Drop and recreate the target's `public` + `drizzle` schemas first.
 *             Needed when the target already ran `db:deploy` (a Railway deploy
 *             seeds it), since those seed rows collide with the incoming ones.
 *             DESTRUCTIVE to the target — the target only.
 *   --keep    Don't delete the intermediate dump file.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";

const execFileAsync = promisify(execFile);

const source = process.env.SOURCE_DATABASE_URL;
const target = process.env.TARGET_DATABASE_URL;
const clean = process.argv.includes("--clean");
const keep = process.argv.includes("--keep");

function log(msg: string) {
  console.log(`[db-transfer] ${msg}`);
}

/** host/dbname only — never print credentials. */
function describe(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Every public table with its exact row count, for a before/after comparison. */
async function rowCounts(url: string): Promise<Map<string, number>> {
  return withClient(url, async (c) => {
    const { rows: tables } = await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    const counts = new Map<string, number>();
    for (const { table_name } of tables) {
      // Exact count, not the reltuples estimate — this is the correctness check.
      const { rows } = await c.query<{ n: string }>(`select count(*)::text as n from public."${table_name}"`);
      counts.set(table_name, Number(rows[0].n));
    }
    return counts;
  });
}

async function migrationJournalCount(url: string): Promise<number | null> {
  return withClient(url, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `select count(*)::text as n from drizzle.__drizzle_migrations`,
    ).catch(() => ({ rows: [] as Array<{ n: string }> }));
    return rows.length ? Number(rows[0].n) : null;
  });
}

async function main() {
  if (!source || !target) {
    throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL must both be set");
  }
  if (source === target) {
    throw new Error("SOURCE_DATABASE_URL and TARGET_DATABASE_URL are identical — refusing");
  }

  log(`source: ${describe(source)}`);
  log(`target: ${describe(target)}${clean ? "  (--clean: will be wiped first)" : ""}`);

  // Fail before touching anything if the target isn't ready to receive.
  const targetTables = await rowCounts(target);
  if (targetTables.size > 0 && !clean) {
    const populated = [...targetTables].filter(([, n]) => n > 0);
    throw new Error(
      `target already has ${targetTables.size} table(s)` +
        (populated.length ? ` (${populated.length} with rows)` : "") +
        ". A Railway deploy runs db:deploy, which creates and seeds them. " +
        "Re-run with --clean to drop and recreate the target's schemas first.",
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), "arbor-transfer-"));
  const dumpFile = path.join(dir, "source.dump");

  try {
    log("dumping source (full database, all schemas)…");
    await execFileAsync("pg_dump", [
      "--no-owner",
      "--no-acl",
      "--format=custom",
      "--compress=9",
      "--file",
      dumpFile,
      source,
    ]);
    const { size } = await stat(dumpFile);
    if (size === 0) throw new Error("pg_dump produced an empty file");
    log(`dump: ${(size / 1024 / 1024).toFixed(2)} MB`);

    if (clean) {
      log("wiping target schemas…");
      await withClient(target, async (c) => {
        await c.query("drop schema if exists drizzle cascade");
        await c.query("drop schema if exists public cascade");
        await c.query("create schema public");
      });
    }

    log("restoring into target…");
    await execFileAsync(
      "pg_restore",
      ["--no-owner", "--no-acl", "--exit-on-error", "--dbname", target, dumpFile],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    log("verifying parity…");
    const [before, after] = [await rowCounts(source), await rowCounts(target)];
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const mismatches: string[] = [];
    for (const name of names) {
      const a = before.get(name);
      const b = after.get(name);
      if (a !== b) mismatches.push(`  ${name}: source=${a ?? "missing"} target=${b ?? "missing"}`);
      else if ((a ?? 0) > 0) console.log(`  ${name.padEnd(26)} ${a}`);
    }

    const [srcJournal, dstJournal] = [await migrationJournalCount(source), await migrationJournalCount(target)];
    if (dstJournal === null) {
      mismatches.push("  drizzle.__drizzle_migrations: MISSING on target — the next deploy will fail");
    } else if (srcJournal !== dstJournal) {
      mismatches.push(`  drizzle.__drizzle_migrations: source=${srcJournal} target=${dstJournal}`);
    } else {
      console.log(`  ${"drizzle migrations".padEnd(26)} ${dstJournal}`);
    }

    if (mismatches.length) {
      throw new Error(`parity check FAILED:\n${mismatches.join("\n")}`);
    }
    log(`✓ ${names.length} tables match, migration journal intact`);
    log("now point DATABASE_URL at the target and DELETE DATABASE_URL_UNPOOLED");
  } finally {
    if (keep) log(`dump kept at ${dumpFile}`);
    else await rm(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`[db-transfer] FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
