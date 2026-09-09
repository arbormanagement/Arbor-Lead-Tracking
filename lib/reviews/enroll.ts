/**
 * Enrolling a customer in the review sequence — ONE implementation, called from
 * two places.
 *
 * The HCP `invoice.paid` webhook is the normal door (`app/api/webhook/
 * review_request`). The repair sweep (`lib/reviews/backfill.ts`) is the other,
 * for the paid invoice whose webhook never arrived. They MUST agree about who
 * is eligible: a sweep with its own copy of the tag/type/consent rules would
 * quietly enrol the people the webhook deliberately skips — PHC clients,
 * `NO FEEDBACK EMAIL` jobs, stump-only work — and each of those is a customer
 * being asked for a review the office decided not to ask for.
 *
 * That is the same failure the cron dispatch table already cost this repo once
 * (two job vocabularies, one missing a case, silent for half an hour), so the
 * eligibility rules live here and the callers only supply an invoice and a job.
 *
 * Reads the job and customer LIVE from HousecallPro rather than from the synced
 * tables, deliberately: `do_not_service` is three-state and only correct with
 * the expand (see `getCustomerById`), and a sweep candidate is by definition a
 * row we may have stale information about.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { resolveContact } from "@/lib/contacts/resolve";
import { contacts, reviewRequests } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getCustomerById, getJobById } from "@/lib/integrations/housecallpro-write";
import { normalizePhone as toE164 } from "@/lib/phone";
import { determineCounty, getReviewUrl, shouldSkipReview } from "@/lib/reviews/county";

/** One ask per person per month, however many invoices they settle in it. */
export const REPEAT_ASK_WINDOW_DAYS = 30;

export type EnrollResult =
  | { status: "enrolled"; id: string; customerName: string; county: string; suppressed: false }
  | { status: "suppressed"; id: string; customerName: string; reason: string }
  | { status: "duplicate"; reason: string }
  | { status: "skipped"; reason: string };

/**
 * Every exit logs which gate it hit.
 *
 * ⚠️ Not decoration. The ported webhook returned 200 and did nothing for two
 * days because `getJobById` read `customer_id` off a payload that has no such
 * key — and a webhook that returns 200 having done nothing is indistinguishable
 * from one with no work to do unless each early return says so.
 */
function skip(reason: string, log: string): EnrollResult {
  console.log(`[review_request] ${log}`);
  return { status: "skipped", reason };
}

