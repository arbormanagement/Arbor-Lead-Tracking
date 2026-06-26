import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpJobs } from "@/lib/db/schema";
import { revenueProvider } from "@/lib/integrations";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { withSyncRun } from "./run";

/**
 * hcp.sync.jobs — pull recently-updated HousecallPro customers + jobs and upsert
 * them. Customers carry normalized phone/email (phone_e164 / email_lc) so the
 * attribution engine can match leads → customers → job revenue. HCP amounts are
 * already in cents.
 */
export async function syncHcp({ sinceDays = 30 }: { sinceDays?: number } = {}) {
  return withSyncRun("hcp.sync.jobs", async () => {
    const provider = revenueProvider();
    if (!provider) return { skipped: "HCP_API_KEY not set", customers: 0, jobs: 0 };

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

    return { customers: customers.length, jobs: jobs.length };
  });
}
