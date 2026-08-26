import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpEstimates, hcpInvoices, hcpJobs } from "@/lib/db/schema";
import { revenueProvider } from "@/lib/integrations";
import type { HcpCrawlPage } from "@/lib/integrations/types";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { linkContactsToHcpCustomers } from "@/lib/contacts/link-hcp";
import { getSetting, setSetting } from "@/lib/settings";
import { incrementalWindowDays, withSyncRun } from "./run";

// Fixed window for jobs (whose server-side scheduled_start filter must stay broad).
const MAX_LOOKBACK_DAYS = 30;
// Cap / initial-backfill window for the history-walking endpoints. 365: the cap
// bounds outage recovery — a longer-than-cap gap would silently lose changes.
// Deep windows stay cheap because the providers early-stop on updated_at.
const MAX_WINDOW_DAYS = 365;

/**
 * hcp.sync.jobs — pull HousecallPro customers, jobs, estimates and invoices and
 * upsert them. Customers carry normalized phone/email (phone_e164 / email_lc) so the
 * attribution engine can match leads → customers → revenue. HCP amounts are already
 * in cents.
 *
 * **ROI revenue is the WON ESTIMATE and nothing else.** Jobs say what was done,
 * invoices say what was billed and collected; neither feeds `roi_daily`. That is a
 * deliberate boundary, not an omission — see the note on `hcpInvoices` in the schema
 * and docs/estimate-anchored-model.md before wiring either into a money surface.
 *
 * Every collection is synced in TWO passes, because HCP offers no server-side
 * `updated_at` filter on any of them:
 *   • a HOT pass — recent/recently-touched rows, read every run;
 *   • a COLD crawl — a cursor walking the whole collection a couple of pages a run,
 *     wrapping forever, so aged rows that change are still picked up.
 * The crawls are what make this complete rather than merely recent: before they
 * existed, jobs were bounded to a 180-day schedule window and customers to whatever
 * the incremental window reached, so most of the ~10.8k jobs and ~10.7k customers in
 * the account were simply absent.
 *
 * Writes are BATCHED (chunked multi-row upserts) — at real account volume a
 * per-record upsert over the HTTP driver is thousands of sequential round-trips and
 * times the function out. Id resolution for jobs/estimates/invoices uses in-memory
 * maps instead of a query per row.
 */
const CHUNK = 100; // rows per multi-row upsert — bounded so the raw jsonb payload stays under the HTTP-driver request limit

/**
 * Steady-state pages of each cold-zone crawl per run. Each page is ~7s against HCP,
 * and the four crawls run CONCURRENTLY, so the cost is one crawl's wall time, not
 * four.
 *
 * At 2 pages/run hourly: estimates (78 pages) verify every ~1.6 days; jobs (55),
 * customers (54) and invoices (53) every ~1.1 days. All are comfortably faster than
 * the measured background change rate of 1–3% per 30 days on aged records.
 */
const CRAWL_PAGES_PER_RUN = 2;

/**
 * Cold-start pacing: how long a crawl that has NEVER completed a pass may keep
 * reading in one run, and the page ceiling that bounds it regardless.
 *
 * A single constant was the wrong shape. 2 pages/run is right for keeping a known
 * history fresh and badly wrong for filling an empty one: the 2026-08-25 deploy left
 * jobs at 1,030 of 10,843 rows and invoices at 0, and the table would not have been
 * complete for a day. Twelve manual triggers cleared it in thirteen minutes, which
 * is the tell — the work was never expensive, the schedule was just pacing it for a
 * problem it did not have.
 *
 * So while `passes === 0` the crawl reads until it wraps or the budget runs out,
 * which finishes a cold start in one or two runs instead of ~28. Once a pass has
 * landed it drops back to CRAWL_PAGES_PER_RUN and stays cheap forever after.
 */
const CRAWL_COLD_START_BUDGET_MS = 300_000;
const CRAWL_COLD_START_MAX_PAGES = 120;

/** `settings` keys holding the crawl cursors. Persisted so the walks survive deploys. */
const CRAWL_KEYS = {
  estimates: "hcp.estimates.crawl",
  customers: "hcp.customers.crawl",
  jobs: "hcp.jobs.crawl",
  invoices: "hcp.invoices.crawl",
} as const;

type CrawlName = keyof typeof CRAWL_KEYS;

