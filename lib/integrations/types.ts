/**
 * Provider interfaces for the scheduled read path (ad spend + HCP revenue).
 *
 * Decision (2026-06-26): go DIRECT to each platform API rather than routing
 * through the LLM-oriented Arbor MCP gateway — a background sync pipeline needs
 * clean typed data and predictable reliability. Everything that consumes spend
 * or revenue depends only on these interfaces, so any provider can be swapped
 * (including back to an MCP-backed implementation) without touching the
 * attribution/ROI engine.
 */

/** One platform/campaign/day of ad spend. Money in integer cents. */
export interface SpendRow {
  platform: "google" | "google_lsa" | "facebook" | "other";
  externalCampaignId: string;
  campaignName?: string;
  /** ISO date YYYY-MM-DD. */
  date: string;
  impressions: number;
  clicks: number;
  spendCents: number;
  conversions: number;
  raw?: unknown;
}

export interface HcpCustomerDTO {
  hcpCustomerId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  /** Every number on the record (mobile, home, work), unnormalized, in that order. */
  phones?: string[];
  addresses?: unknown;
  createdAtHcp?: Date | null;
  updatedAtHcp?: Date | null;
  raw?: unknown;
}

export interface HcpJobDTO {
  hcpJobId: string;
  hcpCustomerId?: string | null;
  workStatus?: string | null;
  scheduledStart?: Date | null;
  totalAmountCents: number;
  subtotalCents: number;
  outstandingBalanceCents: number;
  invoiceNumber?: string | null;
  description?: string | null;
  /** `work_timestamps.completed_at` — when the crew actually finished. */
  completedAtHcp?: Date | null;
  canceledAtHcp?: Date | null;
  deletedAtHcp?: Date | null;
  updatedAtHcp?: Date | null;
  jobType?: string | null;
  tags?: string[] | null;
  assignedEmployees?: unknown;
  /** `original_estimate_uuids` — OPTION ids (`est_…`), not estimate ids (`csr_…`). */
  estimateOptionIds?: string[] | null;
  /** HCP's `lead_source`. Never usable as attribution — see hcpEstimates.leadSourceRaw. */
  leadSourceRaw?: string | null;
  address?: unknown;
  createdAtHcp?: Date | null;
  raw?: unknown;
}

/**
 * An HCP invoice. What was BILLED — never the ROI revenue event, which stays the
 * won estimate. Invoices carry no customer of their own; `hcpJobIdHcp` is the only
 * link the payload gives, and the customer is resolved through the job.
 *
 * ⚠️ The invoice payload has NO `created_at` or `updated_at` (verified against both
 * the list and the single-invoice endpoint, 2026-08-25) even though both are
 * accepted as `sort_by` values and `created_at_min/max` filter correctly
 * server-side. So an invoice pull can be ORDERED by recency but cannot early-stop
 * on it — which is why the sync reads a fixed hot page count plus a full crawl.
 */
export interface HcpInvoiceDTO {
  hcpInvoiceId: string;
  invoiceNumber?: string | null;
  hcpJobIdHcp?: string | null;
  status?: string | null;
  amountCents: number;
  subtotalCents: number;
  dueAmountCents: number;
  /** Sum of `payments[]` with status `succeeded` — what was collected. */
  paidAmountCents: number;
  refundedAmountCents: number;
  taxAmountCents: number;
  discountAmountCents: number;
  paymentMethods?: string[] | null;
  invoiceDate?: Date | null;
  serviceDate?: Date | null;
  dueAt?: Date | null;
  paidAt?: Date | null;
  sentAt?: Date | null;
  items?: unknown;
  taxes?: unknown;
  discounts?: unknown;
  payments?: unknown;
  refunds?: unknown;
  raw?: unknown;
}

