import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { contacts, reviewRequests } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getCustomerById, getJobById } from "@/lib/integrations/housecallpro-write";
import { normalizePhone as toE164 } from "@/lib/phone";
import { determineCounty, getReviewUrl, shouldSkipReview } from "@/lib/reviews/county";
import { resolveContact } from "@/lib/contacts/resolve";
import { webhookAuthorized } from "@/lib/intake/webhook-auth";

export const runtime = "nodejs";

/**
 * HCP invoice.paid → enroll the customer in the review follow-up sequence.
 * Ported from Arbor-Automations at the same path (the merge's slice 4);
 * dormant until the HCP webhook is repointed here. Enrolling only creates a
 * PENDING row — the cron sequencer (`lib/reviews/workflow.ts`, gated by
 * REVIEW_WORKFLOW_ENABLED) is what sends.
 *
 * Ported filters: Tree Service jobs only, SKIP_TAGS on customer or job, one
 * request per invoice+phone (also a unique index now), and no new request
 * within 30 days of a pending one for the same phone.
 *
 * Two gates the old app never had:
 *  - `do_not_service IS TRUE` (read LIVE with the expand — three-state; null
 *    means unknown and does NOT block, matching the flag's semantics elsewhere)
 *  - `contacts.sms_opted_out_at` — a STOP to any tracking number blocks the
 *    sequence up front, recorded as a `suppressed` row so redeliveries settle.
 */
export async function POST(req: Request) {
  if (!webhookAuthorized(req)) return new Response("forbidden", { status: 403 });
  try {
    const body = await req.json().catch(() => ({}));
    const event = body.event;
    console.log(`[review_request] HCP webhook received: event=${event}`);

    if (event !== "invoice.paid") {
      return Response.json({ message: `Ignored event: ${event}` });
    }

    const invoice = body.invoice || {};
    const jobId: string = invoice.job_id || "";
    const invoiceId: string = String(invoice.invoice_number || invoice.id || "");

    if (!jobId) {
      return Response.json({ message: "No job_id, skipping" });
    }
    // An empty invoice id would make (invoice_id, phone) collide across
    // unrelated customers on the unique index — refuse rather than enroll.
    if (!invoiceId) {
      return Response.json({ message: "No invoice id, skipping" });
    }

    const job = await getJobById(jobId);
    if (!job) return Response.json({ message: "Could not fetch job, skipping" });

    if (job.job_type_name && job.job_type_name.toLowerCase() !== "tree service") {
      console.log(`[review_request] skipping job type "${job.job_type_name}" — only Tree Service gets reviews`);
      return Response.json({ message: `Skipped job type: ${job.job_type_name}` });
    }

    const customerId = job.customer_id || "";
    if (!customerId) return Response.json({ message: "No customer_id on job, skipping" });

    const customer = await getCustomerById(customerId);
    if (!customer) return Response.json({ message: "Could not fetch customer, skipping" });

    if (shouldSkipReview(customer.tags ?? [], job.tags ?? [])) {
      console.log(`[review_request] skipping ${customer.first_name} ${customer.last_name} — tag filter`);
      return Response.json({ message: "Skipped due to tag filter" });
    }

    if (customer.do_not_service === true) {
      console.log(`[review_request] skipping ${customer.first_name} ${customer.last_name} — do_not_service`);
      return Response.json({ message: "Skipped: do_not_service" });
    }

    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
    const email = customer.email || "";
    const rawPhone = customer.mobile_number || customer.home_number || customer.work_number || "";
    const phone = toE164(rawPhone);
    if (!phone) {
      console.log(`[review_request] invalid phone for ${customerName}: "${rawPhone}", skipping`);
      return Response.json({ message: "No valid phone number, skipping" });
    }

    // Dedupe: this exact invoice already enrolled (redelivery), or a pending
    // request for this phone within 30 days (several invoices, one ask).
    const [dupe] = await db
      .select({ id: reviewRequests.id })
      .from(reviewRequests)
      .where(and(eq(reviewRequests.invoiceId, invoiceId), eq(reviewRequests.customerPhoneE164, phone)))
      .limit(1);
    if (dupe) return Response.json({ message: "Duplicate event, already processed" });

    const [recentPending] = await db
      .select({ id: reviewRequests.id })
      .from(reviewRequests)
      .where(
        and(
          eq(reviewRequests.customerPhoneE164, phone),
          eq(reviewRequests.status, "pending"),
          gte(reviewRequests.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(desc(reviewRequests.createdAt))
      .limit(1);
    if (recentPending) {
      return Response.json({ message: "Customer already has pending review request" });
    }

    const address = customer.addresses?.[0] ?? {};
    const county = determineCounty(address.city ?? "", address.zip ?? "");
    const reviewUrl = getReviewUrl(county);
    const trackingId = randomUUID();
    const base = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
    const trackingUrl = `${base}/track/review?id=${trackingId}`;

    // Resolve the contact spine up front: threads the sequence, and answers
    // the consent question before a row is even enrolled.
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
    if (!created) return Response.json({ message: "Duplicate event, already processed" });

    console.log(
      `[review_request] created for ${customerName} (${county} county${optedOut ? ", SUPPRESSED — opted out" : ""}), tracking: ${trackingId}`,
    );
    return Response.json({ message: optedOut ? "Review request suppressed (opted out)" : "Review request created", id: created.id });
  } catch (error) {
    console.log(`[review_request] webhook error: ${error instanceof Error ? error.message : error}`);
    return Response.json({ message: "Internal server error" }, { status: 500 });
  }
}
