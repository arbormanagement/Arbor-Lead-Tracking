import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";

/** A `running` row older than this is a zombie — the process died mid-run. */
const STALE_RUN_HOURS = 6;

/** Returned instead of the job's stats when another run of the same job is in flight. */
export interface SyncSkipped {
  skipped: true;
  reason: string;
}

export function isSyncSkipped(r: unknown): r is SyncSkipped {
  return typeof r === "object" && r !== null && (r as SyncSkipped).skipped === true;
}

/**
 * Wrap a sync job so every run is recorded in `sync_runs` (visible on /spend).
 * Records start, then success+stats or error. Re-throws so callers/cron see failure.
 *
 * Also the job-level mutex: the `running` row is CLAIMED against a partial unique
 * index (one per job), so a second concurrent run of the same job is skipped rather
 * than interleaved. The cron worker's `protect` flag is not sufficient — it only
 * serializes the worker's own fetch, and a tick that times out client-side leaves
 * the web-side handler running while the next tick fires. Overlap is not benign:
 * attribution's reset/re-derive passes corrupt each other's lead statuses, and
 * transcribe pays Deepgram twice for the same recordings.
 */
export async function withSyncRun<T extends Record<string, unknown>>(
  job: string,
  fn: () => Promise<T>,
): Promise<T | SyncSkipped> {
  // Reap zombies first: a crash/redeploy mid-run leaves a `running` row that
  // would otherwise look in-flight forever.
  await db
    .update(syncRuns)
    .set({ status: "error", finishedAt: new Date(), error: "stale — process died mid-run" })
    .where(
      and(
        eq(syncRuns.job, job),
        eq(syncRuns.status, "running"),
        lt(syncRuns.startedAt, new Date(Date.now() - STALE_RUN_HOURS * 3_600_000)),
      ),
    );

  // Claim the job. ON CONFLICT DO NOTHING against `sync_runs_one_running_uq`
  // returns no row when another run already holds it — a clean skip, no error
  // code to interpret. Zombie reaping above means a dead process can't hold the
  // claim past STALE_RUN_HOURS.
  const [run] = await db
    .insert(syncRuns)
    .values({ job, status: "running" })
    .onConflictDoNothing()
    .returning({ id: syncRuns.id });
  if (!run) {
    console.warn(`[sync] ${job} already in flight — skipping this run`);
    return { skipped: true, reason: `another '${job}' run is already in flight` };
  }

  try {
    const stats = await fn();
    await db
      .update(syncRuns)
      .set({ status: "success", finishedAt: new Date(), stats })
      .where(eq(syncRuns.id, run.id));
    return stats;
  } catch (err) {
    await db
      .update(syncRuns)
      .set({
        status: "error",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Start time of the most recent SUCCESSFUL run of `job`, or null if it's never
 * succeeded. Used as the incremental watermark. Reads `started_at` (not finished)
 * so anything changed during the last run is re-pulled next time. The current run's
 * own `running` row is excluded since we filter on status = 'success'.
 */
export async function lastSuccessfulRunStart(job: string): Promise<Date | null> {
  const [row] = await db
    .select({ startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.job, job), eq(syncRuns.status, "success")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/**
 * Fractional-day lookback for an incremental pull: from the last successful run's
 * start, minus an overlap (covers records changed mid-run + clock skew), capped at
 * `maxDays`. First run (no prior success) → full `maxDays` backfill. Providers key
 * the window on `updated_at`, so a status change (e.g. an estimate approval) bumps
 * the record's timestamp and it lands inside the window even if created long ago.
 */
export async function incrementalWindowDays(
  job: string,
  { overlapHours = 2, maxDays = 30 }: { overlapHours?: number; maxDays?: number } = {},
): Promise<number> {
  const last = await lastSuccessfulRunStart(job);
  if (!last) return maxDays;
  const ms = Date.now() - last.getTime() + overlapHours * 3_600_000;
  return Math.min(maxDays, Math.max(overlapHours / 24, ms / 86_400_000));
}
