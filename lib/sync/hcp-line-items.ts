import { isNull, or, sql, type SQLWrapper } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, hcpJobs } from "@/lib/db/schema";
import { housecallpro } from "@/lib/integrations/housecallpro";
import type { HcpLineItem, RevenueProvider } from "@/lib/integrations/types";
import { withSyncRun } from "./run";

/**
 * Hydrate `line_items` on estimates and jobs.
 *
 * ── Why this is its own job ──────────────────────────────────────────────────
 * HCP exposes line items ONLY under their parent record — no collection endpoint,
 * no window, no filter (verified against the OpenAPI spec and the live API). So
 * filling them is one request per JOB and one per estimate OPTION: roughly 10.9k +
 * 19.7k ≈ 30.6k requests for the account's history. The hourly `hcp` sync has a
 * 600s budget and a hot zone to keep fresh; 30k requests cannot ride inside it, and
 * a hydration pass that ran long would delay the thing the ROI numbers depend on.
 * Same reasoning as the cold-zone crawls, one step further out.
 *
 * ── Why it is worth doing ────────────────────────────────────────────────────
 * Three things live only here and are invisible to this app without it:
 *  · DISCOUNTS. A discount is a LINE (`kind: 'fixed discount' | 'percent discount'`),
 *    not a field on the job or estimate. Nothing above the line items can see that a
 *    $500 "Combo" came off a $819k quote — the parent's total is already net of it.
 *  · QUOTED HOURS. The tree-work price-book items are priced per hour
 *    (`unit_of_measure: 'Hour(s)'`, `unit_price` $700, `quantity` the estimator's
 *    hours), so quoted-vs-actual is answerable — against the on-my-way → completed
 *    clock the jobs table already carries.
 *  · WHAT THE WORK WAS. `name` is the price-book service ("Tree Removal",
 *    "Removal - Stump Grinding"), which is the only per-record answer to which
 *    services a job or estimate actually covered.
 *
 * ── The queue ────────────────────────────────────────────────────────────────
 * Driven off `line_items_synced_at`, NOT off `line_items IS NULL`. Empty is a real
 * and common answer — an estimate is written before it is priced — so a null-column
 * queue would re-fetch the same empty records forever and never reach the rest.
 *
 * Newest-first, deliberately: the cold start is ~30k requests over a few hours, and
 * ordering by recency means the rows anyone is actually looking at fill in first
 * rather than last. Steady state the queue is nearly empty — only rows whose
 * `updated_at_hcp` has moved past their stamp come back.
 */

/**
 * Parents hydrated per run, per collection.
 *
 * An estimate costs one request per option (1.27 on average), a job exactly one, so
 * a run is roughly 2.3 x this many requests. At 600 x 2.3 ≈ 1,380 requests every ten
 * minutes the ~30.6k cold start clears in about four hours, and nothing else in the
 * schedule is competing for HCP at the time.
 */
const BATCH = 600;

/**
 * Concurrent requests against HCP.
 *
 * Deliberately modest. HCP publishes no rate limit and `fetchWithRetry` already
 * honours a 429's `Retry-After`, but the failure mode of guessing high is throttling
 * the hourly sync — which shares this API key and matters more than hydration speed.
 * Six is fast enough that the wall-clock budget below, not the concurrency, is what
 * bounds a run.
 */
const CONCURRENCY = 6;

/**
 * Wall-clock ceiling for one run, under the cron job's own 300s timeout.
 *
 * The budget is the real bound, not BATCH: a slow HCP should shorten the batch, not
 * overrun the timeout and leave the run recorded as failed with its work discarded.
 * Writes are flushed as they complete, so a run cut short by the budget keeps
 * everything it managed.
 */
const BUDGET_MS = 240_000;

/** Rows written per multi-row update — bounded so the jsonb payload stays under the
 *  HTTP driver's request limit, the same reason `CHUNK` exists in the main sync. */
const WRITE_CHUNK = 100;

interface Hydrated {
  id: string;
  items: HcpLineItem[];
}

/**
 * Run `work` over `rows` with bounded concurrency, stopping cleanly when the budget
 * is spent.
 *
 * A failure on one record must not abandon the run: HCP 404s a record deleted
 * between the sync and this pass, and one such row would otherwise cost the other
 * 599. Failures are counted and the record is left unstamped, so it comes back next
 * run rather than being silently marked done.
 */
async function hydrate<T extends { id: string }>(
  rows: T[],
  deadline: number,
  work: (row: T) => Promise<HcpLineItem[]>,
): Promise<{ done: Hydrated[]; failed: number; ranOutOfTime: boolean }> {
  const done: Hydrated[] = [];
  let failed = 0;
  let next = 0;
  let ranOutOfTime = false;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      for (;;) {
        if (Date.now() > deadline) {
          ranOutOfTime = true;
          return;
        }
        const i = next++;
        const row = rows[i];
        if (!row) return;
        try {
          done.push({ id: row.id, items: await work(row) });
        } catch (err) {
          failed++;
          console.error(`[hcp-lineitems] ${row.id} failed`, err);
        }
      }
    }),
  );

  return { done, failed, ranOutOfTime };
}

/**
 * Write the fetched items back, stamping `line_items_synced_at` in the same
 * statement.
 *
 * One multi-row UPDATE ... FROM (VALUES …) per chunk rather than a statement per
 * row: at cold-start volume a per-row update is thousands of sequential round-trips
 * over the HTTP driver, which is what times these functions out.
 *
 * The stamp is set to `now()` server-side, never to a value computed here — a clock
 * read in the app that ran before the fetch would let a concurrent HCP edit land
 * inside the window and never be re-read.
 */
