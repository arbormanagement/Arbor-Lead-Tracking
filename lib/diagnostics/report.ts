import { and, desc, eq, gte, isNotNull, isNull, lt, ne, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { isLikelyBot } from "@/lib/bot";
import { SPEND_REPULL_DAYS } from "@/lib/campaigns";
import { credentialStatus } from "@/lib/credentials";
import { CREDENTIAL_SPECS } from "@/lib/credentials/spec";
import { db } from "@/lib/db/client";
import {
  calls,
  campaigns,
  conversionExports,
  hcpCustomers,
  hcpEstimates,
  hcpInvoices,
  hcpJobs,
  leads,
  numberAssignments,
  pools,
  syncRuns,
  trackingNumbers,
  webSessions,
} from "@/lib/db/schema";
import { readSwapCoverage } from "@/lib/dni/outcomes";
import { env } from "@/lib/env";
import { optionCountSql } from "@/lib/estimates/hcp-fields";
import {
  discountCentsSql,
  grossCentsSql,
  lineItemCountSql,
  lineItemReconcileSql,
  lineItemStaleSql,
  netCentsSql,
} from "@/lib/hcp/line-items";
import { getSetting } from "@/lib/settings";
import { MAX_EXPORT_ATTEMPTS } from "@/lib/sync/conversions";
import { businessDate, BUSINESS_TZ } from "@/lib/tz";

/**
 * Read-only operational snapshot: "is this thing actually working right now?"
 *
 * Deliberately a FIXED set of checks, not a query interface. The obvious version
 * of this — something that runs SQL you hand it — would be an arbitrary-read
 * (and, one typo later, arbitrary-write) backdoor into a production database
 * holding customer contact details, guarded by a single bearer token. This
 * answers the operational questions instead, and can only ever return what is
 * written below.
 *
 * Nothing here returns a secret. Credentials are reported as configured/not and
 * where they came from — never the value, not even masked.
 *
 * Lives in lib/ (moved from the /api/diagnostics route 2026-08-24, same pattern as
 * `attributionBreakdown`) so the route and the MCP `diagnostics` tool run one
 * implementation.
 */
export async function diagnosticsReport(): Promise<{ httpStatus: number; report: Record<string, unknown> }> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  // ── Database ────────────────────────────────────────────────────────────────
  let dbUp = true;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    dbLatencyMs = Date.now() - t0;
  } catch {
    dbUp = false;
  }
  if (!dbUp) {
    return { httpStatus: 503, report: { ok: false, db: "down", checkedAt: now.toISOString() } };
  }

  // ── Sync health: newest run per job ─────────────────────────────────────────
  // The whole model is fire-and-log, so "when did each job last SUCCEED" is the
  // question that actually matters — a job erroring for three days looks fine in
  // the logs and shows up nowhere else.
  //
  // Two DISTINCT ON queries, not one capped scan. This used to read the newest 500
  // runs and derive both answers from them, which quietly made "has this job ever
  // succeeded?" a question about ROW COUNT rather than about the job: ~10 jobs
  // ticking hourly fill 500 rows in about two days, so a DAILY job whose last
  // success was three days ago fell off the end and was reported as
  // `lastSuccessAt: null` — rendered to the operator as "has never succeeded".
  // Observed 2026-08-13 on lsa.sync.leads, which had in fact been importing leads
  // since 2026-07-06. A health endpoint that cries wolf about the two jobs running
  // least often is worse than one that says nothing.
  //
  // DISTINCT ON returns one row per job whatever the history looks like, so the
  // output stays small while the lookback becomes unbounded — and both queries ride
  // the same (job, started_at) ordering.
  const latestRuns = await db
    .selectDistinctOn([syncRuns.job], {
      job: syncRuns.job,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      error: syncRuns.error,
    })
    .from(syncRuns)
    .orderBy(syncRuns.job, desc(syncRuns.startedAt));

  const latestSuccesses = await db
    .selectDistinctOn([syncRuns.job], {
      job: syncRuns.job,
      startedAt: syncRuns.startedAt,
      stats: syncRuns.stats,
    })
    .from(syncRuns)
    .where(eq(syncRuns.status, "success"))
    .orderBy(syncRuns.job, desc(syncRuns.startedAt));

  const successByJob = new Map(latestSuccesses.map((r) => [r.job, r]));
  const jobs = latestRuns
    .map((last) => {
      const lastSuccess = successByJob.get(last.job);
      return {
        job: last.job,
        lastStatus: last.status,
        lastStartedAt: last.startedAt,
        lastError: last.status === "error" ? last.error : null,
        lastSuccessAt: lastSuccess?.startedAt ?? null,
        hoursSinceSuccess: lastSuccess
          ? Math.round(((now.getTime() - +lastSuccess.startedAt) / 3_600_000) * 10) / 10
          : null,
        lastSuccessStats: lastSuccess?.stats ?? null,
        // A job stuck `running` past the reaper's 6h window means a process died
        // mid-run and the claim is blocking every later tick.
        stuckRunning: last.status === "running" && +last.startedAt < now.getTime() - 6 * 3_600_000,
      };
    })
    .sort((a, b) => a.job.localeCompare(b.job));

  // ── DNI pool ────────────────────────────────────────────────────────────────
  // Mirrors leaseNumber, including the pools.is_dni join.
  const poolRows = await db
    .select({
      phoneNumber: trackingNumbers.phoneNumber,
      pool: trackingNumbers.pool,
      isDni: pools.isDni,
      leaseId: numberAssignments.id,
    })
    .from(trackingNumbers)
    .leftJoin(pools, eq(pools.key, trackingNumbers.pool))
    .leftJoin(
      numberAssignments,
      and(
        eq(numberAssignments.trackingNumberId, trackingNumbers.id),
        isNull(numberAssignments.releasedAt),
        gte(numberAssignments.expiresAt, now),
      ),
    )
    .where(and(eq(trackingNumbers.isStatic, false), eq(trackingNumbers.status, "active")));

  // Is the 5-minute reaper actually releasing leases? It writes nothing to
  // `sync_runs`, so there is no run to inspect — but "did it run" was never the
  // question. This measures the OUTCOME: leases whose window has elapsed that are
  // still holding their number.
  //
  // At most one unreleased lease can exist per number (number_assignments_active_idx
  // is unique on tracking_number_id where released_at is null), and only DNI-pool
  // numbers are ever leased — so while the reaper works this cannot exceed the pool
  // size, and in practice sits near zero. Anything above that is the reaper failing.
  //
  // The point of having it: "DNI pool is exhausted" below has two completely
  // different causes — real traffic, or leases that stopped being released — and
  // they were indistinguishable. That matters because the documented response to
  // exhaustion is to shorten hold time rather than buy numbers, which is exactly
  // the wrong move if nothing is being released in the first place.
  const [overdue] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(numberAssignments)
    .where(and(isNull(numberAssignments.releasedAt), lt(numberAssignments.expiresAt, now)));

  const rotating = poolRows.filter((r) => r.isDni === true);
  const pool = {
    size: rotating.length,
    leased: rotating.filter((r) => r.leaseId).length,
    free: rotating.length - rotating.filter((r) => r.leaseId).length,
    overdueLeases: overdue?.n ?? 0,
    numbers: rotating.map((r) => ({ phoneNumber: r.phoneNumber, pool: r.pool, leased: !!r.leaseId })),
    // Non-empty = numbers you likely expect to rotate that never will.
    excludedFromRotation: poolRows
      .filter((r) => r.isDni !== true)
      .map((r) => ({ phoneNumber: r.phoneNumber, pool: r.pool })),
  };

  // ── Why did abandoned exports fail? ─────────────────────────────────────────
  // Knowing that N conversions were given up on is only half an answer: the fix
  // depends entirely on WHY, and that error text is sitting one column away. Group
  // it so a systemic cause (one expired credential) is obviously distinct from N
  // unrelated bad click ids.
  const abandonedExports = await db
    .select({
      platform: conversionExports.platform,
      event: conversionExports.event,
      attempts: conversionExports.attempts,
      error: conversionExports.error,
      n: sql<number>`count(*)::int`,
    })
    .from(conversionExports)
    // `attempts >= cap` alone is not abandonment — a row that FAILED four times and
    // then succeeded on the fifth still carries attempts = 5, and was being counted
    // here as permanently given up on. That put a standing "will never be retried"
    // warning on the endpoint (and pinned `ok` to false) over a conversion that had
    // in fact landed. Abandoned means past the cap AND still not sent.
    .where(and(gte(conversionExports.attempts, MAX_EXPORT_ATTEMPTS), ne(conversionExports.status, "sent")))
    .groupBy(conversionExports.platform, conversionExports.event, conversionExports.attempts, conversionExports.error)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // Waiting for abandonment to reveal the error is backwards: by then the export
  // has failed five times and is out of retries, and the run that reported
  // `failed: 2` gave no way to see WHY without going to the database. The first
  // failure is the one worth reading — it is still fixable and still retrying.
  const failingExports = await db
    .select({
      platform: conversionExports.platform,
      event: conversionExports.event,
      error: conversionExports.error,
      n: sql<number>`count(*)::int`,
      maxAttempts: sql<number>`max(${conversionExports.attempts})::int`,
    })
    .from(conversionExports)
    .where(and(eq(conversionExports.status, "error"), sql`${conversionExports.attempts} < ${MAX_EXPORT_ATTEMPTS}`))
    .groupBy(conversionExports.platform, conversionExports.event, conversionExports.error)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // ── Crawler share of web sessions ───────────────────────────────────────────
  // The DNI pool kept exhausting and bot traffic was the leading suspect, but nothing
  // recorded WHAT was asking for a number, so the theory could be neither confirmed nor
  // killed. user_agent is captured on pageview now; this turns it into a number. Classified
  // in JS with the same predicate /api/dni/assign gates on, so the two cannot drift.
  const recentSessions = await db
    .select({ userAgent: webSessions.userAgent, createdAt: webSessions.createdAt })
    .from(webSessions)
    .where(gte(webSessions.createdAt, dayAgo))
    .limit(5000);
  const botSessions = recentSessions.filter((r) => isLikelyBot(r.userAgent)).length;
  const unknownUa = recentSessions.filter((r) => r.userAgent === null).length;
  const traffic = {
    sessions24h: recentSessions.length,
    botSessions24h: botSessions,
    botShare: recentSessions.length ? Math.round((botSessions / recentSessions.length) * 100) : 0,
    // Sessions carrying no user_agent at all. They read as bots to the predicate, so
    // botShare is only meaningful once this reaches zero.
    //
    // It could not reach zero until 2026-08-21: `/api/dni/assign` seeded session rows
    // without an agent and `onConflictDoNothing` stopped the pageview beacon filling
    // it in, so every session where assign won the race manufactured its own bot.
    // Both routes now record it — a non-zero figure here is once again what it claims
    // to be (pre-fix history, or a genuinely agent-less client) rather than our own
    // bookkeeping.
    noUserAgentRecorded: unknownUa,
  };

  // ── Did the number swap actually reach visitors? ────────────────────────────
  // `traffic` above says who ASKED for a number; this says who GOT one. The gap is
  // the share of website visitors dialling a published number, which then reads as
  // `direct` on /sources and is indistinguishable from genuine word of mouth.
  const swapCoverage = await readSwapCoverage(7);

  // ── Ingest volume: has anything actually arrived? ───────────────────────────
  const [vol] = await db
    .select({
      leads24h: sql<number>`count(*) filter (where ${leads.occurredAt} >= ${dayAgo})::int`,
      leads7d: sql<number>`count(*) filter (where ${leads.occurredAt} >= ${weekAgo})::int`,
    })
    .from(leads);
  const [callVol] = await db
    .select({
      calls24h: sql<number>`count(*) filter (where ${calls.createdAt} >= ${dayAgo})::int`,
      calls7d: sql<number>`count(*) filter (where ${calls.createdAt} >= ${weekAgo})::int`,
      // The 2026-08 incident in one number: calls connecting, recordings never
      // arriving because the status callback was being rejected.
      recordedCalls7d: sql<number>`count(*) filter (where ${calls.createdAt} >= ${weekAgo} and ${calls.recordingUrl} is not null)::int`,
    })
    .from(calls);

  // ── Estimate sync coverage: is HousecallPro actually reconciled? ─────────────
  //
  // This exists because the estimate sync's one real failure was INVISIBLE from
  // inside the app: it reported success, row counts looked healthy, and ~5 in 6 won
  // estimates sat frozen at `qualified` for nine days until a human compared a lead
  // against HCP by hand. Nothing here would have been wrong; nothing here would have
  // said so either.
  //
  // Two numbers fix that, and both are pure DB reads — the cold-zone crawl records
  // HCP's own `total_items` as it goes, so this endpoint stays free of upstream calls
  // (see the note on /api/diagnostics/hcp-shape for why that separation is kept).
  //
  //   drift  — our row count vs HCP's. Deletions are SOFT there (a deleted estimate
  //            keeps being returned, see isDeletedEstimate), so nothing legitimately
  //            removes rows and this should sit at 0 forever. Any divergence is a
  //            real gap, not noise to explain away.
  //   passAgeHours — how long since the crawl last completed a full lap of the
  //            history. This is the "coverage is slipping" signal: the crawl is
  //            fault-tolerant by design, so a persistent failure shows up here as a
  //            stalling number rather than as a failed sync run.
  //
  // Reported for all four synced collections, not just estimates. Jobs, customers
  // and invoices each got a crawl of their own, and a stalled cursor is exactly as
  // invisible on any of them as it was on estimates.
  const CRAWL_STATE_DEFAULT = {
    nextPage: 1,
    passes: 0,
    lastCompletedPassAt: null,
    lastFullLapStartedAt: null,
    totalItems: null,
  };
  type CrawlStateShape = {
    nextPage: number;
    passes: number;
    lastCompletedPassAt: string | null;
    lastFullLapStartedAt: string | null;
    totalItems: number | null;
  };

  /**
   * Rows HousecallPro no longer lists.
   *
   * A completed crawl pass has, by definition, seen every row HCP will return, and
   * stamps `crawl_seen_at` on each. So anything still carrying a stamp older than
   * that pass STARTED — or none at all — is a row HCP has deleted or merged away
   * and will never mention again. This is the only way the drift can be resolved:
   * the crawl cannot see an absence, so the absence has to be inferred from what it
   * did see.
   *
   * `created_at < cutoff` excludes rows we inserted mid-pass, which the crawl may
   * legitimately have walked past before they existed.
   */
  async function missingFromHcp(table: string, hcpIdColumn: string, labelExpr: string, cutoffIso: string | null) {
    if (!cutoffIso) return { count: 0, sample: [] as unknown[] };
    const cutoff = new Date(cutoffIso);
    const res = await db.execute<{ count: number; sample: unknown[] }>(sql`
      with missing as (
        select ${sql.raw(hcpIdColumn)} as hcp_id, ${sql.raw(labelExpr)} as label
        from ${sql.raw(table)}
        where created_at < ${cutoff}
          and (crawl_seen_at is null or crawl_seen_at < ${cutoff})
      )
      select (select count(*)::int from missing) as count,
             coalesce((select jsonb_agg(t) from (select * from missing limit 10) t), '[]'::jsonb) as sample
    `);
    const row = (res.rows?.[0] ?? { count: 0, sample: [] }) as { count: number; sample: unknown[] };
    return { count: Number(row.count ?? 0), sample: row.sample ?? [] };
    // NOTE: the caller cross-checks this against drift. "Missing" rows we still hold
    // must show up as a SURPLUS against HCP's own count, so a large missing figure
    // sitting on zero drift is self-contradictory and gets suppressed rather than
    // reported — see `reconcilable` below.
  }

  const [estCount, jobCount, custCount, invCount] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(hcpEstimates),
    db.select({ n: sql<number>`count(*)::int` }).from(hcpJobs),
    db.select({ n: sql<number>`count(*)::int` }).from(hcpCustomers),
    db.select({ n: sql<number>`count(*)::int` }).from(hcpInvoices),
  ]);

  const [estCrawl, jobCrawl, custCrawl, invCrawl] = await Promise.all([
    getSetting<CrawlStateShape>("hcp.estimates.crawl", CRAWL_STATE_DEFAULT),
    getSetting<CrawlStateShape>("hcp.jobs.crawl", CRAWL_STATE_DEFAULT),
    getSetting<CrawlStateShape>("hcp.customers.crawl", CRAWL_STATE_DEFAULT),
    getSetting<CrawlStateShape>("hcp.invoices.crawl", CRAWL_STATE_DEFAULT),
  ]);

  const [missingEstimates, missingJobs, missingCustomers, missingInvoices] = await Promise.all([
    missingFromHcp("hcp_estimates", "hcp_estimate_id", "customer_name", estCrawl.lastFullLapStartedAt),
    missingFromHcp("hcp_jobs", "hcp_job_id", "coalesce(invoice_number, description)", jobCrawl.lastFullLapStartedAt),
    missingFromHcp(
      "hcp_customers",
      "hcp_customer_id",
      "nullif(trim(concat_ws(' ', first_name, last_name)), '')",
      custCrawl.lastFullLapStartedAt,
    ),
    missingFromHcp("hcp_invoices", "hcp_invoice_id", "invoice_number", invCrawl.lastFullLapStartedAt),
  ]);

  function collectionSync(
    ours: number,
    crawl: CrawlStateShape,
    missing: { count: number; sample: unknown[] },
  ) {
    const ageHours = crawl.lastCompletedPassAt
      ? Number(((now.getTime() - new Date(crawl.lastCompletedPassAt).getTime()) / 3_600_000).toFixed(1))
      : null;
    // Drift is only meaningful once a full pass has landed. Before that the crawl is
    // still filling — a cold start reads under-count by thousands for about a day —
    // and reporting that as drift would fire a warning for every collection on every
    // fresh deploy, which is how a real drift warning stops being believed.
    const backfilling = crawl.passes === 0;
    const drift = backfilling || crawl.totalItems == null ? null : ours - crawl.totalItems;
    return {
      ours,
      housecallPro: crawl.totalItems,
      drift,
      backfilling,
      crawlPage: crawl.nextPage,
      completedPasses: crawl.passes,
      lastCompletedPassAt: crawl.lastCompletedPassAt,
      passAgeHours: ageHours,
      // Rows the last full lap never saw: HCP has dropped them. Named as the
      // explanation for a surplus drift rather than left for someone to work out.
      //
      // Cross-checked against drift before being believed. A row we hold and HCP
      // does not must make our count HIGHER than theirs, so "missing" can never
      // legitimately exceed the surplus. When it does, the stamping is incomplete
      // rather than the data being gone — report the incoherence instead of the
      // number, because a diagnostic that confidently declares a whole table
      // deleted does more damage than one that admits it cannot tell.
      missingFromHcp:
        missing.count > 0 && missing.count > Math.max(0, drift ?? 0)
          ? {
              count: 0,
              sample: [],
              inconclusive:
                `${missing.count} row(s) unstamped but drift is ${drift ?? "unknown"} — ` +
                `the crawl has not yet stamped a full lap, so absence cannot be distinguished from not-yet-seen`,
            }
          : missing,
    };
  }

  /**
   * Are the `expand`-only fields actually arriving?
   *
   * HCP silently ignores query parameters it does not recognise, so a mis-encoded
   * `expand` returns a healthy-looking 200 with the field simply absent — and for
   * `do_not_service`, absent reads identically to `false`. Coverage is therefore the
   * only way to tell "nobody is flagged" from "we never asked properly", and the
   * difference between those two is a newsletter going to 51 people who asked never
   * to be contacted.
   */
  const [expandRow] = await db
    .select({
      customers: sql<number>`count(*)::int`,
      doNotServiceKnown: sql<number>`count(*) filter (where ${hcpCustomers.doNotService} is not null)::int`,
      doNotServiceFlagged: sql<number>`count(*) filter (where ${hcpCustomers.doNotService} is true)::int`,
    })
    .from(hcpCustomers);
  const [apptRow] = await db
    .select({
      jobs: sql<number>`count(*)::int`,
      appointmentsKnown: sql<number>`count(*) filter (where ${hcpJobs.appointments} is not null)::int`,
    })
    .from(hcpJobs);

  /**
   * Line-item hydration coverage, and — more importantly — whether the DISCOUNT
   * MATHS is right.
   *
   * `mismatched` is the load-bearing number. Every hydrated record carries an
   * independent answer to what it should total: HCP's own `total_amount_cents`. So
   * `gross - discount` can be checked against it on every row rather than trusted
   * from the three records the formula was derived on. A shape the formula gets
   * wrong — compounding percent discounts, a percent taken after a fixed one,
   * gratuity handled differently — shows up here as a non-zero count instead of as
   * a column that has been quietly wrong for months.
   *
   * Estimates are checked only where `optionCount = 1`: with several options
   * `total_amount_cents` is the highest one, not the sum, so there is nothing for a
   * flat line-item total to reconcile against. That is a limit of the check, not of
   * the maths.
   */
  const [liJobs] = await db
    .select({
      total: sql<number>`count(*)::int`,
      hydrated: sql<number>`count(*) filter (where ${hcpJobs.lineItemsSyncedAt} is not null)::int`,
      withItems: sql<number>`count(*) filter (where ${lineItemCountSql(hcpJobs.lineItems)} > 0)::int`,
      discounted: sql<number>`count(*) filter (where ${discountCentsSql(hcpJobs.lineItems)} > 0)::int`,
      mismatched: sql<number>`count(*) filter (where ${lineItemReconcileSql(hcpJobs.lineItems, hcpJobs.totalAmountCents, hcpJobs.syncedAt, hcpJobs.lineItemsSyncedAt)})::int`,
      stale: sql<number>`count(*) filter (where ${lineItemStaleSql(hcpJobs.lineItems, hcpJobs.totalAmountCents, hcpJobs.syncedAt, hcpJobs.lineItemsSyncedAt)})::int`,
    })
    .from(hcpJobs);
  const [liEstimates] = await db
    .select({
      total: sql<number>`count(*)::int`,
      hydrated: sql<number>`count(*) filter (where ${hcpEstimates.lineItemsSyncedAt} is not null)::int`,
      withItems: sql<number>`count(*) filter (where ${lineItemCountSql(hcpEstimates.lineItems)} > 0)::int`,
      discounted: sql<number>`count(*) filter (where ${discountCentsSql(hcpEstimates.lineItems)} > 0)::int`,
      mismatched: sql<number>`count(*) filter (where ${optionCountSql} = 1 and ${lineItemReconcileSql(hcpEstimates.lineItems, hcpEstimates.totalAmountCents, hcpEstimates.syncedAt, hcpEstimates.lineItemsSyncedAt)})::int`,
      stale: sql<number>`count(*) filter (where ${optionCountSql} = 1 and ${lineItemStaleSql(hcpEstimates.lineItems, hcpEstimates.totalAmountCents, hcpEstimates.syncedAt, hcpEstimates.lineItemsSyncedAt)})::int`,
    })
    .from(hcpEstimates);

  /**
   * WHICH records fail to reconcile, not just how many.
   *
   * A count with nothing to look at is a dead end: it says the discount maths is
   * wrong somewhere in 25k records and gives no way to find out where. The sample
   * carries the numbers that make the disagreement diagnosable on sight — gross,
   * discount, what we compute, and what HousecallPro says — so the shape can be
   * read off the diagnostic instead of hunted for.
   *
   * Only queried when there is a mismatch, so the common case costs nothing.
   */
  const mismatchSample = async (
    table: typeof hcpJobs | typeof hcpEstimates,
    items: SQLWrapper,
    total: PgColumn,
    parentSyncedAt: PgColumn,
    itemsSyncedAt: PgColumn,
    label: PgColumn,
    extra?: SQL,
  ) =>
    db
      .select({
        label,
        gross: grossCentsSql(items),
        discount: discountCentsSql(items),
        computed: netCentsSql(items),
        hcpTotal: total,
      })
      .from(table)
      .where(
        extra
          ? and(lineItemReconcileSql(items, total, parentSyncedAt, itemsSyncedAt), extra)
          : lineItemReconcileSql(items, total, parentSyncedAt, itemsSyncedAt),
      )
      .limit(5);

  const lineItems = {
    jobs: {
      hydrated: liJobs?.hydrated ?? 0,
      pending: (liJobs?.total ?? 0) - (liJobs?.hydrated ?? 0),
      withItems: liJobs?.withItems ?? 0,
      discounted: liJobs?.discounted ?? 0,
      mismatched: liJobs?.mismatched ?? 0,
      staleParent: liJobs?.stale ?? 0,
      mismatchSample: (liJobs?.mismatched ?? 0) > 0
        ? await mismatchSample(
            hcpJobs, hcpJobs.lineItems, hcpJobs.totalAmountCents,
            hcpJobs.syncedAt, hcpJobs.lineItemsSyncedAt, hcpJobs.invoiceNumber,
          )
        : [],
    },
    estimates: {
      hydrated: liEstimates?.hydrated ?? 0,
      pending: (liEstimates?.total ?? 0) - (liEstimates?.hydrated ?? 0),
      withItems: liEstimates?.withItems ?? 0,
      discounted: liEstimates?.discounted ?? 0,
      mismatched: liEstimates?.mismatched ?? 0,
      staleParent: liEstimates?.stale ?? 0,
      mismatchSample: (liEstimates?.mismatched ?? 0) > 0
        ? await mismatchSample(
            hcpEstimates,
            hcpEstimates.lineItems,
            hcpEstimates.totalAmountCents,
            hcpEstimates.syncedAt,
            hcpEstimates.lineItemsSyncedAt,
            hcpEstimates.hcpEstimateId,
            sql`${optionCountSql} = 1`,
          )
        : [],
    },
    note:
      "mismatched = records where line-item gross minus discounts does not equal HCP's own total, " +
      "counting only those whose PARENT row was read at or after their line items — so both sides " +
      "describe the same state of HousecallPro. It is the check on the discount maths (a 'percent " +
      "discount' line carries basis points, not cents) and should be 0. staleParent is the same " +
      "disagreement where the parent is the OLDER read: a record re-priced in HCP between the two " +
      "reads, which is innocent and clears on the next sync lap. Estimates are checked only at " +
      "optionCount = 1, where a flat total is comparable at all.",
  };

  const expandCoverage = {
    doNotService: {
      known: expandRow?.doNotServiceKnown ?? 0,
      unknown: (expandRow?.customers ?? 0) - (expandRow?.doNotServiceKnown ?? 0),
      flagged: expandRow?.doNotServiceFlagged ?? 0,
      note: "null = UNKNOWN, never 'safe to contact'. Any mailing filter must require do_not_service IS FALSE.",
    },
    appointments: {
      known: apptRow?.appointmentsKnown ?? 0,
      unknown: (apptRow?.jobs ?? 0) - (apptRow?.appointmentsKnown ?? 0),
    },
  };

  const hcpSync = {
    estimates: collectionSync(estCount[0]?.n ?? 0, estCrawl, missingEstimates),
    jobs: collectionSync(jobCount[0]?.n ?? 0, jobCrawl, missingJobs),
    customers: collectionSync(custCount[0]?.n ?? 0, custCrawl, missingCustomers),
    invoices: collectionSync(invCount[0]?.n ?? 0, invCrawl, missingInvoices),
  };

  // Kept as its own key: it is what /api/diagnostics has always exposed and what
  // existing readers (and the project notes) look for.
  const estimateSync = hcpSync.estimates;
  const passAgeHours = estimateSync.passAgeHours;

  // ── Configuration sanity ────────────────────────────────────────────────────
  // Credentials resolve from env only (the DB store was removed 2026-08-12), so a field is
  // set or it isn't — there is no third state where a stored value silently outranks env.
  // `missing` names the env var to set rather than the internal key, since that is the thing
  // an operator has to go and change.
  const creds: Record<string, { configured: string[]; missing: string[] }> = {};
  for (const spec of CREDENTIAL_SPECS) {
    const platform = spec.platform;
    const status = await credentialStatus(platform);
    creds[platform] = {
      configured: status.filter((f) => f.set).map((f) => f.key),
      missing: status.filter((f) => !f.set).map((f) => f.envKey ?? f.key),
    };
  }

  const config = {
    // Which commit is actually serving this request. Merging is not deploying,
    // and every other signal here is indirect — compare this against the repo to
    // settle "is that fix live yet?" in one look.
    commit: env.RAILWAY_GIT_COMMIT_SHA ? env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : "unknown",
    appBaseUrl: env.APP_BASE_URL,
    // A trailing slash here silently invalidates every Twilio signature.
    appBaseUrlHasTrailingSlash: /\/$/.test(env.APP_BASE_URL ?? ""),
    twilioWebhookBase: env.TWILIO_VOICE_WEBHOOK_BASE ?? null,
    // Unset means /status and /recording fail closed and every callback is
    // rejected — calls still connect, so nothing surfaces in the app.
    twilioAuthTokenSet: creds.twilio?.configured.includes("auth_token") ?? false,
    adminApiTokenSet: !!env.ADMIN_API_TOKEN,
    cronSecretSet: !!env.CRON_SECRET,
    dbDriver: env.DB_DRIVER,
    businessTimezone: BUSINESS_TZ,
    businessDateToday: businessDate(now),
  };

  // Anything here is worth a human looking at it now.
  /**
   * Campaigns that share a NAME, which is the one thing that can make campaign-grain
   * ROI silently wrong in both directions at once.
   *
   * `resolveCampaignId` prefers the campaign id Google stamps into the landing page,
   * so a collision no longer decides attribution where that id is present. It is not
   * always present — a lead from a cached URL carrying only `utm_campaign=<name>`,
   * or a hand-built link, still resolves by name — so a duplicate name is still worth
   * knowing about, and nothing in this app could previously see one.
   *
   * Found 2026-08-30 with two campaigns both called `Search | Tree Services`: the
   * live one showed $7,446 of spend against 0 contacts while the one that had not
   * spent in a month held 51 contacts and $6,730 of revenue. Neither row was true,
   * and both looked plausible on their own — which is why this needs a check rather
   * than a reader noticing.
   */
  const duplicateCampaignNames = await db
    .select({
      name: campaigns.name,
      count: sql<number>`count(*)::int`,
      ids: sql<string[]>`array_agg(${campaigns.externalCampaignId} order by ${campaigns.externalCampaignId})`,
    })
    .from(campaigns)
    .where(isNotNull(campaigns.name))
    .groupBy(campaigns.name)
    .having(sql`count(*) > 1`);

  const warnings: string[] = [];
  for (const d of duplicateCampaignNames) {
    warnings.push(
      `${d.count} campaigns share the name "${d.name}" (ids ${d.ids.join(", ")}) and ALL of them ` +
        `have spent inside the last ${SPEND_REPULL_DAYS} days — a lead whose utm_campaign carries ` +
        `only the name cannot be assigned to one of them. The seed disambiguates a shared name ` +
        `automatically once a campaign stops spending; it cannot here, because renaming a campaign ` +
        `the spend sync still pulls would be undone on the next run. Rename one in the ad account, ` +
        `or switch that account's tracking template to {campaignid}.`,
    );
  }
  if (config.appBaseUrlHasTrailingSlash) {
    warnings.push("APP_BASE_URL has a trailing slash — Twilio signature validation will reject every callback");
  }
  if (!config.twilioAuthTokenSet) {
    warnings.push("Twilio auth token is not set — /api/twilio/status and /recording fail closed, so no recording will ever persist");
  }
  if (pool.excludedFromRotation.length) {
    warnings.push(`${pool.excludedFromRotation.length} active non-static number(s) are not in a DNI pool and will never rotate`);
  }
  if (pool.size > 0 && pool.free === 0) {
    warnings.push("DNI pool is exhausted — visitors are being shown the static fallback number");
  }
  // Soft deletes mean rows are never legitimately removed upstream, so any drift at
  // all is a gap. Warned in both directions: fewer than HCP means we are missing
  // estimates, more means something vanished there and we should find out why before
  // deciding whether to tombstone it.
  if (expandCoverage.doNotService.unknown > 0) {
    warnings.push(
      `do_not_service is UNKNOWN for ${expandCoverage.doNotService.unknown} customer(s) — ` +
        `they have not been re-read since the expand was added. Do NOT treat them as mailable; ` +
        `a mailing filter must require do_not_service IS FALSE, not IS NOT TRUE`,
    );
  }
  // A non-zero mismatch means a discount figure somewhere is WRONG, not merely
  // missing, so it is louder than a coverage gap: a wrong number gets reported as
  // fact, while an absent one gets noticed.
  for (const [what, li] of [["job", lineItems.jobs], ["estimate", lineItems.estimates]] as const) {
    if (li.mismatched > 0) {
      warnings.push(
        `${li.mismatched} ${what}(s) do NOT reconcile: line-item gross minus discounts differs from ` +
          `HousecallPro's own total on records where BOTH sides were read from the same state of HCP, ` +
          `so this is not staleness. The discount derivation in lib/hcp/line-items.ts is wrong for some ` +
          `shape in the data — do not report discountCents until this is 0. See lineItems.${what}s.mismatchSample`,
      );
    }
  }
  for (const [name, state] of Object.entries(hcpSync)) {
    if (state.drift != null && state.drift !== 0) {
      // A surplus fully accounted for by rows HCP has dropped is explained, not
      // mysterious — say so, so the warning stays a signal rather than furniture.
      const explained = state.drift > 0 && state.missingFromHcp.count === state.drift;
      warnings.push(
        `${name} count differs from HousecallPro by ${state.drift} ` +
          `(ours ${state.ours}, HCP ${state.housecallPro})` +
          (explained
            ? ` — all ${state.missingFromHcp.count} are rows HCP no longer lists (deleted or merged there); see hcpSync.${name}.missingFromHcp`
            : state.missingFromHcp.count > 0
              ? ` — ${state.missingFromHcp.count} of them are rows HCP no longer lists; see hcpSync.${name}.missingFromHcp`
              : ""),
      );
    }
    // ~2 full passes at the configured crawl rate. Slower than that means the crawl
    // is erroring or the cursor is stuck, and aged rows are drifting out of sync.
    // Estimates walk the longest history (77 pages), so its rate sets the threshold
    // for all four.
    if (state.passAgeHours != null && state.passAgeHours > 96) {
      warnings.push(
        `${name} history crawl has not completed a full pass in ${state.passAgeHours}h — coverage of older ${name} is stale`,
      );
    }
  }
  // Stated before any capacity tuning: an unreleased-lease backlog looks exactly
  // like heavy traffic from the pool's side, and only this tells the two apart.
  if (pool.overdueLeases > pool.size) {
    warnings.push(
      `${pool.overdueLeases} expired lease(s) are still holding a number (pool is ${pool.size}) — ` +
        `the 5-minute 'reaper' job is not releasing them; do NOT tune hold time or buy numbers until it is running`,
    );
  }
  if (pool.size === 0) warnings.push("DNI pool is empty — no number can be leased to a visitor");
  // Only worth a warning once there is enough traffic for the rate to mean anything;
  // below that it swings on single requests and would cry wolf every quiet night.
  if (swapCoverage.visitors >= 100 && swapCoverage.coveredPct !== null && swapCoverage.coveredPct < 80) {
    warnings.push(
      `only ${swapCoverage.coveredPct}% of DNI requests got a pool number over the last ` +
        `${swapCoverage.windowDays}d — the rest of those visitors keep the published number and read as 'direct'`,
    );
  }
  if ((swapCoverage.byOutcome.static_fallback ?? 0) > 0) {
    warnings.push(
      `${swapCoverage.byOutcome.static_fallback} visitor(s) were handed the static fallback in the last ` +
        `${swapCoverage.windowDays}d — the pool ran dry at least once`,
    );
  }
  for (const j of jobs) {
    if (j.stuckRunning) warnings.push(`sync job '${j.job}' has been 'running' for over 6h — its claim is blocking later ticks`);
    if (j.lastStatus === "error") warnings.push(`sync job '${j.job}' last run failed: ${j.lastError ?? "unknown error"}`);
    // A run can SUCCEED while the work inside it failed — conversions.export
    // reporting {sent: 0, failed: 1} is a success row with a dropped upload behind
    // it. Reading only `status` is exactly the blind spot that let a dead spend
    // provider report success for weeks, so surface per-item failures too.
    const stats = j.lastSuccessStats as Record<string, unknown> | null;
    // Keyed with its own wording: these are counted for different reasons and
    // "failed item(s)" reads as nonsense for a number that was never attempted.
    // Numeric keys only — an `errors: string[]` would be persisted and silently
    // never alerted on, which is why twilio.webhooks.backfill also emits a count.
    for (const [key, what] of [
      ["failed", "failed item(s)"],
      ["failedProviders", "failed provider(s)"],
      ["errorCount", "item(s) it could not write"],
      ["skippedNoSid", "active number(s) with no Twilio SID — their texts and voice fallback can never be configured"],
    ] as const) {
      const n = stats && typeof stats[key] === "number" ? (stats[key] as number) : 0;
      if (n > 0) warnings.push(`sync job '${j.job}' succeeded but reported ${n} ${what} (stats.${key})`);
    }
    // `abandoned` is the quieter case and needs its own check: once an export
    // passes its retry cap it stops being counted in `failed`, so the run goes
    // clean while the work is permanently undone. Retrying forever was the wrong
    // answer, but so is forgetting.
    const abandoned = stats && typeof stats.abandoned === "number" ? (stats.abandoned as number) : 0;
    if (abandoned > 0) {
      warnings.push(
        `sync job '${j.job}' has permanently abandoned ${abandoned} item(s) after repeated failures — they will never be retried`,
      );
    }
    if (j.hoursSinceSuccess !== null && j.hoursSinceSuccess > 48) {
      warnings.push(`sync job '${j.job}' has not succeeded in ${j.hoursSinceSuccess}h`);
    }
    if (j.hoursSinceSuccess === null) warnings.push(`sync job '${j.job}' has never succeeded`);
  }

  return {
    httpStatus: 200,
    report: {
      ok: warnings.length === 0,
      checkedAt: now.toISOString(),
      db: { up: true, latencyMs: dbLatencyMs },
      warnings,
      config,
      pool,
      jobs,
      abandonedExports,
      failingExports,
      traffic,
      swapCoverage,
      volume: { ...vol, ...callVol },
      estimateSync,
      hcpSync,
      lineItems,
      expandCoverage,
      duplicateCampaignNames,
      credentials: creds,
    },
  };
}
