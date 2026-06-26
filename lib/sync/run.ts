import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";

/**
 * Wrap a sync job so every run is recorded in `sync_runs` (visible on /spend).
 * Records start, then success+stats or error. Re-throws so callers/cron see failure.
 */
export async function withSyncRun<T extends Record<string, unknown>>(
  job: string,
  fn: () => Promise<T>,
): Promise<T> {
  const [run] = await db.insert(syncRuns).values({ job, status: "running" }).returning({ id: syncRuns.id });
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
