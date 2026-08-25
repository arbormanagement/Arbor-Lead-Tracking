import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  contacts,
  conversations,
  hcpCustomers,
  hcpEstimates,
  hcpInvoices,
  hcpJobs,
} from "@/lib/db/schema";

/**
 * Jobs, invoices and customers — the HousecallPro side of the business, read the
 * same way `lib/queries/estimates.ts` reads the opportunity side.
 *
 * **None of this is ROI revenue.** `roi_daily` is anchored on the won estimate and
 * stays there; these answer the questions an estimate cannot — what was actually
 * DONE (jobs), what was BILLED and COLLECTED (invoices), and who the customer is
 * across all of it. Booked, billed and collected are three different numbers and
 * this module deliberately keeps them apart rather than blending them into one
 * "revenue" figure.
 */

// ── Shared helpers ───────────────────────────────────────────────────────────

/** A jsonb address part, off whichever address shape the row carries. */
const addrPart = (col: typeof hcpJobs.address, part: string): SQL<string | null> =>
  sql<string | null>`${col}->>${part}`;

/**
 * Assigned employees, comma-joined. HCP nests them as
 * `[{first_name, last_name, …}]`; rendering the jsonb raw is unreadable and
 * `->>'name'` does not exist on this shape.
 */
const assignedToSql: SQL<string | null> = sql<string | null>`(
  select nullif(string_agg(trim(concat_ws(' ', e->>'first_name', e->>'last_name')), ', '), '')
  from jsonb_array_elements(
    case when jsonb_typeof(${hcpJobs.assignedEmployees}) = 'array' then ${hcpJobs.assignedEmployees} else '[]'::jsonb end
  ) as e
)`;

/**
 * The estimate a job came from, as a correlated scalar sub-select.
 *
 * ⚠️ `hcp_jobs.estimate_option_ids` holds HCP's `original_estimate_uuids`, which are
 * OPTION ids (`est_…`) — an estimate's own id is `csr_…`. So this matches against
 * `hcp_estimates.options[].id`, never against `hcp_estimate_id`, and leans on the
 * GIN index on `options`. Verified 2026-08-25: GET /estimates/est_… returns 404.
 *
 * This is the link that makes billed work attributable — job → estimate → lead →
 * source. A job can be created from several options at once; any of them identifies
 * the same estimate, so the first match is the answer.
 */
const jobEstimateSql = <T>(column: SQL<T>): SQL<T> => sql<T>`(
  select ${column}
  from unnest(coalesce(${hcpJobs.estimateOptionIds}, '{}'::text[])) as opt
  join ${hcpEstimates} e on e.options @> jsonb_build_array(jsonb_build_object('id', opt))
  limit 1
)`;

/** Free-text match across a customer's name/phone/email. Used by all three lists. */
function customerTextMatch(q: string): SQL {
  const like = `%${q}%`;
  return or(
    ilike(sql`concat_ws(' ', ${hcpCustomers.firstName}, ${hcpCustomers.lastName})`, like),
    ilike(hcpCustomers.emailLc, like),
    ilike(hcpCustomers.phoneE164, like),
    sql`exists (select 1 from unnest(coalesce(${hcpCustomers.phonesE164}, '{}'::text[])) p where p ilike ${like})`,
  )!;
}

const pageOf = <T>(rows: T[], limit: number, offset: number, total: number) => ({
  rows,
  total,
  hasMore: offset + rows.length < total,
  nextOffset: offset + rows.length < total ? offset + rows.length : null,
});

// ── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * Which date the job window runs on. Named rather than assumed, because the three
 * answer different questions and silently picking one is how a "what did we do in
 * July" report ends up counting work that was merely sold in July.
 */
export type JobDateField = "created" | "scheduled" | "completed";

const JOB_DATE_COLUMN = {
  created: hcpJobs.createdAtHcp,
  scheduled: hcpJobs.scheduledStart,
  completed: hcpJobs.completedAtHcp,
} as const;

export interface JobFilters {
  q?: string;
  /** HCP `work_status`, e.g. "complete rated". Filter vocabulary, not the reported one. */
  workStatus?: string;
  city?: string;
  /** A job tag, matched exactly against the name strings HCP reports back. */
  tag?: string;
  jobType?: string;
  /** true = has at least one live invoice; false = none. */
  invoiced?: boolean;
  /** true = money still owed on the job's invoices. */
  unpaid?: boolean;
}

