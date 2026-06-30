import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpEstimates, hcpJobs } from "@/lib/db/schema";
import { revenueProvider } from "@/lib/integrations";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { withSyncRun } from "./run";

/**
 * hcp.sync.jobs — pull recently-updated HousecallPro customers, estimates, and jobs
 * and upsert them. Customers carry normalized phone/email (phone_e164 / email_lc) so
 * the attribution engine can match leads → customers → revenue. ROI revenue is the
 * WON estimate amount (estimates); jobs are kept for completed/invoiced visibility.
 * HCP amounts are already in cents.
 */
export async function syncHcp({ sinceDays = 30 }: { sinceDays?: number } = {}) {
  return withSyncRun("hcp.sync.jobs", async () => {
    const provider = await revenueProvider();
    if (!provider) return { skipped: "HousecallPro credentials not set", customers: 0, jobs: 0 };

    const customers = await provider.listCustomers({ sinceDays });
    for (const c of customers) {
      await db
        .insert(hcpCustomers)
        .values({
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
        })
        .onConflictDoUpdate({
          target: hcpCustomers.hcpCustomerId,
          set: {
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
            updatedAt: new Date(),
          },
        });
    }

    const jobs = await provider.listJobs({ sinceDays });
    for (const j of jobs) {
      // Map the HCP customer id to our internal row id (if we have it synced).
      let internalCustomerId: string | null = null;
      if (j.hcpCustomerId) {
        const [cust] = await db
          .select({ id: hcpCustomers.id })
          .from(hcpCustomers)
          .where(eq(hcpCustomers.hcpCustomerId, j.hcpCustomerId))
          .limit(1);
        internalCustomerId = cust?.id ?? null;
      }

      await db
        .insert(hcpJobs)
        .values({
          hcpJobId: j.hcpJobId,
          hcpCustomerId: internalCustomerId,
          workStatus: j.workStatus,
          scheduledStart: j.scheduledStart,
          totalAmountCents: j.totalAmountCents,
          outstandingBalanceCents: j.outstandingBalanceCents,
          invoiceTotalCents: j.invoiceTotalCents,
          address: j.address,
          createdAtHcp: j.createdAtHcp,
          raw: j.raw,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: hcpJobs.hcpJobId,
          set: {
            hcpCustomerId: internalCustomerId,
            workStatus: j.workStatus,
            scheduledStart: j.scheduledStart,
            totalAmountCents: j.totalAmountCents,
            outstandingBalanceCents: j.outstandingBalanceCents,
            invoiceTotalCents: j.invoiceTotalCents,
            address: j.address,
            raw: j.raw,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }

    const estimates = await provider.listEstimates({ sinceDays });
    for (const e of estimates) {
      let internalCustomerId: string | null = null;
      if (e.hcpCustomerId) {
        const [cust] = await db
          .select({ id: hcpCustomers.id })
          .from(hcpCustomers)
          .where(eq(hcpCustomers.hcpCustomerId, e.hcpCustomerId))
          .limit(1);
        internalCustomerId = cust?.id ?? null;
      }

      await db
        .insert(hcpEstimates)
        .values({
          hcpEstimateId: e.hcpEstimateId,
          hcpCustomerId: internalCustomerId,
          status: e.status,
          won: e.won,
          totalAmountCents: e.totalAmountCents,
          approvedAmountCents: e.approvedAmountCents,
          address: e.address,
          createdAtHcp: e.createdAtHcp,
          approvedAtHcp: e.approvedAtHcp,
          raw: e.raw,
          syncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: hcpEstimates.hcpEstimateId,
          set: {
            hcpCustomerId: internalCustomerId,
            status: e.status,
            won: e.won,
            totalAmountCents: e.totalAmountCents,
            approvedAmountCents: e.approvedAmountCents,
            address: e.address,
            approvedAtHcp: e.approvedAtHcp,
            raw: e.raw,
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        });
    }

    return { customers: customers.length, jobs: jobs.length, estimates: estimates.length };
  });
}
