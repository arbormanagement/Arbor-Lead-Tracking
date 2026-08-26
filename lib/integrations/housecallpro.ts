import { getPlatformCreds } from "@/lib/credentials";
import { env } from "@/lib/env";
import { fetchWithRetry } from "./http";
import type {
  HcpCrawlPage,
  HcpCustomerDTO,
  HcpEstimateCrawlPage,
  HcpEstimateDTO,
  HcpInvoiceDTO,
  HcpJobDTO,
  RevenueProvider,
} from "./types";

/**
 * Direct HousecallPro REST client. HCP is the ROI revenue source of truth, so it
 * gets the most reliable path: a plain API-key call, no gateway in between.
 *
 * Credentials come from the in-app resolver (`getPlatformCreds`) — DB-stored values
 * override env fallback. Auth: HCP API keys use the `Token` scheme. Money: HCP
 * amounts are already in integer cents. Field mappings are defensive (raw retained)
 * so a minor upstream shape change degrades to nulls rather than throwing mid-sync.
 */
interface HcpConfig {
  apiKey: string;
  base: string;
}

/** HCP's maximum `page_size`. Verified against the live API: 500 is rejected with
 *  "Size must be less than or equal to 200". */
const HCP_MAX_PAGE_SIZE = 200;

/** Floor for the /jobs schedule window. Wide enough that a job scheduled months
 *  ago and completed today still re-syncs — the case a tight window missed — while
 *  keeping the pull bounded server-side. */
const JOBS_MIN_WINDOW_DAYS = 180;

/**
 * The "hot zone": how many pages of newest-first estimates are re-read on EVERY
 * run. See `listEstimates` for why an `updated_at` window cannot work here.
 *
 * Sized from the measured decay curve rather than a guess (2026-08-15, sampling
 * creation cohorts across the full 2017–2026 history — what fraction of a cohort
 * had any option change in the last 30 days):
 *
 *   age  17d ...... 100%      age  72d ......  18%
 *   age  26d ...... 100%      age 113d ......   1%
 *   age  49d ......  74%      age 443d ......   1%
 *
 * The cliff is at roughly 60 days, NOT the 120 this used to assume. 7 pages is
 * ~1,400 estimates ≈ 90 days at current volume — past the cliff with margin, and
 * enough to cover HCP's nightly expiry sweep, which fires 30–45 days after
 * creation (05:01 UTC, visible as option `updated_at` values in a tight run).
 *
 * Everything older is covered by `crawlEstimates` instead. Deliberately a PAGE
 * count, not a day count: it is what bounds the request cost per run, and the
 * cost is the thing this number exists to control.
 */
const ESTIMATE_HOT_PAGES = 7;

/**
 * The invoice "hot zone": pages of newest-TOUCHED-first invoices re-read every run.
 *
 * A page count rather than a date window for a harder reason than the estimate
 * case. HCP's invoice payload carries no `created_at` and no `updated_at` at all —
 * verified 2026-08-25 against both `GET /invoices` and `GET /invoices/{id}`, whose
 * key sets are identical and contain neither — even though both are accepted as
 * `sort_by` values and `created_at_min` filters correctly server-side. So the list
 * can be ORDERED by recency but no row can be dated from what comes back, and
 * `paginate`'s early stop has nothing to read. `paginateFixed` is the honest tool.
 *
 * 2 pages is ~400 invoices. Sized DOWN from 5 on 2026-08-26 after watching a real
 * run: every sync was pulling ~4,100 rows across the four hot passes to catch a
 * handful of changes, and invoices were the worst offender — 1,000 rows an hour
 * against an account that writes about three invoices a day. The original 5 was
 * chosen on "generous is safe" reasoning precisely because there is no timestamp to
 * early-stop on, which is not a reason to read a year of history every hour.
 *
 * 400 rows still covers months of any change (an invoice being sent, paid, voided),
 * and the crawl — which now clears a full lap far faster, see CRAWL_COLD_START_BUDGET_MS
 * in lib/sync/hcp.ts — is what guarantees the rest.
 */
const INVOICE_HOT_PAGES = 2;

/** Page ceiling for a routine pull. 50 pages x 200 = 10,000 rows. */
const DEFAULT_MAX_PAGES = 50;

