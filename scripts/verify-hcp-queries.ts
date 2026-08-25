/**
 * Exercises the HousecallPro query layer and the sync's rollup SQL against a real
 * Postgres, with rows shaped like the live HCP payloads.
 *
 *   npm run verify:hcp
 *
 * ⚠️ WRITES TO THE DATABASE IN `DATABASE_URL`. Point it at a SCRATCH database, never
 * at production. It seeds customers, an estimate, jobs and invoices and leaves them
 * behind.
 *
 * This exists because `tsc` cannot see inside a `sql` template: the money rules here
 * — voided invoices excluded from every total, the job → estimate join going through
 * OPTION ids rather than estimate ids, deleted jobs staying out of the aggregates —
 * are all expressible as valid TypeScript that produces wrong numbers or a runtime
 * SQL error. There is no test runner in this repo; this is the check.
 *
 * Set up a throwaway instance:
 *   initdb -D /var/tmp/pgt/data -U postgres --auth=trust
 *   pg_ctl -D /var/tmp/pgt/data -o "-p 55432" start
 *   createdb -h 127.0.0.1 -p 55432 -U postgres arbor_scratch
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/arbor_scratch npx drizzle-kit push --force
 *   DATABASE_URL=... APP_BASE_URL=http://localhost:3000 ADMIN_EMAIL=a@b.com \
 *     COOKIE_SIGNING_SECRET=0123456789abcdef0123 npm run verify:hcp
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers, hcpEstimates, hcpInvoices, hcpJobs } from "@/lib/db/schema";
import { listCustomers, listInvoices, listJobs } from "@/lib/queries/hcp";

const now = new Date();
const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
let failures = 0;
function check(label: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label} — got ${JSON.stringify(got)}`); }
}

async function main() {
  // ── Seed, shaped exactly like the live HCP payloads sampled 2026-08-25 ──────
  const [cust] = await db.insert(hcpCustomers).values({
    hcpCustomerId: "cus_1", firstName: "Dana", lastName: "Reyes",
    email: "Dana@Example.com", emailLc: "dana@example.com",
    phone: "+16185550100", phoneE164: "+16185550100",
    phonesE164: ["+16185550100", "+16185550199"],
    addresses: [{ street: "12 Oak St", city: "O'Fallon", state: "IL", zip: "62269" }],
    createdAtHcp: days(40), updatedAtHcp: days(2),
  }).returning();

  const [orphan] = await db.insert(hcpCustomers).values({
    hcpCustomerId: "cus_2", firstName: "Sam", lastName: "Vance", createdAtHcp: days(10),
  }).returning();

  const [est] = await db.insert(hcpEstimates).values({
    hcpEstimateId: "csr_1", hcpCustomerId: cust!.id, outcome: "won", won: true,
    totalAmountCents: 280000, approvedAmountCents: 280000, createdAtHcp: days(30),
    scheduledStartHcp: days(28),
    options: [{ id: "est_opt1", approval_status: "approved" }, { id: "est_opt2", approval_status: null }],
  }).returning();

  const [job] = await db.insert(hcpJobs).values({
    hcpJobId: "job_1", hcpCustomerId: cust!.id, workStatus: "complete rated",
    description: "Remove silver maple", invoiceNumber: "10036008",
    totalAmountCents: 280000, subtotalCents: 280000, outstandingBalanceCents: 0,
    createdAtHcp: days(25), scheduledStart: days(20), completedAtHcp: days(18),
    jobType: "Tree Removal", tags: ["Treezilla", "Needs To Be Dry"],
    assignedEmployees: [{ first_name: "Matt", last_name: "Brooks" }, { first_name: "Trent", last_name: "Commer" }],
    estimateOptionIds: ["est_opt1"], leadSourceRaw: "Website",
    address: { street: "12 Oak St", city: "O'Fallon", state: "IL", zip: "62269" },
  }).returning();

  // A deleted job must never appear.
  await db.insert(hcpJobs).values({
    hcpJobId: "job_deleted", hcpCustomerId: cust!.id, createdAtHcp: days(5),
    deletedAtHcp: days(4), totalAmountCents: 999900,
  });

  await db.insert(hcpInvoices).values([
    { hcpInvoiceId: "inv_paid", invoiceNumber: "10036008", hcpJobId: job!.id, hcpJobIdHcp: "job_1",
      hcpCustomerId: cust!.id, status: "paid", amountCents: 180000, subtotalCents: 180000,
      dueAmountCents: 0, paidAmountCents: 180000, taxAmountCents: 3600, discountAmountCents: 70000,
      paymentMethods: ["credit_card"], invoiceDate: days(17), paidAt: days(16),
      items: [{ name: "Tree Removal" }, { name: "Tree Removal" }, { name: "Arborist Notes" }] },
    { hcpInvoiceId: "inv_open", invoiceNumber: "10036008-1", hcpJobId: job!.id, hcpJobIdHcp: "job_1",
      hcpCustomerId: cust!.id, status: "open", amountCents: 100000, subtotalCents: 100000,
      dueAmountCents: 100000, paidAmountCents: 0, invoiceDate: days(10),
      items: [{ name: "Stump Grinding" }] },
    // Voided: must be excluded from every money total.
    { hcpInvoiceId: "inv_void", hcpJobId: job!.id, hcpJobIdHcp: "job_1", hcpCustomerId: cust!.id,
      status: "voided", amountCents: 500000, dueAmountCents: 500000, invoiceDate: days(9) },
    // Arrived before its job was crawled — links are null, self-heal must fix it.
    { hcpInvoiceId: "inv_unlinked", hcpJobIdHcp: "job_1", status: "open",
      amountCents: 25000, dueAmountCents: 25000, invoiceDate: days(3) },
  ]);

  // ── The sync's self-heal + rollup SQL, verbatim ─────────────────────────────
  console.log("\nsync SQL:");
  const relinked = await db.execute(sql`
    UPDATE hcp_invoices AS i
    SET hcp_job_id = j.id, hcp_customer_id = j.hcp_customer_id, updated_at = now()
    FROM hcp_jobs AS j
    WHERE j.hcp_job_id = i.hcp_job_id_hcp
      AND (i.hcp_job_id IS DISTINCT FROM j.id OR i.hcp_customer_id IS DISTINCT FROM j.hcp_customer_id)
  `);
  check("self-heal relinked the orphaned invoice", (relinked.rowCount ?? 0) === 1, relinked.rowCount);

  await db.execute(sql`
    UPDATE hcp_jobs AS j
    SET invoice_total_cents = r.total, invoice_paid_cents = r.paid,
        invoice_due_cents = r.due, invoice_count = r.n, updated_at = now()
    FROM (
      SELECT hcp_job_id AS job_id, sum(amount_cents)::int AS total,
             sum(paid_amount_cents)::int AS paid, sum(due_amount_cents)::int AS due,
             count(*)::int AS n
      FROM hcp_invoices
      WHERE hcp_job_id IS NOT NULL AND coalesce(status, '') NOT IN ('voided', 'canceled')
      GROUP BY hcp_job_id
    ) AS r
    WHERE j.id = r.job_id
      AND (j.invoice_total_cents IS DISTINCT FROM r.total
           OR j.invoice_paid_cents IS DISTINCT FROM r.paid
           OR j.invoice_due_cents IS DISTINCT FROM r.due
           OR j.invoice_count IS DISTINCT FROM r.n)
  `);
  await db.execute(sql`
    UPDATE hcp_jobs AS j
    SET invoice_total_cents = 0, invoice_paid_cents = 0, invoice_due_cents = 0,
        invoice_count = 0, updated_at = now()
    WHERE j.invoice_count > 0
      AND NOT EXISTS (SELECT 1 FROM hcp_invoices AS i
                      WHERE i.hcp_job_id = j.id AND coalesce(i.status, '') NOT IN ('voided', 'canceled'))
  `);

  const [rolled] = await db.select().from(hcpJobs).where(sql`${hcpJobs.hcpJobId} = 'job_1'`);
  // 180000 + 100000 + 25000 = 305000; the 500000 voided invoice must be excluded.
  check("rollup excludes voided invoices", rolled?.invoiceTotalCents === 305000, rolled?.invoiceTotalCents);
  check("rollup collected", rolled?.invoicePaidCents === 180000, rolled?.invoicePaidCents);
  check("rollup due", rolled?.invoiceDueCents === 125000, rolled?.invoiceDueCents);
  check("rollup count", rolled?.invoiceCount === 3, rolled?.invoiceCount);

  // ── listJobs ────────────────────────────────────────────────────────────────
  console.log("\nlistJobs:");
  const jobs = await listJobs({ days: 90 });
  const j0 = jobs.rows[0];
  check("returns the live job only (deleted excluded)", jobs.rows.length === 1, jobs.rows.map((r) => r.hcpJobId));
  check("job → estimate link resolves via option id", j0?.estimateId === est!.id, j0?.estimateId);
  check("job → estimate outcome", j0?.estimateOutcome === "won", j0?.estimateOutcome);
  check("assigned employees joined", j0?.assignedTo === "Matt Brooks, Trent Commer", j0?.assignedTo);
  check("address parts", j0?.city === "O'Fallon" && j0?.zip === "62269", [j0?.city, j0?.zip]);
  check("customer name via join", j0?.customerName === "Dana Reyes", j0?.customerName);
  check("invoice rollup on the row", j0?.invoicedCents === 305000, j0?.invoicedCents);
  check("agg quoted excludes deleted", Number(jobs.agg?.quotedCents) === 280000, jobs.agg?.quotedCents);

  check("dateField=completed windows on completion",
    (await listJobs({ days: 19, dateField: "completed" })).rows.length === 1);
  check("dateField=completed excludes outside window",
    (await listJobs({ days: 5, dateField: "completed" })).rows.length === 0);
  check("tag filter", (await listJobs({ days: 90, filters: { tag: "Treezilla" } })).rows.length === 1);
  check("tag filter misses", (await listJobs({ days: 90, filters: { tag: "Nope" } })).rows.length === 0);
  check("q matches customer", (await listJobs({ days: 90, filters: { q: "Reyes" } })).rows.length === 1);
  check("q matches description", (await listJobs({ days: 90, filters: { q: "silver maple" } })).rows.length === 1);
  check("q matches secondary phone",
    (await listJobs({ days: 90, filters: { q: "5550199" } })).rows.length === 1);
  check("city filter", (await listJobs({ days: 90, filters: { city: "o'fallon" } })).rows.length === 1);
  check("unpaid filter", (await listJobs({ days: 90, filters: { unpaid: true } })).rows.length === 1);
  check("invoiced=false filter", (await listJobs({ days: 90, filters: { invoiced: false } })).rows.length === 0);
  check("jobType filter", (await listJobs({ days: 90, filters: { jobType: "removal" } })).rows.length === 1);
  check("workStatus filter", (await listJobs({ days: 90, filters: { workStatus: "complete rated" } })).rows.length === 1);

  // ── listInvoices ────────────────────────────────────────────────────────────
  console.log("\nlistInvoices:");
  const invs = await listInvoices({ days: 90 });
  check("all four invoices listed", invs.rows.length === 4, invs.rows.length);
  check("billed excludes voided", Number(invs.agg?.billedCents) === 305000, invs.agg?.billedCents);
  check("collected", Number(invs.agg?.collectedCents) === 180000, invs.agg?.collectedCents);
  check("due excludes voided", Number(invs.agg?.dueCents) === 125000, invs.agg?.dueCents);
  check("live count", invs.agg?.live === 3, invs.agg?.live);
  check("unlinked count is 0 after self-heal", invs.agg?.unlinked === 0, invs.agg?.unlinked);
  const paid = invs.rows.find((r) => r.hcpInvoiceId === "inv_paid");
  check("services deduped from line items", paid?.services === "Arborist Notes, Tree Removal", paid?.services);
  check("itemCount", paid?.itemCount === 3, paid?.itemCount);
  check("job join carries work status", paid?.jobWorkStatus === "complete rated", paid?.jobWorkStatus);
  check("status filter", (await listInvoices({ days: 90, filters: { status: "paid" } })).rows.length === 1);
  check("paymentMethod filter",
    (await listInvoices({ days: 90, filters: { paymentMethod: "credit_card" } })).rows.length === 1);
  check("paymentMethod filter misses",
    (await listInvoices({ days: 90, filters: { paymentMethod: "bnpl" } })).rows.length === 0);
  check("unpaid filter", (await listInvoices({ days: 90, filters: { unpaid: true } })).rows.length === 3);
  check("q by invoice number", (await listInvoices({ days: 90, filters: { q: "10036008-1" } })).rows.length === 1);
  check("dateField=paid", (await listInvoices({ days: 90, dateField: "paid" })).rows.length === 1);

  // ── listCustomers ───────────────────────────────────────────────────────────
  console.log("\nlistCustomers:");
  const custs = await listCustomers({});
  check("both customers listed", custs.rows.length === 2, custs.rows.length);
  const c0 = custs.rows.find((r) => r.hcpCustomerId === "cus_1");
  check("name", c0?.name === "Dana Reyes", c0?.name);
  check("city from addresses jsonb", c0?.city === "O'Fallon", c0?.city);
  check("job rollup excludes deleted", c0?.jobCount === 1, c0?.jobCount);
  check("estimate rollup", c0?.estimateCount === 1 && c0?.wonEstimateCount === 1, [c0?.estimateCount, c0?.wonEstimateCount]);
  check("billed rollup excludes voided", c0?.billedCents === 305000, c0?.billedCents);
  check("collected rollup", c0?.collectedCents === 180000, c0?.collectedCents);
  const c1 = custs.rows.find((r) => r.hcpCustomerId === "cus_2");
  check("customer with no activity reads zero", c1?.jobCount === 0 && c1?.billedCents === 0, [c1?.jobCount, c1?.billedCents]);
  check("hasJobs=true filter", (await listCustomers({ filters: { hasJobs: true } })).rows.length === 1);
  check("hasJobs=false filter", (await listCustomers({ filters: { hasJobs: false } })).rows.length === 1);
  check("q filter", (await listCustomers({ filters: { q: "dana@example" } })).rows.length === 1);
  check("city filter", (await listCustomers({ filters: { city: "o'fallon" } })).rows.length === 1);
  check("tracked=false (no contacts linked)", (await listCustomers({ filters: { tracked: false } })).rows.length === 2);
  check("days window", (await listCustomers({ days: 20 })).rows.length === 1, undefined);
  check("paging", (await listCustomers({ limit: 1 })).hasMore === true);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