export interface CrawlState {
  /** Page to read next, 1-based. */
  nextPage: number;
  /** Completed full passes — a monotonic counter, useful for spotting a stuck cursor. */
  passes: number;
  /** ISO timestamp of the last completed pass; null until the first one finishes. */
  lastCompletedPassAt: string | null;
  /**
   * When the last lap that provably ran page 1 → wrap began. The cutoff that makes
   * deletions detectable: every row HCP still lists was stamped at some point after
   * this instant, so a row whose `crawl_seen_at` predates it is one HCP no longer
   * returns.
   *
   * ⚠️ "Provably" is load-bearing, and getting it wrong is not a subtle failure.
   * A lap the cursor JOINED midway is not a full lap: the pages before the join
   * were never stamped, so treating its wrap as a cutoff condemns every row in them.
   * Shipped without this guard on 2026-08-26 and the estimate crawl — mid-lap at
   * page 73 when the deploy landed — wrapped six pages later and reported 14,000 of
   * 15,464 estimates as missing from HousecallPro, against a drift of 0. A diagnostic
   * that confidently reports a whole table as deleted is worse than no diagnostic.
   *
   * Deliberately a NEW field name rather than a reinterpretation of the old one:
   * crawl state persists in `settings`, so a stored value written under the broken
   * rule must not be readable as a valid cutoff. Absent → no cutoff → no claims.
   */
  lastFullLapStartedAt: string | null;
  /**
   * When the in-flight lap began — set ONLY when that lap started at page 1, so a
   * cursor that joined mid-lap carries null and cannot publish a cutoff on wrap.
   */
  currentLapStartedAt: string | null;
  /** Provider's own total row count, from the last response seen. */
  totalItems: number | null;
}

export const CRAWL_INITIAL: CrawlState = {
  nextPage: 1,
  passes: 0,
  lastCompletedPassAt: null,
  lastFullLapStartedAt: null,
  currentLapStartedAt: null,
  totalItems: null,
};

/** Cold start = has never completed a lap, so it should read as much as it can. */
export function crawlWindowFor(state: CrawlState): { startPage: number; pages: number; budgetMs?: number } {
  return state.passes === 0
    ? { startPage: state.nextPage, pages: CRAWL_COLD_START_MAX_PAGES, budgetMs: CRAWL_COLD_START_BUDGET_MS }
    : { startPage: state.nextPage, pages: CRAWL_PAGES_PER_RUN };
}

/**
 * Advance a cursor after its rows are safely upserted. A crash between the two
 * would skip those pages until the next full pass came round, so the caller must
 * not persist this until the write has happened.
 */
export function advanceCrawl(before: CrawlState, page: HcpCrawlPage<unknown> | null, runStartedAt: Date): CrawlState {
  if (!page) return before;
  // A lap counts for deletion detection only if this cursor started it at page 1.
  // Joining an already-running lap leaves this null, and a null cannot become a
  // cutoff on wrap — see the note on `lastFullLapStartedAt`.
  const lapStartedAt =
    before.currentLapStartedAt ?? (before.nextPage <= 1 ? runStartedAt.toISOString() : null);
  if (!page.wrapped) {
    return {
      nextPage: page.nextPage,
      passes: before.passes,
      lastCompletedPassAt: before.lastCompletedPassAt,
      lastFullLapStartedAt: before.lastFullLapStartedAt,
      currentLapStartedAt: lapStartedAt,
      totalItems: page.totalItems ?? before.totalItems,
    };
  }
  return {
    nextPage: page.nextPage,
    passes: before.passes + 1,
    lastCompletedPassAt: new Date().toISOString(),
    // A partial lap still counts as a pass (it proves the cursor is moving) but
    // must not move the cutoff.
    lastFullLapStartedAt: lapStartedAt ?? before.lastFullLapStartedAt,
    currentLapStartedAt: null,
    totalItems: page.totalItems ?? before.totalItems,
  };
}

/** What a crawl did this run, for `sync_runs.stats` and /api/diagnostics. */
function crawlStats(before: CrawlState, after: CrawlState, page: HcpCrawlPage<unknown> | null) {
  return {
    ok: page != null,
    fromPage: before.nextPage,
    toPage: after.nextPage,
    rows: page?.rows.length ?? 0,
    passes: after.passes,
    lastCompletedPassAt: after.lastCompletedPassAt,
    lastFullLapStartedAt: after.lastFullLapStartedAt,
    coldStart: before.passes === 0,
    totalItems: after.totalItems,
  };
}

/**
 * Stamp `crawl_seen_at` on every row this crawl slice actually read.
 *
 * A narrow UPDATE keyed on HCP's own id, deliberately separate from the row upsert:
 * the upsert's skip-if-unchanged guard means an unchanged row is never written, so
 * folding the stamp into it would leave exactly the rows that did not move unstamped
 * — and those are the ones this check is about. Chunked because a cold-start slice
 * can carry twelve thousand ids.
 */
export async function markCrawlSeen(table: string, idColumn: string, hcpIds: string[]): Promise<void> {
  const STAMP_CHUNK = 1_000;
  for (let i = 0; i < hcpIds.length; i += STAMP_CHUNK) {
    const batch = hcpIds.slice(i, i + STAMP_CHUNK);
    // `IN (...)` with each id as its own bind, NOT `= ANY(${batch})`: drizzle's sql
    // template flattens a JS array into separate parameters, so ANY() receives a
    // parameter list rather than an array and Postgres rejects it ("op ANY/ALL
    // (array) requires array on right side"). Caught by verify:hcp, invisible to tsc.
    await db.execute(sql`
      UPDATE ${sql.raw(table)} SET crawl_seen_at = now()
      WHERE ${sql.raw(idColumn)} IN (${sql.join(batch.map((id) => sql`${id}`), sql`, `)})
    `);
  }
}