export async function listJobs(opts: {
  days: number;
  dateField?: JobDateField;
  filters?: JobFilters;
  limit?: number;
  offset?: number;
}) {
  const { days, dateField = "created", filters = {}, limit = 50, offset = 0 } = opts;
  const since = new Date(Date.now() - days * 86_400_000);
  const dateCol = JOB_DATE_COLUMN[dateField];

  const conds: (SQL | undefined)[] = [
    gte(dateCol, since),
    // Soft-deleted jobs are still returned by HCP; they are not work.
    isNull(hcpJobs.deletedAtHcp),
  ];
  if (filters.q) conds.push(or(customerTextMatch(filters.q), ilike(hcpJobs.description, `%${filters.q}%`), ilike(hcpJobs.invoiceNumber, `%${filters.q}%`)));
  if (filters.workStatus) conds.push(eq(hcpJobs.workStatus, filters.workStatus));
  if (filters.city) conds.push(ilike(addrPart(hcpJobs.address, "city"), filters.city));
  if (filters.tag) conds.push(sql`${hcpJobs.tags} @> array[${filters.tag}]::text[]`);
  if (filters.jobType) conds.push(ilike(hcpJobs.jobType, `%${filters.jobType}%`));
  if (filters.invoiced != null) {
    conds.push(filters.invoiced ? sql`${hcpJobs.invoiceCount} > 0` : sql`coalesce(${hcpJobs.invoiceCount}, 0) = 0`);
  }
  if (filters.unpaid) conds.push(sql`${hcpJobs.invoiceDueCents} > 0`);
  const scope = and(...conds);

  const rows = await db
    .select({
      id: hcpJobs.id,
      hcpJobId: hcpJobs.hcpJobId,
      invoiceNumber: hcpJobs.invoiceNumber,
      description: hcpJobs.description,
      workStatus: hcpJobs.workStatus,
      jobType: hcpJobs.jobType,
      tags: hcpJobs.tags,
      createdAt: hcpJobs.createdAtHcp,
      scheduledStart: hcpJobs.scheduledStart,
      completedAt: hcpJobs.completedAtHcp,
      canceledAt: hcpJobs.canceledAtHcp,
      totalCents: hcpJobs.totalAmountCents,
      outstandingCents: hcpJobs.outstandingBalanceCents,
      invoicedCents: hcpJobs.invoiceTotalCents,
      collectedCents: hcpJobs.invoicePaidCents,
      dueCents: hcpJobs.invoiceDueCents,
      invoiceCount: hcpJobs.invoiceCount,
      assignedTo: assignedToSql,
      street: addrPart(hcpJobs.address, "street"),
      city: addrPart(hcpJobs.address, "city"),
      state: addrPart(hcpJobs.address, "state"),
      zip: addrPart(hcpJobs.address, "zip"),
      customerId: hcpCustomers.id,
      customerName: sql<string | null>`nullif(trim(concat_ws(' ', ${hcpCustomers.firstName}, ${hcpCustomers.lastName})), '')`,
      customerPhone: hcpCustomers.phoneE164,
      customerEmail: hcpCustomers.emailLc,
      estimateId: jobEstimateSql<string | null>(sql`e.id`),
      estimateOutcome: jobEstimateSql<string | null>(sql`e.outcome`),
      estimateOptionIds: hcpJobs.estimateOptionIds,
      // HCP's own lead_source — NOT attribution. Exposed so nobody has to dig it out
      // of `raw` and conclude it is usable; see the schema note.
      leadSourceRaw: hcpJobs.leadSourceRaw,
    })
    .from(hcpJobs)
    .leftJoin(hcpCustomers, eq(hcpJobs.hcpCustomerId, hcpCustomers.id))
    .where(scope)
    .orderBy(desc(dateCol))
    .limit(limit)
    .offset(offset);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${hcpJobs.completedAtHcp} is not null)::int`,
      canceled: sql<number>`count(*) filter (where ${hcpJobs.canceledAtHcp} is not null)::int`,
      quotedCents: sql<number>`coalesce(sum(${hcpJobs.totalAmountCents}), 0)::bigint`,
      invoicedCents: sql<number>`coalesce(sum(${hcpJobs.invoiceTotalCents}), 0)::bigint`,
      collectedCents: sql<number>`coalesce(sum(${hcpJobs.invoicePaidCents}), 0)::bigint`,
      dueCents: sql<number>`coalesce(sum(${hcpJobs.invoiceDueCents}), 0)::bigint`,
      uninvoiced: sql<number>`count(*) filter (where coalesce(${hcpJobs.invoiceCount}, 0) = 0)::int`,
    })
    .from(hcpJobs)
    .leftJoin(hcpCustomers, eq(hcpJobs.hcpCustomerId, hcpCustomers.id))
    .where(scope);

  return { ...pageOf(rows, limit, offset, agg?.total ?? 0), agg, dateField };
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export type InvoiceDateField = "invoice" | "service" | "paid";

const INVOICE_DATE_COLUMN = {
  invoice: hcpInvoices.invoiceDate,
  service: hcpInvoices.serviceDate,
  paid: hcpInvoices.paidAt,
} as const;

export interface InvoiceFilters {
  q?: string;
  /** open | pending_payment | paid | voided | uncollectible | canceled */
  status?: string;
  /** credit_card | ach | external | mobile_check_deposit | consumer_financing | bnpl */
  paymentMethod?: string;
  /** true = still owed money. */
  unpaid?: boolean;
}

export async function listInvoices(opts: {
  days: number;
  dateField?: InvoiceDateField;
  filters?: InvoiceFilters;
  limit?: number;
  offset?: number;
}) {
  const { days, dateField = "invoice", filters = {}, limit = 50, offset = 0 } = opts;
  const since = new Date(Date.now() - days * 86_400_000);
  const dateCol = INVOICE_DATE_COLUMN[dateField];

  const conds: (SQL | undefined)[] = [gte(dateCol, since)];
  if (filters.q) {
    conds.push(or(customerTextMatch(filters.q), ilike(hcpInvoices.invoiceNumber, `%${filters.q}%`)));
  }
  if (filters.status) conds.push(eq(hcpInvoices.status, filters.status));
  if (filters.paymentMethod) {
    conds.push(sql`${hcpInvoices.paymentMethods} @> array[${filters.paymentMethod}]::text[]`);
  }
  if (filters.unpaid) conds.push(sql`${hcpInvoices.dueAmountCents} > 0`);
  const scope = and(...conds);

  const rows = await db
    .select({
      id: hcpInvoices.id,
      hcpInvoiceId: hcpInvoices.hcpInvoiceId,
      invoiceNumber: hcpInvoices.invoiceNumber,
      status: hcpInvoices.status,
      amountCents: hcpInvoices.amountCents,
      subtotalCents: hcpInvoices.subtotalCents,
      dueCents: hcpInvoices.dueAmountCents,
      paidCents: hcpInvoices.paidAmountCents,
      refundedCents: hcpInvoices.refundedAmountCents,
      taxCents: hcpInvoices.taxAmountCents,
      discountCents: hcpInvoices.discountAmountCents,
      paymentMethods: hcpInvoices.paymentMethods,
      invoiceDate: hcpInvoices.invoiceDate,
      serviceDate: hcpInvoices.serviceDate,
      dueAt: hcpInvoices.dueAt,
      paidAt: hcpInvoices.paidAt,
      sentAt: hcpInvoices.sentAt,
      jobId: hcpInvoices.hcpJobId,
      hcpJobId: hcpInvoices.hcpJobIdHcp,
      jobWorkStatus: hcpJobs.workStatus,
      jobCompletedAt: hcpJobs.completedAtHcp,
      customerId: hcpCustomers.id,
      customerName: sql<string | null>`nullif(trim(concat_ws(' ', ${hcpCustomers.firstName}, ${hcpCustomers.lastName})), '')`,
      customerPhone: hcpCustomers.phoneE164,
      customerEmail: hcpCustomers.emailLc,
      // What was billed for, from the line items — the readable answer to "what is
      // this invoice", without shipping the whole items array.
      services: sql<string | null>`(
        select nullif(string_agg(distinct it->>'name', ', '), '')
        from jsonb_array_elements(
          case when jsonb_typeof(${hcpInvoices.items}) = 'array' then ${hcpInvoices.items} else '[]'::jsonb end
        ) as it
      )`,
      itemCount: sql<number>`(
        case when jsonb_typeof(${hcpInvoices.items}) = 'array' then jsonb_array_length(${hcpInvoices.items}) else 0 end
      )::int`,
    })
    .from(hcpInvoices)
    .leftJoin(hcpJobs, eq(hcpInvoices.hcpJobId, hcpJobs.id))
    .leftJoin(hcpCustomers, eq(hcpInvoices.hcpCustomerId, hcpCustomers.id))
    .where(scope)
    .orderBy(desc(dateCol))
    .limit(limit)
    .offset(offset);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      // Voided/canceled are excluded from every money total: they are not owed and
      // not collected, and a re-issued invoice would otherwise count twice.
      live: sql<number>`count(*) filter (where coalesce(${hcpInvoices.status}, '') not in ('voided','canceled'))::int`,
      paid: sql<number>`count(*) filter (where ${hcpInvoices.status} = 'paid')::int`,
      billedCents: sql<number>`coalesce(sum(${hcpInvoices.amountCents}) filter (where coalesce(${hcpInvoices.status}, '') not in ('voided','canceled')), 0)::bigint`,
      collectedCents: sql<number>`coalesce(sum(${hcpInvoices.paidAmountCents}) filter (where coalesce(${hcpInvoices.status}, '') not in ('voided','canceled')), 0)::bigint`,
      dueCents: sql<number>`coalesce(sum(${hcpInvoices.dueAmountCents}) filter (where coalesce(${hcpInvoices.status}, '') not in ('voided','canceled')), 0)::bigint`,
      refundedCents: sql<number>`coalesce(sum(${hcpInvoices.refundedAmountCents}), 0)::bigint`,
      unlinked: sql<number>`count(*) filter (where ${hcpInvoices.hcpJobId} is null)::int`,
    })
    .from(hcpInvoices)
    .leftJoin(hcpCustomers, eq(hcpInvoices.hcpCustomerId, hcpCustomers.id))
    .where(scope);

  return { ...pageOf(rows, limit, offset, agg?.total ?? 0), agg, dateField };
}

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerFilters {
  q?: string;
  city?: string;
  /** true = has at least one job. */
  hasJobs?: boolean;
  /** true = linked to a tracked inbox contact. */
  tracked?: boolean;
}

/**
 * The customer list, with lifetime rollups.
 *
 * The rollups are a SECOND query over just the page's ids rather than joined
 * aggregates: joining three one-to-many tables at once fans out and multiplies the
 * sums, and the usual fix (three correlated sub-selects over 10.7k customers) is
 * what makes a customer list slow. Two bounded queries stay flat.
 *
 * `days` is optional and windows on HCP's own `created_at` — "customers acquired
 * since". Omit it to search the whole book, which is what this list is usually for.
 */
export async function listCustomers(opts: {
  days?: number;
  filters?: CustomerFilters;
  limit?: number;
  offset?: number;
}) {
  const { days, filters = {}, limit = 50, offset = 0 } = opts;

  const conds: (SQL | undefined)[] = [];
  if (days != null) conds.push(gte(hcpCustomers.createdAtHcp, new Date(Date.now() - days * 86_400_000)));
  if (filters.q) conds.push(customerTextMatch(filters.q));
  if (filters.city) {
    conds.push(sql`exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(${hcpCustomers.addresses}) = 'array' then ${hcpCustomers.addresses} else '[]'::jsonb end
      ) a where a->>'city' ilike ${filters.city}
    )`);
  }
  if (filters.hasJobs != null) {
    const has = sql`exists (select 1 from ${hcpJobs} j where j.hcp_customer_id = ${hcpCustomers.id})`;
    conds.push(filters.hasJobs ? has : sql`not ${has}`);
  }
  if (filters.tracked != null) {
    conds.push(filters.tracked ? isNotNull(contacts.id) : isNull(contacts.id));
  }
  const scope = conds.length ? and(...conds) : undefined;

  const page = await db
    .select({
      id: hcpCustomers.id,
      hcpCustomerId: hcpCustomers.hcpCustomerId,
      name: sql<string | null>`nullif(trim(concat_ws(' ', ${hcpCustomers.firstName}, ${hcpCustomers.lastName})), '')`,
      firstName: hcpCustomers.firstName,
      lastName: hcpCustomers.lastName,
      email: hcpCustomers.emailLc,
      phone: hcpCustomers.phoneE164,
      phones: hcpCustomers.phonesE164,
      createdAt: hcpCustomers.createdAtHcp,
      updatedAt: hcpCustomers.updatedAtHcp,
      city: sql<string | null>`(
        select a->>'city' from jsonb_array_elements(
          case when jsonb_typeof(${hcpCustomers.addresses}) = 'array' then ${hcpCustomers.addresses} else '[]'::jsonb end
        ) a limit 1
      )`,
      zip: sql<string | null>`(
        select a->>'zip' from jsonb_array_elements(
          case when jsonb_typeof(${hcpCustomers.addresses}) = 'array' then ${hcpCustomers.addresses} else '[]'::jsonb end
        ) a limit 1
      )`,
      // The tracked-contact side: null means this customer has never reached us on a
      // tracked channel (walk-in, referral, canvassed, or predates tracking).
      contactId: contacts.id,
      conversationId: conversations.id,
    })
    .from(hcpCustomers)
    .leftJoin(contacts, eq(contacts.hcpCustomerId, hcpCustomers.id))
    .leftJoin(conversations, eq(conversations.contactId, contacts.id))
    .where(scope)
    .orderBy(desc(hcpCustomers.createdAtHcp), asc(hcpCustomers.id))
    .limit(limit)
    .offset(offset);

  const ids = page.map((r) => r.id);
  const [jobAgg, estAgg, invAgg] = ids.length
    ? await Promise.all([
        db
          .select({
            customerId: hcpJobs.hcpCustomerId,
            jobs: sql<number>`count(*)::int`,
            lastJobAt: sql<Date | null>`max(coalesce(${hcpJobs.completedAtHcp}, ${hcpJobs.scheduledStart}, ${hcpJobs.createdAtHcp}))`,
          })
          .from(hcpJobs)
          .where(and(inArray(hcpJobs.hcpCustomerId, ids), isNull(hcpJobs.deletedAtHcp)))
          .groupBy(hcpJobs.hcpCustomerId),
        db
          .select({
            customerId: hcpEstimates.hcpCustomerId,
            estimates: sql<number>`count(*)::int`,
            won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`,
          })
          .from(hcpEstimates)
          .where(inArray(hcpEstimates.hcpCustomerId, ids))
          .groupBy(hcpEstimates.hcpCustomerId),
        db
          .select({
            customerId: hcpInvoices.hcpCustomerId,
            billedCents: sql<number>`coalesce(sum(${hcpInvoices.amountCents}), 0)::bigint`,
            collectedCents: sql<number>`coalesce(sum(${hcpInvoices.paidAmountCents}), 0)::bigint`,
            dueCents: sql<number>`coalesce(sum(${hcpInvoices.dueAmountCents}), 0)::bigint`,
          })
          .from(hcpInvoices)
          .where(
            and(
              inArray(hcpInvoices.hcpCustomerId, ids),
              sql`coalesce(${hcpInvoices.status}, '') not in ('voided','canceled')`,
            ),
          )
          .groupBy(hcpInvoices.hcpCustomerId),
      ])
    : [[], [], []];

  const jobBy = new Map(jobAgg.map((r) => [r.customerId, r]));
  const estBy = new Map(estAgg.map((r) => [r.customerId, r]));
  const invBy = new Map(invAgg.map((r) => [r.customerId, r]));

  const rows = page.map((r) => ({
    ...r,
    jobCount: jobBy.get(r.id)?.jobs ?? 0,
    lastJobAt: jobBy.get(r.id)?.lastJobAt ?? null,
    estimateCount: estBy.get(r.id)?.estimates ?? 0,
    wonEstimateCount: estBy.get(r.id)?.won ?? 0,
    billedCents: Number(invBy.get(r.id)?.billedCents ?? 0),
    collectedCents: Number(invBy.get(r.id)?.collectedCents ?? 0),
    dueCents: Number(invBy.get(r.id)?.dueCents ?? 0),
  }));

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      tracked: sql<number>`count(*) filter (where ${contacts.id} is not null)::int`,
    })
    .from(hcpCustomers)
    .leftJoin(contacts, eq(contacts.hcpCustomerId, hcpCustomers.id))
    .where(scope);

  return { ...pageOf(rows, limit, offset, agg?.total ?? 0), agg };
}
