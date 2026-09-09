/**
 * Exercises the review-enrolment repair sweep's candidate SQL against a real
 * Postgres.
 *
 *   npm run verify:review-backfill
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database,
 * never at production. It seeds HCP customers/jobs/invoices and review requests
 * and leaves them behind.
 *
 * This exists because of a specific failure. `findBackfillCandidates` is one
 * `sql` template of pre-filters, none of which `tsc` can see inside, and the
 * first version shipped with `lower(btrim(tag)) = any(${SKIP_TAGS})`. Drizzle
 * binds a JS array as a single UNTYPED parameter, so Postgres got text where it
 * wanted `text[]` and every run died with "op ANY/ALL (array) requires array on
 * right side" — taking the sequencer down with it, because the sweep runs first.
 * It typechecked, it linted, it built, and it was broken on the first tick.
 *
 * So the point of this script is not the assertions so much as the EXECUTION: a
 * query of this shape is only known to work once a real server has run it.
 */
import { like, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpInvoices, hcpJobs, reviewRequests } from "@/lib/db/schema";
import { findBackfillCandidates, BACKFILL_GRACE_MINUTES, BACKFILL_WINDOW_DAYS } from "@/lib/reviews/backfill";

let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

const NOW = Date.now();
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);
const mins = (n: number) => new Date(NOW - n * 60 * 1000);
/** Every row this script writes carries this prefix so it can clear its own
 *  leavings first. Without that, each run's rows accumulate in the scratch
 *  database and the query's `limit` starts cutting the current run's rows off
 *  the end — the suite then fails on its own residue rather than on the code. */
const MARKER = "vrb-";
const TAG = `${MARKER}${ulid().slice(-8)}`;

async function clearPreviousRuns() {
  await db.delete(reviewRequests).where(
    or(like(reviewRequests.invoiceId, `INV-${MARKER}%`), like(reviewRequests.invoiceId, `other-${MARKER}%`)),
  );
  // Children before parents: invoices reference both jobs and customers.
  await db.delete(hcpInvoices).where(like(hcpInvoices.hcpInvoiceId, `invoice_${MARKER}%`));
  await db.delete(hcpJobs).where(like(hcpJobs.hcpJobId, `job_${MARKER}%`));
  await db.delete(hcpCustomers).where(like(hcpCustomers.hcpCustomerId, `cus_${MARKER}%`));
}

/** Seeds one customer + job + invoice and returns the invoice key it should carry. */
async function seed(opts: {
  name: string;
  paidAt?: Date;
  status?: string;
  jobType?: string | null;
  jobTags?: string[];
  customerTags?: string[];
  doNotService?: boolean | null;
  invoiceNumber?: string | null;
  withJob?: boolean;
  tombstoned?: boolean;
}): Promise<{ key: string; hcpCustomerId: string }> {
  const suffix = `${TAG}-${opts.name}`;
  const hcpCustomerId = `cus_${suffix}`;
  const [customer] = await db
    .insert(hcpCustomers)
    .values({
      hcpCustomerId,
      tags: opts.customerTags ?? [],
      doNotService: opts.doNotService === undefined ? null : opts.doNotService,
    })
    .returning({ id: hcpCustomers.id });

  let jobRowId: string | null = null;
  if (opts.withJob !== false) {
    const [job] = await db
      .insert(hcpJobs)
      .values({
        hcpJobId: `job_${suffix}`,
        hcpCustomerId: customer.id,
        jobType: opts.jobType === undefined ? "Tree Service" : opts.jobType,
        tags: opts.jobTags ?? [],
      })
      .returning({ id: hcpJobs.id });
    jobRowId = job.id;
  }

  const invoiceNumber = opts.invoiceNumber === undefined ? `INV-${suffix}` : opts.invoiceNumber;
  await db.insert(hcpInvoices).values({
    hcpInvoiceId: `invoice_${suffix}`,
    invoiceNumber,
    hcpJobId: jobRowId,
    hcpJobIdHcp: opts.withJob === false ? null : `job_${suffix}`,
    hcpCustomerId: customer.id,
    status: opts.status ?? "paid",
    paidAt: opts.paidAt ?? days(3),
    missingFromHcpAt: opts.tombstoned ? new Date() : null,
  });
  return { key: invoiceNumber || `invoice_${suffix}`, hcpCustomerId };
}

