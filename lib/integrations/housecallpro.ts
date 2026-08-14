import { getPlatformCreds } from "@/lib/credentials";
import { env } from "@/lib/env";
import { fetchWithRetry } from "./http";
import type { HcpCustomerDTO, HcpEstimateDTO, HcpJobDTO, RevenueProvider } from "./types";

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

/** Floor for the /jobs schedule window. Wide enough that a job scheduled months
 *  ago and completed today still re-syncs — the case a tight window missed — while
 *  keeping the pull bounded server-side. */
const JOBS_MIN_WINDOW_DAYS = 180;

/**
 * How far back `/estimates` is re-read in full on EVERY run, keyed on `created_at`.
 * See `listEstimates` for why an `updated_at` window cannot work here.
 *
 * Sized off the observed decision window: Arbor's estimates settle (approve,
 * decline, or expire) within roughly 30 days of creation — the slowest in the
 * 2026-08-13 sample took 34. 120 days is ~4× that, and matches the 120-day
 * lookback `attribution.run` already scans, so nothing re-read here lands outside
 * the window that would re-derive it. At ~500 estimates/month that is ~2,000 rows
 * (20 pages) per run, against a ceiling of `pageCeilingFor(120)` = 60 — and if
 * volume ever outgrows that, `paginate` fails the run rather than truncating it.
 */
const ESTIMATE_REPULL_DAYS = 120;

/** Page ceiling for a routine pull. 50 pages x 100 = 5,000 rows. */
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
    const pageSize = 100;
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
   * The fix is a rolling re-read keyed on `created_at`, in the same spirit as the
   * spend sync's 35-day re-pull: an estimate young enough to still be in play is
   * re-read on every run, so a decision lands within the hour however it was made.
   * The `updated_at` pass is kept alongside it — it is one page, and it is the only
   * one that catches a header-level change (reschedule, cancellation) on an
   * estimate that has aged out of the re-read window.
   */
  async listEstimates({ sinceDays }: { sinceDays: number }): Promise<HcpEstimateDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;
    // Explicit backfills widen the re-read rather than narrowing it — a caller
    // asking for 365 days wants 365 days of estimates re-derived, not 120.
    const repullMs = Date.now() - Math.max(sinceDays, ESTIMATE_REPULL_DAYS) * 86_400_000;

    const ceiling = pageCeilingFor(Math.max(sinceDays, ESTIMATE_REPULL_DAYS));
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
      this.paginate(
        cfg,
        "/estimates",
        "estimates",
        { sort_by: "created_at", sort_direction: "desc" },
        repullMs,
        (r) => parseDate(r.created_at),
        ceiling,
      ),
    ]);

    // The two passes overlap heavily; keep one row per id.
    const merged = new Map<string, Record<string, unknown>>();
    for (const r of [...byUpdated, ...byCreated]) merged.set(String(r.id), r);

    return [...merged.values()]
      .filter((e) => {
        const created = parseDate(e.created_at);
        // Inside the re-read window: always keep, whatever the timestamps say —
        // this pass exists precisely because they under-report.
        if (created && created.getTime() >= repullMs) return true;
        // Older: keep only if something genuinely moved. `estimateTouchedAt`
        // reads the options too, so a late approval on an aged estimate is not
        // discarded here just because the header stayed still.
        const touched = estimateTouchedAt(e);
        return !touched || touched.getTime() >= cutoff;
      })
      .map(mapEstimate);
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
    addresses: c.addresses ?? null,
    raw: c,
  };
}

function mapJob(j: Record<string, unknown>): HcpJobDTO {
  const customer = j.customer as Record<string, unknown> | undefined;
  return {
    hcpJobId: String(j.id),
    hcpCustomerId: customer?.id ? String(customer.id) : (j.customer_id ? String(j.customer_id) : null),
    workStatus: (j.work_status as string) ?? null,
    scheduledStart: parseDate((j.schedule as Record<string, unknown>)?.scheduled_start ?? j.scheduled_start),
    totalAmountCents: cents(j.total_amount),
    outstandingBalanceCents: cents(j.outstanding_balance),
    invoiceTotalCents: cents(j.invoice_total ?? j.total_amount),
    address: j.address ?? null,
    createdAtHcp: parseDate(j.created_at),
    raw: j,
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
