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
  raw?: unknown;
}

export interface HcpJobDTO {
  hcpJobId: string;
  hcpCustomerId?: string | null;
  workStatus?: string | null;
  scheduledStart?: Date | null;
  totalAmountCents: number;
  outstandingBalanceCents: number;
  invoiceTotalCents: number;
  address?: unknown;
  createdAtHcp?: Date | null;
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
}