async function main() {
  await clearPreviousRuns();

  // ── The happy path, and each pre-filter that must remove a candidate ───────
  const eligible = await seed({ name: "eligible" });
  const noType = await seed({ name: "notype", jobType: null });
  const tooRecent = await seed({ name: "recent", paidAt: mins(BACKFILL_GRACE_MINUTES - 5) });
  const tooOld = await seed({ name: "old", paidAt: days(BACKFILL_WINDOW_DAYS + 1) });
  const unpaid = await seed({ name: "unpaid", status: "open" });
  const stump = await seed({ name: "stump", jobType: "Stump Service" });
  // Casing deliberately unlike the constants: HCP stores what the office typed.
  const phc = await seed({ name: "phc", jobTags: ["Trent Estimate", "PHC Client"] });
  const noFeedback = await seed({ name: "nofeedback", jobTags: ["Matt Estimate", "NO FEEDBACK EMAIL"] });
  const contractor = await seed({ name: "contractor", customerTags: ["Contractor"] });
  const dns = await seed({ name: "dns", doNotService: true });
  const dnsUnknown = await seed({ name: "dnsnull", doNotService: null });
  const tombstoned = await seed({ name: "tombstone", tombstoned: true });
  const noJob = await seed({ name: "nojob", withJob: false });
  const noNumber = await seed({ name: "nonumber", invoiceNumber: null });

  // Already enrolled, keyed on the invoice.
  const enrolled = await seed({ name: "enrolled" });
  await db.insert(reviewRequests).values({
    trackingId: ulid(),
    customerName: "Already Enrolled",
    customerPhoneE164: "+16185550001",
    invoiceId: enrolled.key,
    reviewUrl: "https://g.page/x",
    trackingUrl: "https://app.example.com/track/review?id=x",
  });

  // Already ASKED this customer recently, on a DIFFERENT invoice. This is the
  // guard that joins hcp_customers.hcp_customer_id — the HCP `cus_…` id — and
  // NOT hcp_invoices.hcp_customer_id, which is our ULID foreign key. Comparing
  // those two matches nothing, ever, so this case is the one that proves the
  // guard is actually wired to something.
  const askedRecently = await seed({ name: "asked" });
  await db.insert(reviewRequests).values({
    trackingId: ulid(),
    customerName: "Asked Last Week",
    customerPhoneE164: "+16185550002",
    invoiceId: `other-${TAG}`,
    hcpCustomerId: askedRecently.hcpCustomerId,
    reviewUrl: "https://g.page/x",
    trackingUrl: "https://app.example.com/track/review?id=y",
  });

  const rows = await findBackfillCandidates(NOW);
  const keys = new Set(rows.map((r) => r.invoiceKey));
  const ours = rows.filter((r) => r.invoiceKey.includes(MARKER));

  // The execution itself is the headline assertion: the shipped version could
  // not get this far.
  check("the candidate query runs at all", Array.isArray(rows), true);

  check("eligible invoice is a candidate", keys.has(eligible.key), true);
  check("absent job type does not exclude", keys.has(noType.key), true);
  check("do_not_service NULL does not exclude (three-state)", keys.has(dnsUnknown.key), true);
  check("invoice with no number falls back to its HCP id", keys.has(noNumber.key), true);

  check("inside the grace window is skipped", keys.has(tooRecent.key), false);
  check("outside the 14-day window is skipped", keys.has(tooOld.key), false);
  check("unpaid invoice is skipped", keys.has(unpaid.key), false);
  check("Stump Service is skipped", keys.has(stump.key), false);
  check("job tag 'PHC Client' is skipped (case-insensitive)", keys.has(phc.key), false);
  check("job tag 'NO FEEDBACK EMAIL' is skipped", keys.has(noFeedback.key), false);
  check("customer tag 'Contractor' is skipped", keys.has(contractor.key), false);
  check("do_not_service TRUE is skipped", keys.has(dns.key), false);
  check("tombstoned invoice is skipped", keys.has(tombstoned.key), false);
  check("invoice with no job id is skipped", keys.has(noJob.key), false);
  check("already enrolled on this invoice is skipped", keys.has(enrolled.key), false);
  check("customer asked within 30d is skipped", keys.has(askedRecently.key), false);

  check("exactly the four eligible rows came back", ours.length, 4);

  await clearPreviousRuns();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
