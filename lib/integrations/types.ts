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
  /** Customer approved/accepted at least one option. */
  won: boolean;
  /** Full estimate value (all options). */
  totalAmountCents: number;
  /** Value of the approved option(s) — the ROI revenue figure when won. */
  approvedAmountCents: number;
  address?: unknown;
  createdAtHcp?: Date | null;
  approvedAtHcp?: Date | null;
  raw?: unknown;
}

export interface SpendProvider {
  readonly name: string;
  /** Daily spend across active campaigns for a rolling window (default 7 days). */
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
}
