import { getPlatformCreds } from "@/lib/credentials";
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

class HousecallProProvider implements RevenueProvider {
  readonly name = "housecallpro:direct";

  private async config(): Promise<HcpConfig> {
    const c = await getPlatformCreds("housecallpro");
    if (!c.api_key) throw new Error("HousecallPro API key is not configured");
    return { apiKey: c.api_key, base: c.api_base || "https://api.housecallpro.com" };
  }

  private async get<T = unknown>(cfg: HcpConfig, path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(path, cfg.base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      headers: {
        Authorization: `Token ${cfg.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HCP ${res.status} ${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * Paginate a newest-first list. `stopOlderThanMs` early-stops the moment a page's
   * last item was updated before the cutoff — so a 30-day sync reads a few pages, not
   * the whole account history (endpoints without a server-side date filter would
   * otherwise walk to the 100-page cap and time the function out).
   */
  private async paginate(
    cfg: HcpConfig,
    path: string,
    listKey: string,
    query: Record<string, string | number> = {},
    stopOlderThanMs?: number,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    const pageSize = 100;
    const MAX_PAGES = 50;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.get<Record<string, unknown>>(cfg, path, { ...query, page, page_size: pageSize });
      const items =
        (body[listKey] as Array<Record<string, unknown>>) ??
        (body.data as Array<Record<string, unknown>>) ??
        [];
      out.push(...items);
      if (items.length < pageSize) break;
      if (stopOlderThanMs != null) {
        const last = items[items.length - 1];
        const u = parseDate(last?.updated_at ?? last?.updated_at_iso);
        if (u && u.getTime() < stopOlderThanMs) break; // sorted desc → the rest is older
      }
    }
    return out;
  }

  async listCustomers({ sinceDays }: { sinceDays: number }): Promise<HcpCustomerDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;
    const rows = await this.paginate(cfg, "/customers", "customers", {
      sort_by: "updated_at",
      sort_direction: "desc",
    }, cutoff);
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
    const min = new Date(cutoff).toISOString();
    const rows = await this.paginate(cfg, "/jobs", "jobs", {
      sort_by: "updated_at",
      sort_direction: "desc",
      scheduled_start_min: min,
    }, cutoff);
    return rows.map(mapJob);
  }

  async listEstimates({ sinceDays }: { sinceDays: number }): Promise<HcpEstimateDTO[]> {
    const cfg = await this.config();
    const cutoff = Date.now() - sinceDays * 86_400_000;
    const rows = await this.paginate(cfg, "/estimates", "estimates", {
      sort_by: "updated_at",
      sort_direction: "desc",
    }, cutoff);
    return rows
      .filter((e) => {
        const updated = parseDate(e.updated_at ?? e.updated_at_iso);
        return !updated || updated.getTime() >= cutoff;
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
 * Map an HCP estimate. "Won" = the customer approved/accepted at least one option;
 * the ROI revenue figure is the sum of the approved option amounts (falling back to
 * the estimate total if HCP reports approval at the estimate level without an option
 * breakdown). Defensive across field-name variants — `raw` is retained.
 */
function mapEstimate(e: Record<string, unknown>): HcpEstimateDTO {
  const customer = e.customer as Record<string, unknown> | undefined;
  const options = Array.isArray(e.options) ? (e.options as Array<Record<string, unknown>>) : [];

  const isApproved = (o: Record<string, unknown>) => {
    const s = String(o.approval_status ?? o.status ?? "").toLowerCase();
    return /(approv|accept|won)/.test(s);
  };
  const optAmount = (o: Record<string, unknown>) => cents(o.total_amount ?? o.total ?? o.amount);

  const approvedFromOptions = options.filter(isApproved).reduce((sum, o) => sum + optAmount(o), 0);
  const totalAmountCents =
    e.total_amount != null ? cents(e.total_amount) : options.reduce((sum, o) => sum + optAmount(o), 0);

  const estStatus = String(e.work_status ?? e.status ?? "").toLowerCase();
  const statusWon = /(approv|accept|won|signed)/.test(estStatus);
  const won = approvedFromOptions > 0 || statusWon;
  // Prefer the approved-option sum; if HCP only flags approval at the estimate level,
  // fall back to the estimate total.
  const approvedAmountCents = approvedFromOptions > 0 ? approvedFromOptions : won ? totalAmountCents : 0;

  return {
    hcpEstimateId: String(e.id),
    hcpCustomerId: customer?.id ? String(customer.id) : e.customer_id ? String(e.customer_id) : null,
    status: (e.work_status as string) ?? (e.status as string) ?? null,
    won,
    totalAmountCents,
    approvedAmountCents,
    address: e.address ?? null,
    createdAtHcp: parseDate(e.created_at),
    approvedAtHcp: won ? parseDate(e.updated_at ?? e.created_at) : null,
    raw: e,
  };
}

export const housecallpro = new HousecallProProvider();