/**
 * Page ceiling sized from the window being asked for, so a deliberate deep
 * backfill is not throttled by a bound written for hourly runs, while an hourly
 * run keeps a tight one.
 *
 * The fixed 50-page ceiling was fine until the first real backfill: the account
 * holds ~15,200 estimates (153 pages), so any request for the full history would
 * have stopped at 5,000 rows. Sized off ~17 estimates/day at current volume
 * (~0.17 pages/day), `windowDays / 2` leaves roughly 3x headroom for growth and
 * for denser endpoints, and pagination stops naturally when the data runs out —
 * the ceiling only ever fires when something is genuinely wrong.
 */
function pageCeilingFor(windowDays: number): number {
  return Math.min(2000, Math.max(DEFAULT_MAX_PAGES, Math.ceil(windowDays / 2)));
}

class HousecallProProvider implements RevenueProvider {
  readonly name = "housecallpro:direct";

  private async config(): Promise<HcpConfig> {
    const c = await getPlatformCreds("housecallpro");
    if (!c.api_key) throw new Error("HousecallPro API key is not configured");
    // env.HCP_API_BASE carries the default. Hardcoding the literal here made the
    // documented override dead: no credential spec field maps HCP_API_BASE, so
    // `c.api_base` is always undefined and setting the env var did nothing.
    return { apiKey: c.api_key, base: c.api_base || env.HCP_API_BASE };
  }

