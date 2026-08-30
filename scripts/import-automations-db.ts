/**
 * One-time import of the live tables from the Arbor-Automations Postgres into
 * this app (the merge's slice 3 — lean-import decision, Justin 2026-08-30:
 * ONLY `review_requests` and `catchup_texts` come over; `service_requests` and
 * `call_summaries` stay in the final pg_dump archive on Drive).
 *
 *   OLD_DATABASE_URL=postgres://... npm run db:import-automations           # dry run
 *   OLD_DATABASE_URL=postgres://... npm run db:import-automations -- --apply
 *
 * The old Railway Postgres has no public TCP proxy by default — create a
 * temporary one (`railway_create_tcp_proxy`, port 5432) for the import and
 * DELETE it afterwards, or run this from inside the project's private network.
 *
 * Idempotent AND state-advancing: reviews upsert on tracking_id, and a re-run
 * REFRESHES step/click state on rows the old app progressed between runs
 * (booleans only ever advance false→true, email_sent 'pending'→'sent'/'skipped',
 * status off 'pending') — so the slice 4 sequence (import → disable old flag →
 * re-import → enable here) cannot leave a stale 'pending' step that would
 * double-send. Old-side state wins only where it is AHEAD; a click recorded on
 * either side sticks. Per-row failures are reported at the end instead of
 * aborting the run (a legacy duplicate on the new invoice+phone unique must not
 * strand the import mid-way). Conversions applied:
 *   - stringly 'true'/'false' → real booleans; email_sent keeps its tri-state
 *     ('false' → 'pending', 'true' → 'sent', 'skipped' → 'skipped')
 *   - bare 10-digit phones → E.164
 *   - old ids are KEPT (both tables' ids are uuids; ULID columns accept them,
 *     and keeping them preserves catchup_texts.review_request_id references)
 */
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "@/lib/db/client";
import { catchupTexts, reviewRequests } from "@/lib/db/schema";
import { normalizePhone } from "@/lib/phone";

const APPLY = process.argv.includes("--apply");

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

async function main() {
  const oldUrl = process.env.OLD_DATABASE_URL;
  if (!oldUrl) throw new Error("OLD_DATABASE_URL must be set (the Arbor-Automations Postgres)");

  const old = new Client({ connectionString: oldUrl, ssl: oldUrl.includes("sslmode=disable") ? undefined : { rejectUnauthorized: false } });
  await old.connect();

  const reviews = (await old.query<OldReviewRequest>("SELECT * FROM review_requests ORDER BY created_at")).rows;
  const catchups = (await old.query<OldCatchupText>("SELECT * FROM catchup_texts ORDER BY created_at")).rows;
  await old.end();

  console.log(`source: ${reviews.length} review_requests, ${catchups.length} catchup_texts`);
  if (!APPLY) {
    const sample = reviews[reviews.length - 1];
    if (sample) {
      console.log("dry run — newest review row would import as:");
      console.log({
        trackingId: sample.tracking_id,
        phone: normalizePhone(sample.customer_phone),
        clicked: bool(sample.clicked),
        emailSent: mapEmailSent(sample.email_sent),
        status: sample.status,
      });
    }
    console.log("pass --apply to write");
    return;
  }

  let reviewsUpserted = 0;
  const rowErrors: string[] = [];
  for (const r of reviews) {
    const phone = normalizePhone(r.customer_phone);
    if (!phone) {
      console.log(`  ! review ${r.tracking_id} has unusable phone "${r.customer_phone}" — importing with raw value`);
    }
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
          // State only ever ADVANCES: the old app progressed this row between
          // imports, or a click landed on either side. Nothing here can regress
          // a step already recorded locally, so a re-run is always safe.
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
      reviewsUpserted++;
    } catch (err) {
      rowErrors.push(`review ${r.tracking_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  let catchupsUpserted = 0;
  let catchupsSkipped = 0;
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
    if (row) catchupsUpserted++;
    else catchupsSkipped++;
    } catch (err) {
      rowErrors.push(`catchup ${c.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`reviews: ${reviewsUpserted} upserted (state-advancing on re-run)`);
  console.log(`catchup: ${catchupsUpserted} imported, ${catchupsSkipped} already present`);
  if (rowErrors.length) {
    console.error(`✗ ${rowErrors.length} row(s) failed:`);
    for (const e of rowErrors.slice(0, 10)) console.error(`   ${e}`);
  }

  // The check that matters: every source tracking id must resolve here.
  const missing: string[] = [];
  for (const r of reviews) {
    const [found] = await db
      .select({ id: reviewRequests.id })
      .from(reviewRequests)
      .where(eq(reviewRequests.trackingId, r.tracking_id))
      .limit(1);
    if (!found) missing.push(r.tracking_id);
  }
  if (missing.length) {
    console.error(`✗ ${missing.length} tracking ids did NOT import: ${missing.slice(0, 5).join(", ")}…`);
    process.exit(1);
  }
  console.log(`✓ all ${reviews.length} tracking ids resolve`);
  if (rowErrors.length) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