/**
 * A crawl must never cost us the hot zone. Its failure surfaces through
 * `lastCompletedPassAt` going stale on /api/diagnostics — the signal that actually
 * means "coverage is slipping" — whereas a thrown error here would just retry the
 * same page next tick and take the fresh data down with it.
 */
function tolerate<T>(name: CrawlName): (err: unknown) => null {
  return (err: unknown) => {
    console.error(`[hcp] ${name} crawl failed — cursor not advanced`, err);
    return null;
  };
}

async function chunkedUpsert<T>(rows: T[], run: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await run(rows.slice(i, i + CHUNK));
  }
}

/** Keep one row per key — a multi-row ON CONFLICT upsert errors if the same
 *  conflict target appears twice in one statement (HCP pages can overlap). */
function dedupeBy<T>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.values()];
}

/**
 * @param sinceDays  Explicit lookback override (manual full backfill). When omitted,
 *                   customers + estimates use an INCREMENTAL window derived from the
 *                   last successful run (see `incrementalWindowDays`), so a routine
 *                   hourly run reads only what changed instead of a fixed 30 days.
 * @param jobsSinceDays  Fixed window for /jobs, whose server-side scheduled_start
 *                   filter would wrongly drop recently-updated-but-earlier-scheduled
 *                   jobs under a narrow window — so it stays broad regardless.
 */