  private async get<T = unknown>(cfg: HcpConfig, path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(path, cfg.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const res = await fetchWithRetry(url, {
      headers: {
        Authorization: `Token ${cfg.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    }, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`HCP ${res.status} ${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * Paginate a newest-first list. `stopOlderThanMs` early-stops the moment a page's
   * last item is older than the cutoff — so a 30-day sync reads a few pages, not
   * the whole account history (endpoints without a server-side date filter would
   * otherwise walk to the 100-page cap and time the function out).
   *
   * `sortedOn` MUST name the field the request is actually sorted by: the early
   * stop is only sound because the list is descending on that field. Reading
   * `updated_at` off a list sorted by `created_at` would stop on the first row
   * that happens to be old, mid-list, and silently drop the rest.
   */
  /**
   * Read exactly `pages` pages and stop, with no truncation semantics.
   *
   * Deliberately separate from `paginate`, which throws when it exhausts its page
   * ceiling on a full page — correct there, because the ceiling means "this window
   * held more than we expected" and silence would look like completeness. Here the
   * page count IS the window: the hot zone is defined as "the newest N pages", so
   * stopping on a full page is the normal, intended outcome. Overloading `paginate`
   * with a "ceiling is fine actually" flag would have made every future reader work
   * out which of the two meanings applied at each call site.
   */
  private async paginateFixed(
    cfg: HcpConfig,
    path: string,
    listKey: string,
    query: Record<string, string | number>,
    pages: number,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= pages; page++) {
      const body = await this.get<Record<string, unknown>>(cfg, path, {
        ...query,
        page,
        page_size: HCP_MAX_PAGE_SIZE,
      });
      const items = (body[listKey] as Array<Record<string, unknown>>) ?? [];
      out.push(...items);
      if (items.length < HCP_MAX_PAGE_SIZE) break; // ran out of data
    }
    return out;
  }

  private async paginate(
    cfg: HcpConfig,
    path: string,
    listKey: string,
    query: Record<string, string | number> = {},
    stopOlderThanMs?: number,
    sortedOn: (row: Record<string, unknown>) => Date | null = (r) => parseDate(r.updated_at ?? r.updated_at_iso),
    maxPages: number = DEFAULT_MAX_PAGES,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    // 200 is HCP's hard maximum — `page_size=500` is rejected with
    // "Size must be less than or equal to 200". Every list endpoint here was
    // paging at 100, i.e. twice the requests for the same rows.
    const pageSize = HCP_MAX_PAGE_SIZE;
    let page = 1;
    for (; page <= maxPages; page++) {
      const body = await this.get<Record<string, unknown>>(cfg, path, { ...query, page, page_size: pageSize });
      const items =
        (body[listKey] as Array<Record<string, unknown>>) ??
        (body.data as Array<Record<string, unknown>>) ??
        [];
      out.push(...items);
      if (items.length < pageSize) return out;
      if (stopOlderThanMs != null) {
        const last = items[items.length - 1];
        const u = last ? sortedOn(last) : null;
        if (u && u.getTime() < stopOlderThanMs) return out; // sorted desc → the rest is older
      }
    }
    // Fell out of the loop with a full last page: there is more data we did not
    // fetch. This THROWS rather than returning a partial list, because silence
    // here reads as "complete" — the sync records success and its watermark
    // advances past records it never saw, so they are only ever recovered if HCP
    // happens to touch their updated_at again. A warning was not enough: it went
    // to container stdout while `sync_runs` said success and the row counts
    // looked plausible. Failing the run puts it in `sync_runs.error` and on
    // /api/diagnostics, and the next tick retries — a loud failure is strictly
    // better than a quiet hole in the history.
    throw new Error(
      `HCP ${path}: hit the ${maxPages}-page cap at ${out.length} rows — results would be TRUNCATED. ` +
        `Narrow the window, or raise the ceiling (see pageCeilingFor).`,
    );
  }

  async listCustomers({ sinceDays }: { sinceDays: number }): Promise<HcpCustomerDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;
    const rows = await this.paginate(cfg, "/customers", "customers", {
      sort_by: "updated_at",
      sort_direction: "desc",
    }, cutoff, undefined, pageCeilingFor(sinceDays));
    return rows
      .filter((c) => {
        const updated = parseDate(c.updated_at ?? c.updated_at_iso);
        return !updated || updated.getTime() >= cutoff;
      })
      .map(mapCustomer);
  }

  async listJobs({ sinceDays }: { sinceDays: number }): Promise<HcpJobDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;
    // Keep a SERVER-SIDE bound, always.
    //
    // Dropping `scheduled_start_min` for pure updated_at windowing was a
    // regression: /jobs rows do not carry a parseable updated_at (customers and
    // estimates do — same filter, and they correctly return 0 for a 3-hour
    // window), so nothing was dateable, the client filter kept every row, and the
    // "incremental" pull fetched the entire job history — 636 rows, 7 full pages —
    // once an hour. Observed in production 2026-08-10.
    //
    // The original 30-day schedule window was too tight for the real complaint:
    // a job scheduled months ago and completed today would never re-sync. So keep
    // a schedule bound, but a wide one — that stays bounded no matter what the
    // payload looks like, while covering late completions by a margin that
    // weather-delayed tree work comfortably fits inside.
    const windowDays = Math.max(sinceDays, JOBS_MIN_WINDOW_DAYS);
    const min = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const rows = await this.paginate(cfg, "/jobs", "jobs", {
      sort_by: "updated_at",
      sort_direction: "desc",
      scheduled_start_min: min,
    }, cutoff, undefined, pageCeilingFor(windowDays));

    // One-time shape probe. The field names above are assumptions about HCP's
    // payload, and the cost of a wrong assumption here is a silently unbounded
    // sync — so say what actually came back rather than leaving it to be inferred
    // from a row count months later.
    if (rows.length > 0 && !parseDate(rows[0]!.updated_at ?? rows[0]!.updated_at_iso)) {
      console.warn(
        `[hcp] /jobs rows have no parseable updated_at — windowing falls back to the ` +
          `${windowDays}d scheduled_start bound. Available keys: ${Object.keys(rows[0]!).join(", ")}`,
      );
    }
    // Narrow further to the incremental window where the row can be dated, but do
    // NOT rely on that for boundedness — the server-side window above is what
    // guarantees it. An undateable row is kept rather than dropped: losing a job
    // outright is worse than syncing it more often than needed, and the pull is
    // already bounded either way.
    return rows
      .filter((j) => {
        const when = parseDate(j.updated_at ?? j.updated_at_iso) ?? parseDate(j.created_at);
        return !when || when.getTime() >= cutoff;
      })
      .map(mapJob);
  }

  /**
   * Estimates cannot be synced incrementally on `updated_at`, because HCP does not
   * touch it when the things we actually measure change.
   *
   * Verified against the live account 2026-08-13: an estimate is priced, approved,
   * declined and expired entirely through its `options[]`, and only the OPTION's
   * `updated_at` moves. Three examples, all approved with a job created, all still
   * carrying `updated_at == created_at` on the estimate itself:
   *
   *   csr … 2026-07-09  header 2026-07-09  option 2026-08-10  approved $2,357.50
   *   csr … 2026-07-09  header 2026-07-09  option 2026-07-14  approved $1,120.00
   *   csr … 2026-07-08  header 2026-07-08  option 2026-07-20  approved   $187.50
   *
   * An `updated_at` window therefore reads each estimate exactly once — at
   * creation, when it is unpriced (`total_amount: 0`) and undecided
   * (`approval_status: null`) — and never again. Every later approval is invisible.
   * That is not a slow drift: it silently froze ~5 in 6 won estimates at
   * `qualified`, so the funnel showed a ~6% close rate against a real one near 30%.
   *
   * The fix is a re-read keyed on `created_at`: an estimate young enough to still
   * be in play is re-read on every run, so a decision lands within the hour however
   * it was made. The `updated_at` pass is kept alongside it — it is one page, and it
   * is the only thing that catches a header-level change (reschedule, cancellation)
   * on an old estimate quickly, rather than waiting for the crawler to reach it.
   *
   * **This covers the HOT zone only** — the newest `ESTIMATE_HOT_PAGES` pages.
   * Everything older is `crawlEstimates`, because the measured change rate never
   * decays to zero: a 2017 estimate is as likely to change in a given month as a
   * 2024 one (~2% vs ~3%). A window of any width leaves that uncovered.
   */
  async listEstimates({ sinceDays }: { sinceDays: number }): Promise<HcpEstimateDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;

    // An explicit backfill (`sinceDays` passed by hand) still widens the hot zone
    // rather than narrowing it — a caller asking for 365 days wants 365 days of
    // estimates re-derived, not whatever the hot page count happens to reach.
    const hotPages = Math.max(ESTIMATE_HOT_PAGES, Math.ceil(sinceDays / 12));
    const ceiling = pageCeilingFor(sinceDays);

    const [byUpdated, byCreated] = await Promise.all([
      this.paginate(
        cfg,
        "/estimates",
        "estimates",
        { sort_by: "updated_at", sort_direction: "desc" },
        cutoff,
        undefined,
        ceiling,
      ),
      // No date cutoff: the hot zone is a fixed page count. Early-stopping on a
      // timestamp here is exactly what broke this sync — the field it would stop
      // on does not move when an option is approved.
      this.paginateFixed(
        cfg,
        "/estimates",
        "estimates",
        { sort_by: "created_at", sort_direction: "desc" },
        hotPages,
      ),
    ]);

    // The two passes overlap heavily; keep one row per id.
    const merged = new Map<string, Record<string, unknown>>();
    for (const r of [...byUpdated, ...byCreated]) merged.set(String(r.id), r);
    return [...merged.values()].map(mapEstimate);
  }

  /**
   * The COLD zone: a cursor that walks every estimate in the account, a few pages
   * per run, and wraps forever.
   *
   * Why a crawler rather than a wider window. HCP offers no server-side `updated_at`
   * filter (verified 2026-08-15: `updated_at[gte]`, `updated_at_min`,
   * `updated_at_after`, `modified_since` and `since` all return the full 15,247 rows,
   * identical to a parameter invented for the test, against a `scheduled_start_min`
   * control that returns 47 — HCP silently ignores unknown query params). Options are
   * not listable or sortable in their own right (`sort_by=options.updated_at` →
   * "You may not sort by"), and there is no change feed. So the only way to learn that
   * an old estimate moved is to read it.
   *
   * And old estimates do move: sampling creation cohorts across 2017–2026, every
   * cohort had ~1–3% of its rows touched in the last 30 days, flat all the way back —
   * the 2017 cohort's most recent touch was two days before this was written. Across
   * ~10,000 aged estimates that is 100–300 changes a month.
   *
   * **Ascending, deliberately.** `created_at` is immutable, so new estimates append
   * at the END and a page cursor is stable across runs. Crawling descending while
   * rows are inserted at the front shifts records between pages mid-pass and skips
   * them silently. Verified: 0 ordering inversions and 0 exact-timestamp ties across
   * a 200-row page, and deep pagination works to the last page (page 77 returns the
   * tail, 78 is empty — no offset cap).
   *
   * Pages are ~7s each, so the per-run page count is what keeps this inside the job's
   * timeout: a full 77-page pass is ~9 minutes, against a 10-minute budget shared with
   * customers and jobs. That is why this is a cursor and not a nightly full sweep.
   */
  /**
   * The shared cold-zone walk: read `pages` pages of a collection from `startPage`,
   * ascending on `created_at`, and report where to resume.
   *
   * Ascending is the load-bearing part, for every collection. `created_at` is
   * immutable, so new rows append at the END and a page cursor stays valid across
   * runs; crawling descending while rows are inserted at the front shifts records
   * between pages mid-pass and skips them silently.
   *
   * Generic because customers, jobs, estimates and invoices all need this for the
   * same reason — HCP offers no server-side `updated_at` filter on any of them, so
   * no window of any width keeps aged rows in sync — and they should not drift
   * into four subtly different walks.
   */
  private async crawlCollection<T>(
    path: string,
    listKey: string,
    map: (row: Record<string, unknown>) => T,
    { startPage, pages, budgetMs }: { startPage: number; pages: number; budgetMs?: number },
  ): Promise<HcpCrawlPage<T>> {
    const cfg = await this.config();
    const out: Array<Record<string, unknown>> = [];
    const deadline = budgetMs == null ? null : Date.now() + budgetMs;
    let page = Math.max(1, startPage);
    let wrapped = false;
    let totalItems: number | null = null;

    for (let i = 0; i < pages; i++) {
      // `budgetMs` turns the page count into a ceiling rather than the schedule.
      // A cold start wants to read as much as it can inside one run; steady state
      // wants a couple of pages. Checked BEFORE the request so the budget bounds
      // wall time rather than being discovered after overshooting it.
      if (deadline != null && i > 0 && Date.now() >= deadline) break;
      const body = await this.get<Record<string, unknown>>(cfg, path, {
        page,
        page_size: HCP_MAX_PAGE_SIZE,
        sort_by: "created_at",
        sort_direction: "asc",
      });
      const items = (body[listKey] as Array<Record<string, unknown>>) ?? [];
      // `total_items` rides along on every response and is the authority for the
      // reconciliation check. Read from the LAST page fetched so a pass records the
      // freshest count it saw.
      if (typeof body.total_items === "number") totalItems = body.total_items;

      if (items.length === 0) {
        // Ran off the end: the pass is complete. Wrap to the start rather than
        // stalling, and let the caller record the completed pass.
        wrapped = true;
        page = 1;
        break;
      }
      out.push(...items);
      page++;
    }

    return { rows: out.map(map), nextPage: page, wrapped, totalItems };
  }

  async crawlEstimates(opts: { startPage: number; pages: number; budgetMs?: number }): Promise<HcpEstimateCrawlPage> {
    const page = await this.crawlCollection("/estimates", "estimates", mapEstimate, opts);
    // Keeps its own named field rather than the generic `rows`: this shape predates
    // the generic walk and `lib/sync/hcp.ts` reads `.estimates`.
    return {
      estimates: page.rows,
      nextPage: page.nextPage,
      wrapped: page.wrapped,
      totalItems: page.totalItems,
    };
  }

  crawlCustomers(opts: { startPage: number; pages: number; budgetMs?: number }): Promise<HcpCrawlPage<HcpCustomerDTO>> {
    return this.crawlCollection("/customers", "customers", mapCustomer, opts);
  }

  crawlJobs(opts: { startPage: number; pages: number; budgetMs?: number }): Promise<HcpCrawlPage<HcpJobDTO>> {
    return this.crawlCollection("/jobs", "jobs", mapJob, opts);
  }

  crawlInvoices(opts: { startPage: number; pages: number; budgetMs?: number }): Promise<HcpCrawlPage<HcpInvoiceDTO>> {
    return this.crawlCollection("/invoices", "invoices", mapInvoice, opts);
  }

  /**
   * The invoice HOT zone: the most recently touched invoices, every run.
   *
   * Ordered `updated_at desc` so a payment landing on a months-old invoice is seen
   * within the hour — but read as a FIXED page count, because the rows carry no
   * timestamp to stop on (see `INVOICE_HOT_PAGES`). An explicit `sinceDays` widens
   * the zone rather than narrowing it: a caller asking for a backfill wants more
   * invoices re-read, not fewer.
   *
   * ~3.2 invoices/day at current volume ≈ 62 days per 200-row page; the /30 divisor
   * deliberately over-reads rather than risking a short pull.
   */
  async listInvoices({ sinceDays }: { sinceDays: number }): Promise<HcpInvoiceDTO[]> {
    const cfg = await this.config();
    const hotPages = Math.max(INVOICE_HOT_PAGES, Math.ceil(sinceDays / 30));
    const rows = await this.paginateFixed(
      cfg,
      "/invoices",
      "invoices",
      { sort_by: "updated_at", sort_direction: "desc" },
      hotPages,
    );
    return rows.map(mapInvoice);
  }
}

function cents(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseDate(v: unknown): Date | null {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function estimateOptions(e: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(e.options) ? (e.options as Array<Record<string, unknown>>) : [];
}

/**
 * When this estimate last actually changed — the newest of the header's own
 * `updated_at` and every option's.
 *
 * The estimate's `updated_at` alone is not that: pricing and approval move only
 * the option (see `listEstimates`), so an approved estimate routinely reports a
 * header timestamp equal to its `created_at`. Anything asking "has this changed
 * since we last looked?" — the aged-estimate filter here, and
 * `hcp_estimates.updated_at_hcp`, which is what `attribution.run` re-scans on —
 * has to read the options or it will answer "no" to every approval there is.
 */
function estimateTouchedAt(e: Record<string, unknown>): Date | null {
  const times = [
    parseDate(e.updated_at ?? e.updated_at_iso),
    ...estimateOptions(e).map((o) => parseDate(o.updated_at)),
  ].filter((d): d is Date => d != null);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

function mapCustomer(c: Record<string, unknown>): HcpCustomerDTO {
  return {
    hcpCustomerId: String(c.id),
    firstName: (c.first_name as string) ?? null,
    lastName: (c.last_name as string) ?? null,
    email: (c.email as string) ?? null,
    phone: (c.home_number as string) ?? (c.work_number as string) ?? null,
    mobile: (c.mobile_number as string) ?? null,
    // All of them, not just the winner of the ?? chain — see hcp_customers.phones_e164.
    phones: [c.mobile_number, c.home_number, c.work_number].filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    ),
    addresses: c.addresses ?? null,
    createdAtHcp: parseDate(c.created_at),
    updatedAtHcp: parseDate(c.updated_at ?? c.updated_at_iso),
    raw: c,
  };
}

function mapJob(j: Record<string, unknown>): HcpJobDTO {
  const customer = j.customer as Record<string, unknown> | undefined;
  const timestamps = (j.work_timestamps as Record<string, unknown> | undefined) ?? {};
  const fields = (j.job_fields as Record<string, unknown> | undefined) ?? {};
  const jobType = fields.job_type as Record<string, unknown> | string | null | undefined;
  return {
    hcpJobId: String(j.id),
    hcpCustomerId: customer?.id ? String(customer.id) : (j.customer_id ? String(j.customer_id) : null),
    workStatus: (j.work_status as string) ?? null,
    scheduledStart: parseDate((j.schedule as Record<string, unknown>)?.scheduled_start ?? j.scheduled_start),
    totalAmountCents: cents(j.total_amount),
    subtotalCents: cents(j.subtotal ?? j.total_amount),
    outstandingBalanceCents: cents(j.outstanding_balance),
    // NOTE: no `invoiceTotalCents` here on purpose. /jobs carries no `invoice_total`,
    // so the old `j.invoice_total ?? j.total_amount` only ever produced a copy of
    // the quote. The real figure is rolled up from `hcp_invoices` after the sync.
    invoiceNumber: (j.invoice_number as string) ?? null,
    description: (j.description as string) ?? null,
    completedAtHcp: parseDate(timestamps.completed_at),
    canceledAtHcp: parseDate(j.canceled_at),
    deletedAtHcp: parseDate(j.deleted_at),
    updatedAtHcp: parseDate(j.updated_at ?? j.updated_at_iso),
    // `job_type` is an object ({id, name}) on some payloads and a bare string on
    // others; take the name either way rather than stringifying an object into the
    // column as "[object Object]".
    jobType:
      typeof jobType === "string"
        ? jobType
        : ((jobType as Record<string, unknown> | null | undefined)?.name as string) ?? null,
    // Tags come back as plain name strings on the job (they are SET by tag_id — the
    // two vocabularies do not match; `list_tags` is the only bridge).
    tags: Array.isArray(j.tags) ? (j.tags as unknown[]).map(String) : null,
    assignedEmployees: j.assigned_employees ?? null,
    // ⚠️ OPTION ids (`est_…`), not estimate ids (`csr_…`) — see the schema comment
    // on `hcpJobs.estimateOptionIds`. Falls back to the singular field, which holds
    // the same kind of value.
    estimateOptionIds: Array.isArray(j.original_estimate_uuids)
      ? (j.original_estimate_uuids as unknown[]).map(String)
      : j.original_estimate_id
        ? [String(j.original_estimate_id)]
        : null,
    leadSourceRaw: (j.lead_source as string) ?? null,
    address: j.address ?? null,
    createdAtHcp: parseDate(j.created_at),
    raw: j,
  };
}

/** Rows of `{amount}` objects, summed defensively. */
function sumAmounts(v: unknown, keep: (row: Record<string, unknown>) => boolean = () => true): number {
  if (!Array.isArray(v)) return 0;
  return (v as Array<Record<string, unknown>>).reduce((total, row) => {
    if (!row || typeof row !== "object" || !keep(row)) return total;
    return total + cents(row.amount);
  }, 0);
}

/** A payment/refund line HCP actually put through. The live vocabulary is
 *  `succeeded` | `failed` (verified across 200 invoices, 2026-08-25); anything
 *  unrecognised is excluded, so an unknown future state cannot inflate collections. */
const isSucceeded = (row: Record<string, unknown>): boolean =>
  String(row.status ?? "").toLowerCase() === "succeeded";

function mapInvoice(i: Record<string, unknown>): HcpInvoiceDTO {
  const payments = Array.isArray(i.payments) ? (i.payments as Array<Record<string, unknown>>) : [];
  return {
    hcpInvoiceId: String(i.id),
    invoiceNumber: (i.invoice_number as string) ?? null,
    // The ONLY link the invoice payload carries — there is no customer on it.
    hcpJobIdHcp: i.job_id ? String(i.job_id) : null,
    status: (i.status as string) ?? null,
    amountCents: cents(i.amount),
    subtotalCents: cents(i.subtotal ?? i.amount),
    dueAmountCents: cents(i.due_amount),
    paidAmountCents: sumAmounts(i.payments, isSucceeded),
    refundedAmountCents: sumAmounts(i.refunds, isSucceeded),
    taxAmountCents: sumAmounts(i.taxes),
    // HCP reports discounts as NEGATIVE amounts; stored as a positive magnitude so
    // the column reads the way it is displayed ("Discounts: $700").
    discountAmountCents: Math.abs(sumAmounts(i.discounts)),
    paymentMethods: payments.length
      ? [...new Set(payments.map((p) => p.payment_method).filter((m): m is string => typeof m === "string"))]
      : null,
    invoiceDate: parseDate(i.invoice_date),
    serviceDate: parseDate(i.service_date),
    dueAt: parseDate(i.due_at),
    paidAt: parseDate(i.paid_at),
    sentAt: parseDate(i.sent_at),
    items: i.items ?? null,
    taxes: i.taxes ?? null,
    discounts: i.discounts ?? null,
    payments: i.payments ?? null,
    refunds: i.refunds ?? null,
    raw: i,
  };
}

/**
 * Live `approval_status` vocabulary (verified against the full account 2026-07-11):
 * positive = "approved" | "pro approved"; negative = "declined" | "pro declined" |
 * "expired"; null = no decision recorded. Estimate-level `work_status` never carries
 * an approval signal — the decision lives only on the options.
 */
const APPROVED_STATUSES = new Set(["approved", "pro approved"]);
const LOST_STATUSES = new Set(["declined", "pro declined", "expired"]);

/**
 * Map an HCP estimate. Outcome rule (Justin's reporting rule, 2026-07-11) reads the
 * `approval_status` of every option:
 *   won  — at least one option is approved/pro approved
 *   lost — every option that HAS a status is declined/pro declined/expired
 *   open — everything else (no statuses yet, or a mix)
 * The ROI revenue figure is the sum of the approved option amounts. Defensive across
 * field-name variants — `raw` is retained.
 */
function mapEstimate(e: Record<string, unknown>): HcpEstimateDTO {
  const customer = e.customer as Record<string, unknown> | undefined;
  const options = estimateOptions(e);

  const approvalOf = (o: Record<string, unknown>) => String(o.approval_status ?? "").trim().toLowerCase();
  const optAmount = (o: Record<string, unknown>) => cents(o.total_amount ?? o.total ?? o.amount);

  const statuses = options.map(approvalOf).filter((s) => s !== "" && s !== "null");
  const won = statuses.some((s) => APPROVED_STATUSES.has(s));
  const lost = !won && statuses.length > 0 && statuses.every((s) => LOST_STATUSES.has(s));
  const outcome = won ? "won" : lost ? "lost" : "open";

  const approvedOptions = options.filter((o) => APPROVED_STATUSES.has(approvalOf(o)));
  const approvedAmountCents = approvedOptions.reduce((sum, o) => sum + optAmount(o), 0);
  // Approval time, best available. HCP exposes no dedicated approval timestamp on
  // an option (`approved_at` / `approval_status_updated_at` are not in the payload
  // — kept here only in case they appear), so the real signal is the option's own
  // `updated_at`: approval is normally the last thing that happens to an option,
  // and it is the ONLY field that moves at all when one is approved. The estimate's
  // `updated_at` stays as a final fallback but is nearly worthless for this — on an
  // approved estimate it usually still equals `created_at`. Downstream this is
  // display/conversion-timing only (the attribution window is clamped to
  // created_at_hcp, never to this).
  const approvedAt =
    approvedOptions
      .map((o) => parseDate(o.approved_at ?? o.approval_status_updated_at ?? o.updated_at))
      .filter((d): d is Date => d != null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  // Quote value = the HIGHEST-value option, not the sum: multiple options are usually
  // alternative bids for the same work, so summing overstates the quote (Justin,
  // 2026-07-13). Approved revenue still sums, since multi-approval means add-ons.
  const totalAmountCents =
    e.total_amount != null ? cents(e.total_amount) : options.reduce((max, o) => Math.max(max, optAmount(o)), 0);

  const custName = [customer?.first_name, customer?.last_name].filter(Boolean).join(" ") || null;
  return {
    hcpEstimateId: String(e.id),
    hcpCustomerId: customer?.id ? String(customer.id) : e.customer_id ? String(e.customer_id) : null,
    customerPhone:
      (customer?.mobile_number as string) ?? (customer?.home_number as string) ?? (customer?.work_number as string) ?? null,
    customerEmail: (customer?.email as string) ?? null,
    customerName: custName,
    status: (e.work_status as string) ?? (e.status as string) ?? null,
    won,
    outcome,
    totalAmountCents,
    approvedAmountCents,
    options,
    leadSourceRaw: (e.lead_source as string) ?? null,
    address: e.address ?? null,
    createdAtHcp: parseDate(e.created_at),
    // The booked estimate visit. Only present once the office puts it on the
    // calendar — 29% of estimates never get one (cancelled, or still "needs
    // scheduling"), so a null here is meaningful, not missing data.
    scheduledStartHcp: parseDate((e.schedule as Record<string, unknown>)?.scheduled_start),
    approvedAtHcp: won ? approvedAt ?? parseDate(e.updated_at ?? e.created_at) : null,
    // Option-aware, so `attribution.run`'s `updated_at_hcp >= lookback` arm actually
    // fires on a late approval. Reading the header alone left an approved estimate
    // reporting its creation time, so the one pass that could have re-derived the
    // lead skipped it.
    updatedAtHcp: estimateTouchedAt(e) ?? parseDate(e.created_at),
    raw: e,
  };
}

export const housecallpro = new HousecallProProvider();

/**
 * Report the SHAPE of one row from an HCP list endpoint — which fields exist, and
 * which of them are usable as a sync window.
 *
 * This exists because `/jobs` returns no parseable `updated_at`, which silently
 * turned an incremental pull into a full-history one, and the only way to learn
 * the real field names was reading container logs. Answering the question
 * directly is better than shipping a way to read logs over HTTP: logs carry
 * arbitrary content — customer phone numbers and addresses in error context,
 * access tokens that ride in Graph query strings — and none of that belongs
 * behind a bearer token.
 *
 * So: field NAMES, plus values only for fields that parse as a date. A timestamp
 * identifies nothing about a customer; a name or an address would.
 */
export async function probeHcpShape(
  path: "/jobs" | "/customers" | "/estimates",
): Promise<{
  path: string;
  sampled: number;
  keys: string[];
  dateFields: Array<{ key: string; sample: string }>;
  windowable: string[];
}> {
  const c = await getPlatformCreds("housecallpro");
  if (!c.api_key) throw new Error("HousecallPro API key is not configured");
  const base = c.api_base || env.HCP_API_BASE;
  const listKey = path.slice(1); // "/jobs" -> "jobs"

  const url = new URL(path, base);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "1");
  const res = await fetchWithRetry(
    url,
    { headers: { Authorization: `Token ${c.api_key}`, Accept: "application/json" } },
    { timeoutMs: 30_000 },
  );
  if (!res.ok) throw new Error(`HCP ${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);

  const body = (await res.json()) as Record<string, unknown>;
  const items =
    (body[listKey] as Array<Record<string, unknown>>) ?? (body.data as Array<Record<string, unknown>>) ?? [];
  const row = items[0];
  if (!row) return { path, sampled: 0, keys: [], dateFields: [], windowable: [] };

  // Require an ISO-8601-shaped value, not merely something `new Date()` accepts.
  // "Parses as a date" is far too loose to be a redaction rule: a free-text field
  // like `notes: "Gate code 4417"` parses (year 4417) and would echo the gate code
  // back in the sample. Matching the actual timestamp shape means only genuine
  // date fields are ever quoted.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const dateFields: Array<{ key: string; sample: string }> = [];
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== "string" || !ISO_DATE.test(v)) continue;
    const d = parseDate(v);
    if (d) dateFields.push({ key: k, sample: d.toISOString() });
  }

  return {
    path,
    sampled: items.length,
    keys: Object.keys(row).sort(),
    dateFields,
    // What the sync could legitimately window on, in preference order.
    windowable: ["updated_at", "updated_at_iso", "created_at"].filter((k) => dateFields.some((d) => d.key === k)),
  };
}
