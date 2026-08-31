/**
 * Every scheduled job name resolves to a real handler.
 *
 *   npm run verify:cron-jobs
 *
 * Needs no database and no network — it reads the two files and compares them.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The job vocabulary lives in THREE places and nothing tied them together:
 *
 *   scripts/cron.ts               the schedule — which names fire, and how often
 *   app/api/cron/[job]/route.ts   the scheduled door, its own switch
 *   lib/sync/run-job.ts           the manual door (admin button + MCP trigger_sync)
 *
 * On 2026-08-31 `hcp-lineitems` was added to the schedule and to the manual door
 * but NOT to the scheduled door. Every ten-minute tick hit the route, fell through
 * to `default`, and 400'd — and a 30k-record backfill sat still for half an hour
 * while every other job ticked normally.
 *
 * ⚠️ **The failure was invisible, which is the real reason for this file.** The cron
 * worker logs the error where nobody reads it. /api/diagnostics reports on jobs that
 * have RUN, so a job that has never run at all does not appear as failing — it
 * simply is not there, which looks identical to a job that is idle because there is
 * nothing to do. Nothing anywhere says "this scheduled name matches no handler".
 *
 * A mismatch is a one-word typo away at all times and `tsc` cannot see it: one side
 * is a string in an array, the other a string in a switch. So it is checked here,
 * cheaply, and the check is fast enough to run before any deploy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const ok = (c: boolean, m: string) => {
  if (!c) failures++;
  console.log(`${c ? "✓" : "✗ FAIL"}  ${m}`);
};

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** Names in the cron schedule: `{ job: "name", schedule: … }`. */
function scheduledJobs(): string[] {
  const src = read("scripts", "cron.ts");
  const block = src.slice(src.indexOf("const JOBS"), src.indexOf("const only"));
  return [...block.matchAll(/\{\s*job:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/** Names the scheduled door actually handles: `case "name":` in its switch. */
function routeCases(file: string): string[] {
  const src = read(...file.split("/"));
  return [...src.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]!);
}

const scheduled = scheduledJobs();
const cronRoute = routeCases("app/api/cron/[job]/route.ts");
const manual = routeCases("lib/sync/run-job.ts");

// Guard the parsers themselves. A regex that silently matched nothing would make
// every assertion below pass vacuously — which is a worse failure than the one this
// script exists to catch, because it would look like proof.
ok(scheduled.length >= 10, `parsed the schedule (${scheduled.length} jobs)`);
ok(cronRoute.length >= 10, `parsed the cron route (${cronRoute.length} cases)`);
ok(manual.length >= 10, `parsed the manual dispatch (${manual.length} cases)`);

for (const job of scheduled) {
  ok(cronRoute.includes(job), `scheduled job "${job}" has a case in app/api/cron/[job]/route.ts`);
}

// The reverse is NOT an error: `revenue` is a convenience aggregate the route offers
// for a hand-triggered run, and `all` likewise on the manual side. Neither is on a
// schedule and neither should be.
const unscheduled = cronRoute.filter((j) => !scheduled.includes(j));
console.log(`   (route also serves, unscheduled by design: ${unscheduled.join(", ") || "none"})`);

// The manual door — the admin button and the MCP `trigger_sync` tool — is a
// SEPARATE severity and is reported rather than failed.
//
// A job missing from the cron route is an outage: it never runs. A job missing from
// here still runs on schedule; it just cannot be run on demand, which costs
// convenience exactly when someone needs it. `dni-canary` is the sharp case — it
// exists to catch the number swap breaking on a website deploy, and right after a
// deploy is precisely when you want it now rather than within the hour.
//
// Mixing the two would make this script ship red for a known, deliberate gap, and a
// check that is always red is a check nobody reads.
const handGap = scheduled.filter((j) => !manual.includes(j));
console.log(
  handGap.length
    ? `\nNOTE — scheduled but NOT hand-triggerable (runs on time, cannot be run on demand): ${handGap.join(", ")}.` +
      `\n       Add to SYNC_JOBS + lib/sync/run-job.ts to make them runnable from the admin button and MCP.`
    : "\nEvery scheduled job can also be triggered by hand.",
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