export interface HcpEstimateDTO {
  hcpEstimateId: string;
  hcpCustomerId?: string | null;
  /** Customer contact embedded on the estimate (raw) — normalized at sync for matching. */
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  status?: string | null;
  /** Customer approved/accepted at least one option (outcome === "won"). */
  won: boolean;
  /**
   * Option-approval outcome: won = ≥1 option approved/pro approved; lost = every
   * option that has an approval_status is declined/pro declined/expired; open =
   * everything else (no decisions yet, or a mix).
   */
  outcome: "won" | "lost" | "open";
  /** Quote value — the highest-value option (options are usually alternative bids). */
  totalAmountCents: number;
  /** Value of the approved option(s) — the ROI revenue figure when won. */
  approvedAmountCents: number;
  /** The options array as HCP returns it — stages, amounts and approvals all live here. */
  options?: unknown;
  /** HCP's `lead_source` verbatim. NOT attribution — it records how the record was
   *  entered, not where the customer came from. See the schema comment. */
  leadSourceRaw?: string | null;
  address?: unknown;
  createdAtHcp?: Date | null;
  /** When the estimate VISIT is booked (HCP schedule.scheduled_start). Null until
   *  the office puts it on the calendar, and stays null if it never happens. */
  scheduledStartHcp?: Date | null;
  approvedAtHcp?: Date | null;
  /** HCP's own updated_at — bumps on any change (approval, cancel, price edit). */
  updatedAtHcp?: Date | null;
  raw?: unknown;
}

/**
 * One slice of the cold-zone estimate crawl (see `crawlEstimates`). The cursor is
 * returned rather than held by the provider so it can be persisted — a crawl that
 * forgot its position on every deploy would re-read the oldest pages forever and
 * never reach the newer ones.
 */
/**
 * One slice of a cursor walk over an entire HCP collection. Generic in the row
 * type so customers, jobs, estimates and invoices share one cursor contract —
 * they share one reason for existing (no server-side `updated_at` filter) and one
 * failure mode (a cursor that stalls), so they should not drift apart.
 */
export interface HcpCrawlPage<T> {
  rows: T[];
  /** Page to resume from next run. Resets to 1 when `wrapped`. */
  nextPage: number;
  /** The crawl ran off the end of the collection — a full pass just completed. */
  wrapped: boolean;
  /** The provider's own total count, from the last response seen. */
  totalItems: number | null;
}

export interface HcpEstimateCrawlPage {
  estimates: HcpEstimateDTO[];
  /** Page to resume from next run. Resets to 1 when `wrapped`. */
  nextPage: number;
  /** The crawl ran off the end of the account — a full pass just completed. */
  wrapped: boolean;
  /**
   * The provider's own count of all estimates, as reported on the last response.
   * Stored so `/api/diagnostics` can compare it against our row count without
   * making an upstream call of its own.
   */
  totalItems: number | null;
}

export interface SpendProvider {
  readonly name: string;
  /** ad_spend.platform values this provider writes — used for cold-start detection. */
  readonly platforms: SpendRow["platform"][];
  /** Daily spend across active campaigns for a rolling window. */
  getDailySpend(opts: { sinceDays: number }): Promise<SpendRow[]>;
}

export interface RevenueProvider {
  readonly name: string;
  /** Customers updated within the window (incremental sync). */
  listCustomers(opts: { sinceDays: number }): Promise<HcpCustomerDTO[]>;
  /** Jobs created/updated within the window, with invoice totals folded in. */
  listJobs(opts: { sinceDays: number }): Promise<HcpJobDTO[]>;
  /** Estimates updated within the window, with won/approved amounts folded in. */
  listEstimates(opts: { sinceDays: number }): Promise<HcpEstimateDTO[]>;
  /**
   * The cold zone: a few pages of a cursor walk over the ENTIRE estimate history,
   * resumed from `startPage`. `listEstimates` only covers recent work; this is what
   * keeps estimates older than the hot zone in sync, which no time window can do
   * because the provider's change rate never decays to zero with age.
   */
  crawlEstimates(opts: { startPage: number; pages: number }): Promise<HcpEstimateCrawlPage>;
  /** Invoices ordered newest-touched-first — a fixed page count, because the
   *  payload carries no timestamp to early-stop on. See `HcpInvoiceDTO`. */
  listInvoices(opts: { sinceDays: number }): Promise<HcpInvoiceDTO[]>;
  /** Cold-zone cursor walks. Same contract as `crawlEstimates`, one per collection:
   *  every one of these endpoints lacks a server-side `updated_at` filter, so a
   *  window of any width leaves aged rows uncovered and only a walk closes it. */
  crawlCustomers(opts: { startPage: number; pages: number }): Promise<HcpCrawlPage<HcpCustomerDTO>>;
  crawlJobs(opts: { startPage: number; pages: number }): Promise<HcpCrawlPage<HcpJobDTO>>;
  crawlInvoices(opts: { startPage: number; pages: number }): Promise<HcpCrawlPage<HcpInvoiceDTO>>;
}
