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
import { CRAWL_INITIAL, advanceCrawl, crawlWindowFor, markCrawlSeen } from "@/lib/sync/hcp";

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
    onMyWayAtHcp: new Date(days(18).getTime() - 2 * 3_600_000),
    startedAtHcp: new Date(days(18).getTime() - 90 * 60_000),
    scheduledEnd: days(20), arrivalWindowMinutes: 240, notes: "Gate code 1234",
    appointments: [
      { id: "appt_1", dispatched_employees_ids: ["pro_matt", "pro_trent"] },
      { id: "appt_2", dispatched_employees_ids: ["pro_matt"] },
    ],
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

  // ── Crawl cursor: pass boundaries ───────────────────────────────────────────
  // Pure logic, but it decides the cutoff that deletion detection depends on — an
  // off-by-one-pass here silently flags every row as missing, or none of them.
  console.log("\ncrawl cursor:");
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-01-01T01:00:00Z");
  const atPageOne = { ...CRAWL_INITIAL, nextPage: 1 };

  const mid = advanceCrawl(atPageOne, { rows: [], nextPage: 30, wrapped: false, totalItems: 100 }, t0);
  check("a lap begun at page 1 records its start", mid.currentLapStartedAt === t0.toISOString(), mid.currentLapStartedAt);
  check("an unfinished lap does not count", mid.passes === 0, mid.passes);
  check("no cutoff until a lap completes", mid.lastFullLapStartedAt === null);

  const done = advanceCrawl(mid, { rows: [], nextPage: 1, wrapped: true, totalItems: 100 }, t1);
  check("wrapping counts the pass", done.passes === 1, done.passes);
  check("cutoff is the lap START, not its end", done.lastFullLapStartedAt === t0.toISOString(), done.lastFullLapStartedAt);
  check("in-flight marker clears on wrap", done.currentLapStartedAt === null);

  // THE REGRESSION. A cursor that joins a lap already in progress — which is what
  // every collection does on the deploy that ships this — has not stamped the pages
  // before it joined, so its wrap must NOT become a cutoff. Shipping without this
  // reported 14,000 of 15,464 estimates as deleted (2026-08-26).
  const joinedMidLap = { ...CRAWL_INITIAL, nextPage: 73, passes: 6 };
  const partial = advanceCrawl(joinedMidLap, { rows: [], nextPage: 79, wrapped: false, totalItems: 100 }, t0);
  check("joining mid-lap records no lap start", partial.currentLapStartedAt === null, partial.currentLapStartedAt);
  const partialWrap = advanceCrawl(partial, { rows: [], nextPage: 1, wrapped: true, totalItems: 100 }, t1);
  check("a mid-lap join publishes NO cutoff on wrap", partialWrap.lastFullLapStartedAt === null, partialWrap.lastFullLapStartedAt);
  check("but it still counts the pass", partialWrap.passes === 7, partialWrap.passes);
  // ...and the lap AFTER it starts at page 1, so detection recovers by itself.
  const recovered = advanceCrawl(partialWrap, { rows: [], nextPage: 20, wrapped: false, totalItems: 100 }, t1);
  check("the next lap from page 1 does record a start", recovered.currentLapStartedAt === t1.toISOString());

  // A stored state written before this field existed must not read as a cutoff.
  const legacy = { nextPage: 1, passes: 3, lastCompletedPassAt: t0.toISOString(), totalItems: 100 } as unknown as typeof CRAWL_INITIAL;
  check("a legacy state publishes no cutoff", legacy.lastFullLapStartedAt === undefined || legacy.lastFullLapStartedAt === null);

  check("cold start reads on a time budget", crawlWindowFor(CRAWL_INITIAL).budgetMs != null);
  check("steady state does not", crawlWindowFor(done).budgetMs === undefined);
  check("steady state is the small page count", crawlWindowFor(done).pages === 2, crawlWindowFor(done).pages);

  // ── Deletion detection ──────────────────────────────────────────────────────
  console.log("\ndeletion detection:");
  const passStart = new Date(Date.now() - 60_000);
  // Two of the three customers are still in HCP, so a pass stamps them...
  await markCrawlSeen("hcp_customers", "hcp_customer_id", ["cus_1", "cus_2"]);
  // ...and one arrived only after the pass began, so it must NOT read as missing.
  await db.insert(hcpCustomers).values({
    hcpCustomerId: "cus_new", firstName: "Brand", lastName: "New", createdAtHcp: days(1),
  });
  // A fourth predates the pass and was never stamped: HCP has dropped it.
  await db.insert(hcpCustomers).values({
    hcpCustomerId: "cus_gone", firstName: "Gone", lastName: "Away", createdAtHcp: days(400),
  });
  await db.execute(sql`UPDATE hcp_customers SET created_at = ${days(400)} WHERE hcp_customer_id = 'cus_gone'`);

  const missing = await db.execute<{ hcp_id: string }>(sql`
    select hcp_customer_id as hcp_id from hcp_customers
    where created_at < ${passStart}
      and (crawl_seen_at is null or crawl_seen_at < ${passStart})
  `);
  const missingIds = (missing.rows ?? []).map((r) => r.hcp_id);
  check("the dropped customer is detected", missingIds.includes("cus_gone"), missingIds);
  check("stamped customers are not flagged", !missingIds.some((id) => id === "cus_1" || id === "cus_2"), missingIds);
  check("a row created after the pass began is not flagged", !missingIds.includes("cus_new"), missingIds);
  check("exactly one missing", missingIds.length === 1, missingIds);

  // Re-stamping clears it — the crawl seeing a row again is what resolves the flag.
  await markCrawlSeen("hcp_customers", "hcp_customer_id", ["cus_gone"]);
  const after = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from hcp_customers
    where created_at < ${passStart} and (crawl_seen_at is null or crawl_seen_at < ${passStart})
  `);
  check("re-seeing a row clears the flag", Number(after.rows?.[0]?.n) === 0, after.rows?.[0]?.n);

  // ── Newly projected job fields ──────────────────────────────────────────────
  console.log("\nprojected job fields:");
  const jrow = (await listJobs({ days: 90 })).rows[0];
  check("on-my-way timestamp surfaces", jrow?.onMyWayAt != null, jrow?.onMyWayAt);
  check("started timestamp surfaces", jrow?.startedAt != null, jrow?.startedAt);
  check("on-site minutes derived", jrow?.onSiteMinutes === 90, jrow?.onSiteMinutes);
  check("arrival window surfaces", jrow?.arrivalWindowMinutes === 240, jrow?.arrivalWindowMinutes);
  check("notes surface", jrow?.notes === "Gate code 1234", jrow?.notes);
  check("appointment count", jrow?.appointmentCount === 2, jrow?.appointmentCount);
  check(
    "dispatched employees deduped across visits",
    JSON.stringify([...(jrow?.dispatchedEmployeeIds ?? [])].sort()) === JSON.stringify(["pro_matt", "pro_trent"]),
    jrow?.dispatchedEmployeeIds,
  );
  // A job with no clock-in must read null, never 0 — "not recorded" is not "instant".
  await db.insert(hcpJobs).values({
    hcpJobId: "job_unclocked", hcpCustomerId: cust!.id, createdAtHcp: days(3), completedAtHcp: days(2),
  });
  const unclocked = (await listJobs({ days: 90 })).rows.find((r) => r.hcpJobId === "job_unclocked");
  check("unclocked job reports null on-site, not 0", unclocked?.onSiteMinutes === null, unclocked?.onSiteMinutes);
  check("job with no expand reports null appointment count", unclocked?.appointmentCount === null, unclocked?.appointmentCount);

  // ── do_not_service: the three-state trap ────────────────────────────────────
  console.log("\ndo_not_service (three-state):");
  await db.insert(hcpCustomers).values([
    { hcpCustomerId: "cus_dns", firstName: "Flagged", lastName: "Person", doNotService: true, createdAtHcp: days(5) },
    { hcpCustomerId: "cus_ok", firstName: "Safe", lastName: "Person", doNotService: false, createdAtHcp: days(5) },
  ]);
  // cus_1 / cus_2 / cus_new / cus_gone were seeded WITHOUT the flag = UNKNOWN.
  const flagged = await listCustomers({ filters: { doNotService: true } });
  const mailable = await listCustomers({ filters: { doNotService: false } });
  check("flagged filter finds only the flagged", flagged.rows.length === 1 && flagged.rows[0]?.hcpCustomerId === "cus_dns", flagged.rows.map((r) => r.hcpCustomerId));
  check(
    "mailable filter excludes UNKNOWN as well as flagged",
    mailable.rows.length === 1 && mailable.rows[0]?.hcpCustomerId === "cus_ok",
    mailable.rows.map((r) => r.hcpCustomerId),
  );
  const allCust = await listCustomers({});
  check("unknown counted separately from not-flagged", (allCust.agg?.doNotServiceUnknown ?? 0) >= 4, allCust.agg?.doNotServiceUnknown);
  check("flagged counted", allCust.agg?.doNotService === 1, allCust.agg?.doNotService);
  check("null survives to the row as null", allCust.rows.find((r) => r.hcpCustomerId === "cus_1")?.doNotService === null);

  // ── Backfill-from-raw, exactly as migration 0042 runs it ────────────────────
  console.log("\nbackfill from raw:");
  await db.insert(hcpJobs).values({
    hcpJobId: "job_raw", hcpCustomerId: cust!.id, createdAtHcp: days(9),
    raw: {
      work_timestamps: { on_my_way_at: "2026-08-01T12:00:00Z", started_at: "2026-08-01T13:00:00Z" },
      schedule: { scheduled_end: "2026-08-01T17:00:00Z", arrival_window: 120 },
      notes: "from raw", job_fields: { job_type: { id: "jbt_x" }, business_unit: null },
      recurrence_number: 3, recurrence_status: "active", recurrence_id: "rec_1", recurrence_rule: null,
    },
  });
  await db.execute(sql`
    UPDATE hcp_jobs SET
      on_my_way_at_hcp = nullif(raw->'work_timestamps'->>'on_my_way_at', '')::timestamptz,
      started_at_hcp = nullif(raw->'work_timestamps'->>'started_at', '')::timestamptz,
      scheduled_end = nullif(raw->'schedule'->>'scheduled_end', '')::timestamptz,
      arrival_window_minutes = CASE WHEN jsonb_typeof(raw->'schedule'->'arrival_window') = 'number'
        THEN (raw->'schedule'->>'arrival_window')::int END,
      notes = nullif(raw->>'notes', ''),
      job_type_id = raw->'job_fields'->'job_type'->>'id',
      business_unit = raw->'job_fields'->>'business_unit',
      recurrence_number = CASE WHEN jsonb_typeof(raw->'recurrence_number') = 'number' THEN (raw->>'recurrence_number')::int END,
      recurrence_rule = CASE WHEN raw->'recurrence_rule' = 'null'::jsonb THEN NULL ELSE raw->'recurrence_rule' END,
      recurrence_status = raw->>'recurrence_status',
      recurrence_id = raw->>'recurrence_id'
    WHERE hcp_job_id = 'job_raw'
  `);
  const [filled] = await db.select().from(hcpJobs).where(sql`${hcpJobs.hcpJobId} = 'job_raw'`);
  check("backfills on-my-way from raw", filled?.onMyWayAtHcp?.toISOString() === "2026-08-01T12:00:00.000Z", filled?.onMyWayAtHcp);
  check("backfills arrival window from raw", filled?.arrivalWindowMinutes === 120, filled?.arrivalWindowMinutes);
  check("backfills notes from raw", filled?.notes === "from raw", filled?.notes);
  check("backfills nested job_type id", filled?.jobTypeId === "jbt_x", filled?.jobTypeId);
  check("JSON null business_unit lands as SQL NULL", filled?.businessUnit === null, filled?.businessUnit);
  check("JSON null recurrence_rule lands as SQL NULL", filled?.recurrenceRule === null, filled?.recurrenceRule);
  check("backfills recurrence number", filled?.recurrenceNumber === 3, filled?.recurrenceNumber);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
