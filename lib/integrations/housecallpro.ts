import { env } from "@/lib/env";
import type { HcpCustomerDTO, HcpJobDTO, RevenueProvider } from "./types";

/**
 * Direct HousecallPro REST client. HCP is the ROI revenue source of truth, so it
 * gets the most reliable path: a plain API-key call, no gateway in between.
 *
 * Auth: HCP API keys use the `Token` scheme. If you get 401s, confirm the header
 * scheme for your key type in the HCP API docs and adjust `authHeader()`.
 * Money: HCP amounts are already in integer cents (per the Arbor playbook).
 *
 * Field mappings are defensive (multiple known key spellings + raw retained) so a
 * minor upstream shape change degrades to nulls rather than throwing mid-sync.
 */
class HousecallProProvider implements RevenueProvider {
  readonly name = "housecallpro:direct";

  private authHeader(): string {
    if (!env.HCP_API_KEY) throw new Error("HCP_API_KEY is not set");
    return `Token ${env.HCP_API_KEY}`;
  }

  private async get<T = unknown>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(path, env.HCP_API_BASE);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`HCP ${res.status} ${path}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** Page through a list endpoint until exhausted or a sane cap is hit. */
  private async paginate(
    path: string,
    listKey: string,
    query: Record<string, string | number> = {},
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    const pageSize = 100;
    for (let page = 1; page <= 100; page++) {
      const body = await this.get<Record<string, unknown>>(path, {
        ...query,
        page,
        page_size: pageSize,
      });
      const items =
        (body[listKey] as Array<Record<string, unknown>>) ??
        (body.data as Array<Record<string, unknown>>) ??
        [];
      out.push(...items);
      if (items.length < pageSize) break;
    }
    return out;
  }

  async listCustomers({ sinceDays }: { sinceDays: number }): Promise<HcpCustomerDTO[]> {
    // Pull recently-updated first; we re-sync a rolling window each run.
    const rows = await this.paginate("/customers", "customers", {
      sort_by: "updated_at",
      sort_direction: "desc",
    });
    const cutoff = Date.now() - sinceDays * 86_400_000;
    return rows
      .filter((c) => {
        const updated = parseDate(c.updated_at ?? c.updated_at_iso);
        return !updated || updated.getTime() >= cutoff;
      })
      .map(mapCustomer);
  }

  async listJobs({ sinceDays }: { sinceDays: number }): Promise<HcpJobDTO[]> {
    const min = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const rows = await this.paginate("/jobs", "jobs", {
      sort_by: "updated_at",
      sort_direction: "desc",
      scheduled_start_min: min,
    });
    return rows.map(mapJob);
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

export const housecallpro = new HousecallProProvider();
