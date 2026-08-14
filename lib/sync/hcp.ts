import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpEstimates, hcpJobs } from "@/lib/db/schema";
import { revenueProvider } from "@/lib/integrations";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { linkContactsToHcpCustomers } from "@/lib/contacts/link-hcp";
import { incrementalWindowDays, withSyncRun } from "./run";

// Fixed window for jobs (whose server-side scheduled_start filter must stay broad).
const MAX_LOOKBACK_DAYS = 30;
// Cap / initial-backfill window for the history-walking endpoints. 365: the cap
// bounds outage recovery — a longer-than-cap gap would silently lose changes.
// Deep windows stay cheap because the providers early-stop on updated_at.
const MAX_WINDOW_DAYS = 365;

/**
 * hcp.sync.jobs — pull recently-updated HousecallPro customers, estimates, and jobs
 * and upsert them. Customers carry normalized phone/email (phone_e164 / email_lc) so
 * the attribution engine can match leads → customers → revenue. ROI revenue is the
 * WON estimate amount (estimates); jobs are kept for completed/invoiced visibility.
 * HCP amounts are already in cents.
 *
 * Writes are BATCHED (chunked multi-row upserts) — at real account volume a
 * per-record upsert over the HTTP driver is thousands of sequential round-trips and
 * times the function out. Customer-id resolution for jobs/estimates uses a single
 * in-memory map instead of a query per row.
 */
const CHUNK = 100; // rows per multi-row upsert — bounded so the raw jsonb payload stays under the HTTP-driver request limit

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
    if (!provider) return { skipped: "HousecallPro credentials not set", customers: 0, jobs: 0, estimates: 0 };

    // Incremental window for the two endpoints that walk history (no server date
    // filter). Explicit `sinceDays` forces a full backfill.
    //
    // This window is keyed on `updated_at` and is therefore the RIGHT tool for
    // customers and the WRONG one for estimates on its own: HCP does not move an
    // estimate's `updated_at` when an option is priced or approved, so a narrow
    // window here would read every estimate once, at creation, and never see the
    // approval. `listEstimates` compensates with a rolling `created_at` re-read and
    // treats this value as a floor — see the comment there before narrowing it.
    const windowDays =
      sinceDays ?? (await incrementalWindowDays("hcp.sync.jobs", { overlapHours: 2, maxDays: MAX_WINDOW_DAYS }));

    // Fetch the three independent endpoints concurrently — read time is the slowest
    // one, not the sum. (Each still paginates 100/page internally.)
    const [customersRaw, jobsRaw, estimatesRaw] = await Promise.all([
      provider.listCustomers({ sinceDays: windowDays }),
      provider.listJobs({ sinceDays: jobsSinceDays }),
      provider.listEstimates({ sinceDays: windowDays }),
    ]);

    // ── Customers ────────────────────────────────────────────────────────────
    const customers = dedupeBy(customersRaw, (c) => c.hcpCustomerId);
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
            addresses: c.addresses,
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
            addresses: sql`excluded.addresses`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        }),
    );

    // Map HCP customer id → our internal row id, once, for jobs + estimates.
    const custRows = await db
      .select({ hcpId: hcpCustomers.hcpCustomerId, id: hcpCustomers.id })
      .from(hcpCustomers);
    const custMap = new Map(custRows.map((r) => [r.hcpId, r.id]));

    // ── Jobs (completed/invoiced — secondary) ─────────────────────────────────
    const jobs = dedupeBy(jobsRaw, (j) => j.hcpJobId);
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
            outstandingBalanceCents: j.outstandingBalanceCents,
            invoiceTotalCents: j.invoiceTotalCents,
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
            outstandingBalanceCents: sql`excluded.outstanding_balance_cents`,
            invoiceTotalCents: sql`excluded.invoice_total_cents`,
            address: sql`excluded.address`,
            raw: sql`excluded.raw`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        }),
    );

    // ── Estimates (ROI revenue event) ─────────────────────────────────────────
    const estimates = dedupeBy(estimatesRaw, (e) => e.hcpEstimateId);
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
            leadSource: e.leadSource,
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
            leadSource: sql`excluded.lead_source`,
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
        }),
    );

    // Now that customers are fresh, tie inbox threads to them. This is the
    // direction the per-contact lookup can't cover: someone texts as a stranger
    // on Monday and is created in HousecallPro on Tuesday — their thread should
    // start showing their name without them having to text again.
    const { linked } = await linkContactsToHcpCustomers();

    const wonEstimates = estimates.filter((e) => e.won).length;
    const wonValueCents = estimates.filter((e) => e.won).reduce((s, e) => s + (e.approvedAmountCents || 0), 0);
    return {
      customers: customers.length,
      contactsLinked: linked,
      jobs: jobs.length,
      estimates: estimates.length,
      wonEstimates,
      wonValueCents,
      mode: sinceDays == null ? "incremental" : "explicit",
      windowDays: Number(windowDays.toFixed(3)),
    };
  });
}