export async function syncHcp(
  { sinceDays, jobsSinceDays = MAX_LOOKBACK_DAYS }: { sinceDays?: number; jobsSinceDays?: number } = {},
) {
  return withSyncRun("hcp.sync.jobs", async () => {
    const provider = await revenueProvider();
    if (!provider) {
      return { skipped: "HousecallPro credentials not set", customers: 0, jobs: 0, estimates: 0, invoices: 0 };
    }

    // Incremental window for the endpoints that walk history (no server date
    // filter). Explicit `sinceDays` forces a full backfill.
    //
    // This window is keyed on `updated_at` and is therefore the RIGHT tool for
    // customers and the WRONG one for estimates on its own: HCP does not move an
    // estimate's `updated_at` when an option is priced or approved, so a narrow
    // window here would read every estimate once, at creation, and never see the
    // approval. `listEstimates` compensates with a rolling `created_at` re-read and
    // treats this value as a floor — see the comment there before narrowing it.
    const runStartedAt = new Date();
    // `minDays: 1` floors the hot window. Without it, re-triggering this job by hand
    // walks the window toward zero (observed live: 0.122 → 0.084 across successive
    // manual runs), narrowing the read at exactly the moment an operator is trying
    // to force a catch-up.
    const windowDays =
      sinceDays ??
      (await incrementalWindowDays("hcp.sync.jobs", { overlapHours: 2, maxDays: MAX_WINDOW_DAYS, minDays: 1 }));

    // Where each cold-zone crawl left off. Read before the fetch so the crawls can
    // ride along with the hot passes rather than adding a serial leg.
    const [estCrawlBefore, custCrawlBefore, jobCrawlBefore, invCrawlBefore] = await Promise.all([
      getSetting<CrawlState>(CRAWL_KEYS.estimates, CRAWL_INITIAL),
      getSetting<CrawlState>(CRAWL_KEYS.customers, CRAWL_INITIAL),
      getSetting<CrawlState>(CRAWL_KEYS.jobs, CRAWL_INITIAL),
      getSetting<CrawlState>(CRAWL_KEYS.invoices, CRAWL_INITIAL),
    ]);

    // Fetch every independent leg concurrently — read time is the slowest one, not
    // the sum. (Each still paginates 200/page internally.)
    const [
      customersRaw,
      jobsRaw,
      estimatesRaw,
      invoicesRaw,
      crawledEstimates,
      crawledCustomers,
      crawledJobs,
      crawledInvoices,
    ] = await Promise.all([
      provider.listCustomers({ sinceDays: windowDays }),
      provider.listJobs({ sinceDays: jobsSinceDays }),
      provider.listEstimates({ sinceDays: windowDays }),
      provider.listInvoices({ sinceDays: windowDays }),
      provider.crawlEstimates(crawlWindowFor(estCrawlBefore)).catch(tolerate("estimates")),
      provider.crawlCustomers(crawlWindowFor(custCrawlBefore)).catch(tolerate("customers")),
      provider.crawlJobs(crawlWindowFor(jobCrawlBefore)).catch(tolerate("jobs")),
      provider.crawlInvoices(crawlWindowFor(invCrawlBefore)).catch(tolerate("invoices")),
    ]);

    // ── Customers ────────────────────────────────────────────────────────────
    const customers = dedupeBy(
      [...customersRaw, ...(crawledCustomers?.rows ?? [])],
      (c) => c.hcpCustomerId,
    );
    await chunkedUpsert(customers, (batch) =>
      db
        .insert(hcpCustomers)
        .values(
          batch.map((c) => ({
            hcpCustomerId: c.hcpCustomerId,
            firstName: c.firstName,
            lastName: c.lastName,
            email: c.email,
            emailLc: normalizeEmail(c.email),
            phone: c.phone,
            mobile: c.mobile,
            phoneE164: normalizePhone(c.mobile ?? c.phone),
            // Deduped after normalizing, since HCP records often repeat the same
            // number across two fields.
            phonesE164: [...new Set((c.phones ?? [c.mobile, c.phone]).map(normalizePhone).filter(Boolean))] as string[],
            addresses: c.addresses,
            createdAtHcp: c.createdAtHcp,
            updatedAtHcp: c.updatedAtHcp,
            raw: c.raw,
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: hcpCustomers.hcpCustomerId,
          set: {
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            email: sql`excluded.email`,
            emailLc: sql`excluded.email_lc`,
            phone: sql`excluded.phone`,
            mobile: sql`excluded.mobile`,
            phoneE164: sql`excluded.phone_e164`,
            phonesE164: sql`excluded.phones_e164`,
            addresses: sql`excluded.addresses`,
            createdAtHcp: sql`excluded.created_at_hcp`,
            updatedAtHcp: sql`excluded.updated_at_hcp`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          // Skip untouched rows. The crawl re-reads all ~10.7k customers every pass;
          // without this, every pass would rewrite every row — churning `synced_at`
          // until "when did this last CHANGE?" is unanswerable. `raw` is deliberately
          // NOT compared (HCP reshapes it during its own backend work) but is still
          // WRITTEN whenever something else moved.
          setWhere: sql`
            ${hcpCustomers.firstName} IS DISTINCT FROM excluded.first_name
            OR ${hcpCustomers.lastName} IS DISTINCT FROM excluded.last_name
            OR ${hcpCustomers.email} IS DISTINCT FROM excluded.email
            OR ${hcpCustomers.emailLc} IS DISTINCT FROM excluded.email_lc
            OR ${hcpCustomers.phone} IS DISTINCT FROM excluded.phone
            OR ${hcpCustomers.mobile} IS DISTINCT FROM excluded.mobile
            OR ${hcpCustomers.phoneE164} IS DISTINCT FROM excluded.phone_e164
            OR ${hcpCustomers.phonesE164} IS DISTINCT FROM excluded.phones_e164
            OR ${hcpCustomers.addresses} IS DISTINCT FROM excluded.addresses
            OR ${hcpCustomers.createdAtHcp} IS DISTINCT FROM excluded.created_at_hcp
            OR ${hcpCustomers.updatedAtHcp} IS DISTINCT FROM excluded.updated_at_hcp
          `,
        }),
    );

    await markCrawlSeen(
      "hcp_customers",
      "hcp_customer_id",
      (crawledCustomers?.rows ?? []).map((c) => c.hcpCustomerId),
    );

    // Map HCP customer id → our internal row id, once, for jobs + estimates.
    const custRows = await db
      .select({ hcpId: hcpCustomers.hcpCustomerId, id: hcpCustomers.id })
      .from(hcpCustomers);
    const custMap = new Map(custRows.map((r) => [r.hcpId, r.id]));

    // ── Jobs (what was actually done — never the ROI revenue event) ───────────
    const jobs = dedupeBy([...jobsRaw, ...(crawledJobs?.rows ?? [])], (j) => j.hcpJobId);
    await chunkedUpsert(jobs, (batch) =>
      db
        .insert(hcpJobs)
        .values(
          batch.map((j) => ({
            hcpJobId: j.hcpJobId,
            hcpCustomerId: j.hcpCustomerId ? custMap.get(j.hcpCustomerId) ?? null : null,
            workStatus: j.workStatus,
            scheduledStart: j.scheduledStart,
            totalAmountCents: j.totalAmountCents,
            subtotalCents: j.subtotalCents,
            outstandingBalanceCents: j.outstandingBalanceCents,
            invoiceNumber: j.invoiceNumber,
            description: j.description,
            completedAtHcp: j.completedAtHcp,
            canceledAtHcp: j.canceledAtHcp,
            deletedAtHcp: j.deletedAtHcp,
            updatedAtHcp: j.updatedAtHcp,
            jobType: j.jobType,
            tags: j.tags ?? null,
            assignedEmployees: j.assignedEmployees ?? null,
            estimateOptionIds: j.estimateOptionIds ?? null,
            leadSourceRaw: j.leadSourceRaw,
            address: j.address,
            createdAtHcp: j.createdAtHcp,
            raw: j.raw,
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: hcpJobs.hcpJobId,
          set: {
            hcpCustomerId: sql`excluded.hcp_customer_id`,
            workStatus: sql`excluded.work_status`,
            scheduledStart: sql`excluded.scheduled_start`,
            totalAmountCents: sql`excluded.total_amount_cents`,
            subtotalCents: sql`excluded.subtotal_cents`,
            outstandingBalanceCents: sql`excluded.outstanding_balance_cents`,
            // NOT the invoice_* rollup columns: they are derived from `hcp_invoices`
            // below, not carried on the job payload. `excluded.invoice_total_cents`
            // would be the insert default (0) and would wipe the rollup every run.
            invoiceNumber: sql`excluded.invoice_number`,
            description: sql`excluded.description`,
            completedAtHcp: sql`excluded.completed_at_hcp`,
            canceledAtHcp: sql`excluded.canceled_at_hcp`,
            deletedAtHcp: sql`excluded.deleted_at_hcp`,
            updatedAtHcp: sql`excluded.updated_at_hcp`,
            jobType: sql`excluded.job_type`,
            tags: sql`excluded.tags`,
            assignedEmployees: sql`excluded.assigned_employees`,
            estimateOptionIds: sql`excluded.estimate_option_ids`,
            leadSourceRaw: sql`excluded.lead_source_raw`,
            address: sql`excluded.address`,
            createdAtHcp: sql`excluded.created_at_hcp`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`
            ${hcpJobs.workStatus} IS DISTINCT FROM excluded.work_status
            OR ${hcpJobs.scheduledStart} IS DISTINCT FROM excluded.scheduled_start
            OR ${hcpJobs.totalAmountCents} IS DISTINCT FROM excluded.total_amount_cents
            OR ${hcpJobs.subtotalCents} IS DISTINCT FROM excluded.subtotal_cents
            OR ${hcpJobs.outstandingBalanceCents} IS DISTINCT FROM excluded.outstanding_balance_cents
            OR ${hcpJobs.completedAtHcp} IS DISTINCT FROM excluded.completed_at_hcp
            OR ${hcpJobs.canceledAtHcp} IS DISTINCT FROM excluded.canceled_at_hcp
            OR ${hcpJobs.deletedAtHcp} IS DISTINCT FROM excluded.deleted_at_hcp
            OR ${hcpJobs.updatedAtHcp} IS DISTINCT FROM excluded.updated_at_hcp
            OR ${hcpJobs.hcpCustomerId} IS DISTINCT FROM excluded.hcp_customer_id
            OR ${hcpJobs.invoiceNumber} IS DISTINCT FROM excluded.invoice_number
            OR ${hcpJobs.description} IS DISTINCT FROM excluded.description
            OR ${hcpJobs.jobType} IS DISTINCT FROM excluded.job_type
            OR ${hcpJobs.tags} IS DISTINCT FROM excluded.tags
            OR ${hcpJobs.assignedEmployees} IS DISTINCT FROM excluded.assigned_employees
            OR ${hcpJobs.estimateOptionIds} IS DISTINCT FROM excluded.estimate_option_ids
            OR ${hcpJobs.leadSourceRaw} IS DISTINCT FROM excluded.lead_source_raw
            OR ${hcpJobs.address} IS DISTINCT FROM excluded.address
          `,
        }),
    );

    await markCrawlSeen("hcp_jobs", "hcp_job_id", (crawledJobs?.rows ?? []).map((j) => j.hcpJobId));

    // ── Estimates (ROI revenue event) ─────────────────────────────────────────
    // Hot zone + whatever slice of the cold crawl this run reached. They overlap
    // once per pass, when the cursor reaches the newest pages; `dedupeBy` keeps one
    // row per id, which a multi-row ON CONFLICT requires anyway.
    const estimates = dedupeBy(
      [...estimatesRaw, ...(crawledEstimates?.estimates ?? [])],
      (e) => e.hcpEstimateId,
    );
    await chunkedUpsert(estimates, (batch) =>
      db
        .insert(hcpEstimates)
        .values(
          batch.map((e) => ({
            hcpEstimateId: e.hcpEstimateId,
            hcpCustomerId: e.hcpCustomerId ? custMap.get(e.hcpCustomerId) ?? null : null,
            status: e.status,
            won: e.won,
            outcome: e.outcome,
            totalAmountCents: e.totalAmountCents,
            approvedAmountCents: e.approvedAmountCents,
            options: e.options ?? null,
            leadSourceRaw: e.leadSourceRaw,
            customerPhoneE164: normalizePhone(e.customerPhone),
            customerEmailLc: normalizeEmail(e.customerEmail),
            customerName: e.customerName,
            address: e.address,
            createdAtHcp: e.createdAtHcp,
            scheduledStartHcp: e.scheduledStartHcp,
            approvedAtHcp: e.approvedAtHcp,
            updatedAtHcp: e.updatedAtHcp,
            raw: e.raw,
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: hcpEstimates.hcpEstimateId,
          set: {
            hcpCustomerId: sql`excluded.hcp_customer_id`,
            status: sql`excluded.status`,
            won: sql`excluded.won`,
            outcome: sql`excluded.outcome`,
            totalAmountCents: sql`excluded.total_amount_cents`,
            approvedAmountCents: sql`excluded.approved_amount_cents`,
            options: sql`excluded.options`,
            leadSourceRaw: sql`excluded.lead_source_raw`,
            // NOT line_items: it is filled by a separate hydration job, and the
            // estimate sync has nothing to write there. `excluded.line_items` would
            // be null on every run and would erase the backfill on the next tick.
            customerPhoneE164: sql`excluded.customer_phone_e164`,
            customerEmailLc: sql`excluded.customer_email_lc`,
            customerName: sql`excluded.customer_name`,
            address: sql`excluded.address`,
            scheduledStartHcp: sql`excluded.scheduled_start_hcp`,
            approvedAtHcp: sql`excluded.approved_at_hcp`,
            updatedAtHcp: sql`excluded.updated_at_hcp`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          // Skip the write when nothing meaningful moved. The crawl re-reads the
          // whole 15k-row history every pass, and without this every pass would
          // rewrite every row — ~15,000 jsonb updates a day to record a hundred
          // real changes, and a `synced_at` churn that makes "when did this last
          // CHANGE?" unanswerable.
          //
          // Compared on the fields a surface actually reads. `raw` is deliberately
          // NOT compared: HCP reshapes it and bumps timestamps inside it during its
          // own backend work, so diffing it would mark nearly every row as changed
          // and defeat the check. It is still WRITTEN whenever something else moved.
          setWhere: sql`
            ${hcpEstimates.status} IS DISTINCT FROM excluded.status
            OR ${hcpEstimates.won} IS DISTINCT FROM excluded.won
            OR ${hcpEstimates.outcome} IS DISTINCT FROM excluded.outcome
            OR ${hcpEstimates.totalAmountCents} IS DISTINCT FROM excluded.total_amount_cents
            OR ${hcpEstimates.approvedAmountCents} IS DISTINCT FROM excluded.approved_amount_cents
            OR ${hcpEstimates.scheduledStartHcp} IS DISTINCT FROM excluded.scheduled_start_hcp
            OR ${hcpEstimates.approvedAtHcp} IS DISTINCT FROM excluded.approved_at_hcp
            OR ${hcpEstimates.updatedAtHcp} IS DISTINCT FROM excluded.updated_at_hcp
            OR ${hcpEstimates.hcpCustomerId} IS DISTINCT FROM excluded.hcp_customer_id
            OR ${hcpEstimates.customerPhoneE164} IS DISTINCT FROM excluded.customer_phone_e164
            OR ${hcpEstimates.customerEmailLc} IS DISTINCT FROM excluded.customer_email_lc
            OR ${hcpEstimates.customerName} IS DISTINCT FROM excluded.customer_name
            OR ${hcpEstimates.options} IS DISTINCT FROM excluded.options
          `,
        }),
    );

    await markCrawlSeen(
      "hcp_estimates",
      "hcp_estimate_id",
      (crawledEstimates?.estimates ?? []).map((e) => e.hcpEstimateId),
    );

    // ── Invoices (what was billed and collected — never ROI revenue) ──────────
    // Resolved to a job, and through it to a customer: the invoice payload carries
    // `job_id` and nothing else. A job we have not crawled yet leaves both links
    // null, and the self-heal pass below fills them on a later run.
    const jobRows = await db
      .select({ hcpId: hcpJobs.hcpJobId, id: hcpJobs.id, customerId: hcpJobs.hcpCustomerId })
      .from(hcpJobs);
    const jobMap = new Map(jobRows.map((r) => [r.hcpId, r]));

    const invoices = dedupeBy(
      [...invoicesRaw, ...(crawledInvoices?.rows ?? [])],
      (i) => i.hcpInvoiceId,
    );
    await chunkedUpsert(invoices, (batch) =>
      db
        .insert(hcpInvoices)
        .values(
          batch.map((i) => {
            const job = i.hcpJobIdHcp ? jobMap.get(i.hcpJobIdHcp) : undefined;
            return {
              hcpInvoiceId: i.hcpInvoiceId,
              invoiceNumber: i.invoiceNumber,
              hcpJobId: job?.id ?? null,
              hcpJobIdHcp: i.hcpJobIdHcp,
              hcpCustomerId: job?.customerId ?? null,
              status: i.status,
              amountCents: i.amountCents,
              subtotalCents: i.subtotalCents,
              dueAmountCents: i.dueAmountCents,
              paidAmountCents: i.paidAmountCents,
              refundedAmountCents: i.refundedAmountCents,
              taxAmountCents: i.taxAmountCents,
              discountAmountCents: i.discountAmountCents,
              paymentMethods: i.paymentMethods ?? null,
              invoiceDate: i.invoiceDate,
              serviceDate: i.serviceDate,
              dueAt: i.dueAt,
              paidAt: i.paidAt,
              sentAt: i.sentAt,
              items: i.items ?? null,
              taxes: i.taxes ?? null,
              discounts: i.discounts ?? null,
              payments: i.payments ?? null,
              refunds: i.refunds ?? null,
              raw: i.raw,
              syncedAt: new Date(),
            };
          }),
        )
        .onConflictDoUpdate({
          target: hcpInvoices.hcpInvoiceId,
          set: {
            invoiceNumber: sql`excluded.invoice_number`,
            // COALESCE, not a plain overwrite: an invoice re-read before its job has
            // been crawled carries a null link, and a blind assignment would undo a
            // link the self-heal pass already made.
            hcpJobId: sql`coalesce(excluded.hcp_job_id, ${hcpInvoices.hcpJobId})`,
            hcpJobIdHcp: sql`excluded.hcp_job_id_hcp`,
            hcpCustomerId: sql`coalesce(excluded.hcp_customer_id, ${hcpInvoices.hcpCustomerId})`,
            status: sql`excluded.status`,
            amountCents: sql`excluded.amount_cents`,
            subtotalCents: sql`excluded.subtotal_cents`,
            dueAmountCents: sql`excluded.due_amount_cents`,
            paidAmountCents: sql`excluded.paid_amount_cents`,
            refundedAmountCents: sql`excluded.refunded_amount_cents`,
            taxAmountCents: sql`excluded.tax_amount_cents`,
            discountAmountCents: sql`excluded.discount_amount_cents`,
            paymentMethods: sql`excluded.payment_methods`,
            invoiceDate: sql`excluded.invoice_date`,
            serviceDate: sql`excluded.service_date`,
            dueAt: sql`excluded.due_at`,
            paidAt: sql`excluded.paid_at`,
            sentAt: sql`excluded.sent_at`,
            items: sql`excluded.items`,
            taxes: sql`excluded.taxes`,
            discounts: sql`excluded.discounts`,
            payments: sql`excluded.payments`,
            refunds: sql`excluded.refunds`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`
            ${hcpInvoices.status} IS DISTINCT FROM excluded.status
            OR ${hcpInvoices.amountCents} IS DISTINCT FROM excluded.amount_cents
            OR ${hcpInvoices.subtotalCents} IS DISTINCT FROM excluded.subtotal_cents
            OR ${hcpInvoices.dueAmountCents} IS DISTINCT FROM excluded.due_amount_cents
            OR ${hcpInvoices.paidAmountCents} IS DISTINCT FROM excluded.paid_amount_cents
            OR ${hcpInvoices.refundedAmountCents} IS DISTINCT FROM excluded.refunded_amount_cents
            OR ${hcpInvoices.taxAmountCents} IS DISTINCT FROM excluded.tax_amount_cents
            OR ${hcpInvoices.discountAmountCents} IS DISTINCT FROM excluded.discount_amount_cents
            OR ${hcpInvoices.invoiceNumber} IS DISTINCT FROM excluded.invoice_number
            OR ${hcpInvoices.invoiceDate} IS DISTINCT FROM excluded.invoice_date
            OR ${hcpInvoices.serviceDate} IS DISTINCT FROM excluded.service_date
            OR ${hcpInvoices.dueAt} IS DISTINCT FROM excluded.due_at
            OR ${hcpInvoices.paidAt} IS DISTINCT FROM excluded.paid_at
            OR ${hcpInvoices.sentAt} IS DISTINCT FROM excluded.sent_at
            OR ${hcpInvoices.paymentMethods} IS DISTINCT FROM excluded.payment_methods
            OR ${hcpInvoices.items} IS DISTINCT FROM excluded.items
            OR ${hcpInvoices.payments} IS DISTINCT FROM excluded.payments
            OR ${hcpInvoices.refunds} IS DISTINCT FROM excluded.refunds
            OR ${hcpInvoices.hcpJobId} IS NULL
          `,
        }),
    );

    await markCrawlSeen(
      "hcp_invoices",
      "hcp_invoice_id",
      (crawledInvoices?.rows ?? []).map((i) => i.hcpInvoiceId),
    );

    // Self-heal the invoice → job → customer links. Covers the ordering problem the
    // in-memory map cannot: an invoice read on a run whose crawl had not yet reached
    // its job, and a job whose customer link was filled in later.
    const relinked = await db.execute(sql`
      UPDATE hcp_invoices AS i
      SET hcp_job_id = j.id, hcp_customer_id = j.hcp_customer_id, updated_at = now()
      FROM hcp_jobs AS j
      WHERE j.hcp_job_id = i.hcp_job_id_hcp
        AND (i.hcp_job_id IS DISTINCT FROM j.id OR i.hcp_customer_id IS DISTINCT FROM j.hcp_customer_id)
    `);

    // Roll the invoices up onto their job. Voided and canceled invoices are excluded
    // — they are not money owed or collected, and leaving them in would make a
    // re-issued invoice count twice.
    await db.execute(sql`
      UPDATE hcp_jobs AS j
      SET invoice_total_cents = r.total,
          invoice_paid_cents = r.paid,
          invoice_due_cents = r.due,
          invoice_count = r.n,
          updated_at = now()
      FROM (
        SELECT hcp_job_id AS job_id,
               sum(amount_cents)::int AS total,
               sum(paid_amount_cents)::int AS paid,
               sum(due_amount_cents)::int AS due,
               count(*)::int AS n
        FROM hcp_invoices
        WHERE hcp_job_id IS NOT NULL
          AND coalesce(status, '') NOT IN ('voided', 'canceled')
        GROUP BY hcp_job_id
      ) AS r
      WHERE j.id = r.job_id
        AND (j.invoice_total_cents IS DISTINCT FROM r.total
             OR j.invoice_paid_cents IS DISTINCT FROM r.paid
             OR j.invoice_due_cents IS DISTINCT FROM r.due
             OR j.invoice_count IS DISTINCT FROM r.n)
    `);

    // …and clear the rollup on a job whose last live invoice was voided, which the
    // aggregate above cannot reach: it has no row left to join to.
    await db.execute(sql`
      UPDATE hcp_jobs AS j
      SET invoice_total_cents = 0, invoice_paid_cents = 0, invoice_due_cents = 0,
          invoice_count = 0, updated_at = now()
      WHERE j.invoice_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM hcp_invoices AS i
          WHERE i.hcp_job_id = j.id AND coalesce(i.status, '') NOT IN ('voided', 'canceled')
        )
    `);

    // Advance the cursors only after the rows are safely upserted — a crash between
    // the two would skip those pages until the next full pass came round.
    const estCrawlPage = crawledEstimates
      ? {
          rows: crawledEstimates.estimates,
          nextPage: crawledEstimates.nextPage,
          wrapped: crawledEstimates.wrapped,
          totalItems: crawledEstimates.totalItems,
        }
      : null;
    const estCrawlAfter = advanceCrawl(estCrawlBefore, estCrawlPage, runStartedAt);
    const custCrawlAfter = advanceCrawl(custCrawlBefore, crawledCustomers, runStartedAt);
    const jobCrawlAfter = advanceCrawl(jobCrawlBefore, crawledJobs, runStartedAt);
    const invCrawlAfter = advanceCrawl(invCrawlBefore, crawledInvoices, runStartedAt);

    await Promise.all([
      crawledEstimates ? setSetting(CRAWL_KEYS.estimates, estCrawlAfter) : null,
      crawledCustomers ? setSetting(CRAWL_KEYS.customers, custCrawlAfter) : null,
      crawledJobs ? setSetting(CRAWL_KEYS.jobs, jobCrawlAfter) : null,
      crawledInvoices ? setSetting(CRAWL_KEYS.invoices, invCrawlAfter) : null,
    ]);

    // Now that customers are fresh, tie inbox threads to them. This is the
    // direction the per-contact lookup can't cover: someone texts as a stranger
    // on Monday and is created in HousecallPro on Tuesday — their thread should
    // start showing their name without them having to text again.
    const { linked } = await linkContactsToHcpCustomers();

    const wonEstimates = estimates.filter((e) => e.won).length;
    const wonValueCents = estimates.filter((e) => e.won).reduce((s, e) => s + (e.approvedAmountCents || 0), 0);
    const liveInvoices = invoices.filter((i) => !["voided", "canceled"].includes(i.status ?? ""));
    return {
      customers: customers.length,
      contactsLinked: linked,
      jobs: jobs.length,
      estimates: estimates.length,
      invoices: invoices.length,
      wonEstimates,
      wonValueCents,
      // Reported for the rows SEEN this run, not the account — a sanity signal on
      // the pull, never a revenue figure. ROI revenue is the won estimate.
      invoicedCents: liveInvoices.reduce((s, i) => s + (i.amountCents || 0), 0),
      collectedCents: liveInvoices.reduce((s, i) => s + (i.paidAmountCents || 0), 0),
      invoicesRelinked: relinked.rowCount ?? 0,
      mode: sinceDays == null ? "incremental" : "explicit",
      windowDays: Number(windowDays.toFixed(3)),
      crawl: {
        estimates: crawlStats(estCrawlBefore, estCrawlAfter, estCrawlPage),
        customers: crawlStats(custCrawlBefore, custCrawlAfter, crawledCustomers),
        jobs: crawlStats(jobCrawlBefore, jobCrawlAfter, crawledJobs),
        invoices: crawlStats(invCrawlBefore, invCrawlAfter, crawledInvoices),
      },
    };
  });
}