export async function enrollReviewRequest(args: {
  /** HousecallPro's own job id (`job_…`), as the invoice payload carries it. */
  jobId: string;
  /** The invoice's human number where it has one, else its `invoice_…` id. The
   *  webhook and the sweep must derive this the SAME way or the (invoice, phone)
   *  unique index stops being a dedupe. */
  invoiceId: string;
  /** Which door this came through — logs only. */
  via: "webhook" | "backfill";
}): Promise<EnrollResult> {
  const { jobId, invoiceId, via } = args;

  const job = await getJobById(jobId);
  if (!job) return skip("job_fetch_failed", `could not fetch job ${jobId} from HCP (${via})`);

  if (job.job_type_name && job.job_type_name.toLowerCase() !== "tree service") {
    return skip(
      "job_type",
      `skipping job type "${job.job_type_name}" — only Tree Service gets reviews (${via})`,
    );
  }

  const customerId = job.customer_id || "";
  if (!customerId) return skip("no_customer", `job ${jobId} has no customer_id (${via})`);

  const customer = await getCustomerById(customerId);
  if (!customer) {
    return skip("customer_fetch_failed", `could not fetch customer ${customerId} from HCP (${via})`);
  }

  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();

  if (shouldSkipReview(customer.tags ?? [], job.tags ?? [])) {
    return skip("tag_filter", `skipping ${customerName} — tag filter (${via})`);
  }
  if (customer.do_not_service === true) {
    return skip("do_not_service", `skipping ${customerName} — do_not_service (${via})`);
  }

  const email = customer.email || "";
  const rawPhone = customer.mobile_number || customer.home_number || customer.work_number || "";
  const phone = toE164(rawPhone);
  if (!phone) {
    return skip("no_phone", `invalid phone for ${customerName}: "${rawPhone}" (${via})`);
  }

  // This exact invoice already enrolled — an HCP redelivery, or the sweep
  // finding a row the webhook handled seconds earlier.
  const [dupe] = await db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.invoiceId, invoiceId), eq(reviewRequests.customerPhoneE164, phone)))
    .limit(1);
  if (dupe) {
    console.log(`[review_request] invoice ${invoiceId} + ${phone} already enrolled (${via})`);
    return { status: "duplicate", reason: "invoice_already_enrolled" };
  }

  /**
   * And no second ask inside the repeat window.
   *
   * ⚠️ The test is "did we already CONTACT them, or are we about to" — a sent
   * first text, or a row still in flight — NOT `status = 'pending'`, which is
   * what it used to be. Two reasons it had to widen: a customer who clicked
   * through and left the review was `completed`, so the next invoice they
   * settled asked them again a week later; and the repair sweep needs a guard
   * that holds even when the invoice key differs (an old row imported from the
   * retired app keys its invoice differently), or a webhook gap would be
   * repaired by re-texting people who were already asked.
   *
   * A row that contacted nobody and is finished (failed before its first send)
   * deliberately does NOT block — there is nothing to be polite about.
   */
  const since = new Date(Date.now() - REPEAT_ASK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: reviewRequests.id, status: reviewRequests.status })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.customerPhoneE164, phone),
        gte(reviewRequests.createdAt, since),
        or(eq(reviewRequests.smsSent, true), eq(reviewRequests.status, "pending")),
      ),
    )
    .orderBy(desc(reviewRequests.createdAt))
    .limit(1);
  if (recent) {
    console.log(
      `[review_request] ${phone} was already asked within ${REPEAT_ASK_WINDOW_DAYS}d ` +
        `(request ${recent.id}, ${recent.status}) — skipping (${via})`,
    );
    return { status: "duplicate", reason: "asked_recently" };
  }

  const address = customer.addresses?.[0] ?? {};
  const county = determineCounty(address.city ?? "", address.zip ?? "");
  const reviewUrl = getReviewUrl(county);
  const trackingId = randomUUID();
  const base = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const trackingUrl = `${base}/track/review?id=${trackingId}`;

  // Resolve the contact spine up front: threads the sequence, and answers the
  // consent question before a row is even enrolled.
  const contact = await resolveContact({ phone, email: email || null, name: customerName || null });
  const optedOut = Boolean(contact?.smsOptedOutAt);

  const [created] = await db
    .insert(reviewRequests)
    .values({
      trackingId,
      customerName: customerName || "Customer",
      customerPhoneE164: phone,
      customerEmail: email || null,
      invoiceId,
      county,
      reviewUrl,
      trackingUrl,
      hcpCustomerId: customerId,
      contactId: contact?.id ?? null,
      status: optedOut ? "suppressed" : "pending",
      errorMessage: optedOut ? "Contact has opted out of SMS (STOP)" : null,
    })
    .onConflictDoNothing({ target: [reviewRequests.invoiceId, reviewRequests.customerPhoneE164] })
    .returning({ id: reviewRequests.id });
  if (!created) {
    console.log(`[review_request] insert lost the race for invoice ${invoiceId} (${via})`);
    return { status: "duplicate", reason: "insert_conflict" };
  }

  if (optedOut) {
    console.log(`[review_request] ${customerName} SUPPRESSED — opted out (${via})`);
    return {
      status: "suppressed",
      id: created.id,
      customerName,
      reason: "Contact has opted out of SMS (STOP)",
    };
  }

  console.log(
    `[review_request] created for ${customerName} (${county} county) via ${via}, tracking: ${trackingId}`,
  );
  return { status: "enrolled", id: created.id, customerName, county, suppressed: false };
}

/**
 * The invoice key, as SQL, so the sweep's "already enrolled?" test cannot drift
 * from what the webhook writes: HCP sends `invoice_number` when it has one and
 * only then falls back to the `invoice_…` id. Getting this wrong would not
 * error — it would just make every swept invoice look un-enrolled.
 */
export function invoiceKeySql(invoiceNumber: PgColumn, hcpInvoiceId: PgColumn) {
  return sql<string>`coalesce(nullif(${invoiceNumber}, ''), ${hcpInvoiceId})`;
}
