/**
 * The Arbor-Automations data import — shared by the CLI script
 * (`npm run db:import-automations`) and the admin route
 * (`POST /api/admin/import-automations`). The route exists for the same reason
 * `reclassify-sources` has one: neither Postgres has a public TCP proxy, so the
 * only place both databases are reachable is the web service itself (the OLD
 * one via a temporary Railway TCP proxy created for the cutover and deleted
 * after).
 *
 * Idempotent AND state-advancing — see the header of
 * scripts/import-automations-db.ts for the exact semantics; the slice 4 cutover
 * depends on the re-run refreshing rows the old app progressed between runs.
 */
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "@/lib/db/client";
import { catchupTexts, reviewRequests } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/phone";

interface OldReviewRequest {
  id: string;
  tracking_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  invoice_id: string;
  county: string;
  review_url: string;
  tracking_url: string;
  clicked: string;
  clicked_at: Date | null;
  sms_sent: string;
  email_sent: string;
  final_sms_sent: string;
  status: string;
  error_message: string | null;
  created_at: Date;
}

interface OldCatchupText {
  id: string;
  review_request_id: string;
  customer_name: string;
  customer_phone: string;
  tracking_id: string;
  tracking_url: string;
  work_month: string;
  scheduled_for: Date;
  status: string;
  error_message: string | null;
  sent_at: Date | null;
  created_at: Date;
}

const bool = (v: string | boolean | null | undefined) => v === true || v === "true";

function mapEmailSent(v: string): string {
  if (v === "true") return "sent";
  if (v === "skipped") return "skipped";
  return "pending";
}


export interface ImportResult {
  apply: boolean;
  sourceReviews: number;
  sourceCatchups: number;
  reviewsUpserted: number;
  catchupsImported: number;
  catchupsSkipped: number;
  rowErrors: string[];
  missingTrackingIds: string[];
  dryRunSample?: Record<string, unknown>;
}

export async function importAutomationsData(opts: { oldUrl: string; apply: boolean }): Promise<ImportResult> {
  const { oldUrl, apply } = opts;
  const old = new Client({ connectionString: oldUrl, ssl: oldUrl.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false } });
  await old.connect();
  let reviews: OldReviewRequest[];
  let catchups: OldCatchupText[];
  try {
    reviews = (await old.query<OldReviewRequest>("SELECT * FROM review_requests ORDER BY created_at")).rows;
    catchups = (await old.query<OldCatchupText>("SELECT * FROM catchup_texts ORDER BY created_at")).rows;
  } finally {
    await old.end();
  }

  const result: ImportResult = {
    apply,
    sourceReviews: reviews.length,
    sourceCatchups: catchups.length,
    reviewsUpserted: 0,
    catchupsImported: 0,
    catchupsSkipped: 0,
    rowErrors: [],
    missingTrackingIds: [],
  };

  if (!apply) {
    const sample = reviews[reviews.length - 1];
    if (sample) {
      result.dryRunSample = {
        trackingId: sample.tracking_id,
        phone: normalizePhone(sample.customer_phone),
        clicked: bool(sample.clicked),
        emailSent: mapEmailSent(sample.email_sent),
        status: sample.status,
      };
    }
    return result;
  }

  for (const r of reviews) {
    const phone = normalizePhone(r.customer_phone);
    try {
      await db
        .insert(reviewRequests)
        .values({
          id: r.id,
          trackingId: r.tracking_id,
          customerName: r.customer_name,
          customerPhoneE164: phone ?? r.customer_phone,
          customerEmail: r.customer_email || null,
          invoiceId: r.invoice_id,
          county: r.county === "stclair" ? "stclair" : "madison",
          reviewUrl: r.review_url,
          trackingUrl: r.tracking_url,
          clicked: bool(r.clicked),
          clickedAt: r.clicked_at,
          smsSent: bool(r.sms_sent),
          emailSent: mapEmailSent(r.email_sent),
          finalSmsSent: bool(r.final_sms_sent),
          status: r.status,
          errorMessage: r.error_message,
          createdAt: r.created_at,
        })
        .onConflictDoUpdate({
          target: reviewRequests.trackingId,
          // State only ever ADVANCES — see the script header.
          set: {
            clicked: sql`${reviewRequests.clicked} OR excluded.clicked`,
            clickedAt: sql`coalesce(${reviewRequests.clickedAt}, excluded.clicked_at)`,
            smsSent: sql`${reviewRequests.smsSent} OR excluded.sms_sent`,
            emailSent: sql`case when excluded.email_sent in ('sent','skipped') then excluded.email_sent else ${reviewRequests.emailSent} end`,
            finalSmsSent: sql`${reviewRequests.finalSmsSent} OR excluded.final_sms_sent`,
            status: sql`case when excluded.status <> 'pending' then excluded.status else ${reviewRequests.status} end`,
            errorMessage: sql`coalesce(excluded.error_message, ${reviewRequests.errorMessage})`,
            updatedAt: sql`now()`,
          },
        });
      result.reviewsUpserted++;
    } catch (err) {
      result.rowErrors.push(`review ${r.tracking_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const c of catchups) {
    const phone = normalizePhone(c.customer_phone);
    try {
      const [row] = await db
        .insert(catchupTexts)
        .values({
          id: c.id,
          reviewRequestId: c.review_request_id,
          customerName: c.customer_name,
          customerPhoneE164: phone ?? c.customer_phone,
          trackingId: c.tracking_id,
          trackingUrl: c.tracking_url,
          workMonth: c.work_month,
          scheduledFor: c.scheduled_for,
          status: c.status,
          errorMessage: c.error_message,
          sentAt: c.sent_at,
          createdAt: c.created_at,
        })
        .onConflictDoNothing()
        .returning({ id: catchupTexts.id });
      if (row) result.catchupsImported++;
      else result.catchupsSkipped++;
    } catch (err) {
      result.rowErrors.push(`catchup ${c.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  for (const r of reviews) {
    const [found] = await db
      .select({ id: reviewRequests.id })
      .from(reviewRequests)
      .where(eq(reviewRequests.trackingId, r.tracking_id))
      .limit(1);
    if (!found) result.missingTrackingIds.push(r.tracking_id);
  }
  return result;
}