async function writeItems(table: "hcp_estimates" | "hcp_jobs", rows: Hydrated[]): Promise<void> {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const values = sql.join(
      chunk.map((r) => sql`(${r.id}, ${JSON.stringify(r.items)}::jsonb)`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE ${sql.raw(table)} AS t
      SET line_items = v.items, line_items_synced_at = now()
      FROM (VALUES ${values}) AS v(id, items)
      WHERE t.id = v.id
    `);
  }
}

/**
 * Estimates whose options need reading, newest-touched first.
 *
 * `options` is already modelled on the row, so the option ids this needs cost no
 * extra request — the estimate sync stored them. An estimate with NO options is
 * stamped without any HCP call at all (there is nothing to ask for), which matters:
 * unpriced estimates are a large share of the book and paying a round trip each to
 * learn they have no line items would double the cold start for no data.
 */
const needsHydration = (stamp: SQLWrapper, updated: SQLWrapper) =>
  or(isNull(stamp), sql`${updated} is not null and ${stamp} < ${updated}`)!;

/** Just the two methods this job calls, so `verify:line-items` can substitute a stub
 *  without standing up a whole provider — and so it is obvious from the signature
 *  that hydration touches nothing else in the HCP client. */
type LineItemSource = Pick<RevenueProvider, "jobLineItems" | "estimateLineItems">;

export async function syncHcpLineItems({
  limit = BATCH,
  provider = housecallpro,
}: { limit?: number; provider?: LineItemSource } = {}) {
  return withSyncRun("hcp.lineitems", async () => {
    const deadline = Date.now() + BUDGET_MS;
    const stats = {
      estimates: 0,
      estimateOptions: 0,
      estimatesEmpty: 0,
      jobs: 0,
      failed: 0,
      budgetSpent: false,
      remainingEstimates: 0,
      remainingJobs: 0,
    };

    // ── Estimates ─────────────────────────────────────────────────────────────
    const estimateRows = await db
      .select({ id: hcpEstimates.id, hcpId: hcpEstimates.hcpEstimateId, options: hcpEstimates.options })
      .from(hcpEstimates)
      .where(needsHydration(hcpEstimates.lineItemsSyncedAt, hcpEstimates.updatedAtHcp))
      // Newest first. `updated_at_hcp` is nullable on old rows, so fall back to
      // creation — without the coalesce those rows sort as null and, depending on
      // the direction, either monopolise the queue or never reach it.
      .orderBy(sql`coalesce(${hcpEstimates.updatedAtHcp}, ${hcpEstimates.createdAtHcp}) desc nulls last`)
      .limit(limit);

    // Options come off the stored row. An estimate with none needs no request.
    const withOptions: Array<{ id: string; hcpId: string; optionIds: string[] }> = [];
    const noOptions: Hydrated[] = [];
    for (const e of estimateRows) {
      const optionIds = (Array.isArray(e.options) ? (e.options as Array<Record<string, unknown>>) : [])
        .map((o) => (typeof o.id === "string" ? o.id : null))
        .filter((id): id is string => id !== null);
      if (optionIds.length === 0) noOptions.push({ id: e.id, items: [] });
      else withOptions.push({ id: e.id, hcpId: e.hcpId, optionIds });
    }
    stats.estimatesEmpty = noOptions.length;
    stats.estimateOptions = withOptions.reduce((n, e) => n + e.optionIds.length, 0);

    const est = await hydrate(withOptions, deadline, (e) => provider.estimateLineItems(e.hcpId, e.optionIds));
    await writeItems("hcp_estimates", [...noOptions, ...est.done]);
    stats.estimates = noOptions.length + est.done.length;
    stats.failed += est.failed;
    stats.budgetSpent ||= est.ranOutOfTime;

    // ── Jobs ──────────────────────────────────────────────────────────────────
    // Runs even when the estimate pass spent the budget, but `hydrate` returns
    // immediately in that case, so this costs one query rather than being skipped
    // by a branch that would then need its own "did we skip" stat.
    const jobRows = await db
      .select({ id: hcpJobs.id, hcpId: hcpJobs.hcpJobId })
      .from(hcpJobs)
      .where(needsHydration(hcpJobs.lineItemsSyncedAt, hcpJobs.updatedAtHcp))
      .orderBy(sql`coalesce(${hcpJobs.updatedAtHcp}, ${hcpJobs.createdAtHcp}) desc nulls last`)
      .limit(limit);

    const job = await hydrate(jobRows, deadline, (j) => provider.jobLineItems(j.hcpId));
    await writeItems("hcp_jobs", job.done);
    stats.jobs = job.done.length;
    stats.failed += job.failed;
    stats.budgetSpent ||= job.ranOutOfTime;

    // How much history is left, so the cold start is watchable from /api/diagnostics
    // rather than inferred from the batch sizes.
    stats.remainingEstimates = await countRemaining("hcp_estimates");
    stats.remainingJobs = await countRemaining("hcp_jobs");

    return stats;
  });
}

async function countRemaining(table: "hcp_estimates" | "hcp_jobs"): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM ${sql.raw(table)}
    WHERE line_items_synced_at IS NULL
       OR (updated_at_hcp IS NOT NULL AND line_items_synced_at < updated_at_hcp)
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/** Exported so a diagnostics surface can name the same predicate rather than
 *  re-spelling it and drifting from what the queue actually selects. */
export { needsHydration as lineItemsNeedHydration };
