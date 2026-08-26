import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { campaigns, conversations, hcpCustomers, hcpEstimates, leads, sources } from "@/lib/db/schema";
import { filterSql, type EstimateFilters } from "@/lib/estimates/filters";
import {
  addressPartSql,
  assignedToSql,
  estimateNumberSql,
  jobTypeSql,
  optionCountSql,
  serviceNoteSql,
} from "@/lib/estimates/hcp-fields";
import { isLiveEstimate } from "@/lib/estimates/countable";
import { landingPathSql } from "@/lib/landing-page";
import { TRACKING_STARTED_AT } from "@/lib/tracking-coverage";
import { resolveWindow, type WindowInput } from "@/lib/window";

/**
 * The estimate list — what /estimates renders and what the MCP `list_estimates`
 * tool returns. One implementation so the two cannot disagree.
 *
 * The LIST is every live estimate (`isLiveEstimate`: not cancelled, not deleted,
 * appointment or not); the RATE's denominator is `agg.countable`, mirroring
 * `isCountableEstimate` (an appointment, or a win settled without one) — never
 * `agg.total`. Dividing by the listed total drags the rate down with records that
 * were never opportunities: the 25%-vs-48% error this app was built to stop making.
 *
 * **Windowed on CREATED**, defaulting to the recent past: it answers "what came in
 * this week", and it is the only one of the three dates that makes the list a clean
 * cohort of new work. It will NOT reconcile row-for-row with /sources, which buckets
 * on the CONTACT date — both are right for their own question.
 */
export interface EstimateListRow {
  id: string;
  outcome: string;
  /** False when HCP has no appointment for this estimate yet. */
  scheduled: boolean;
  /** When the estimate was written — what the list windows and groups on. */
  createdAt: Date;
  /** The booked visit, shown alongside. Null until someone schedules it. */
  scheduledStart: Date | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  approved: number | null;
  total: number | null;
  /** Null when no tracked contact could be matched — rendered as Unattributed. */
  leadId: string | null;
  leadType: string | null;
  sourceKey: string | null;
  sourceName: string | null;
  campaignName: string | null;
  keyword: string | null;
  /** Normalised landing PATH, so it groups and filters the same way /sources does. */
  landingPage: string | null;
  selfReportedSource: string | null;
  location: string | null;

  // ---- The HousecallPro side of the estimate ------------------------------
  // Synced since the estimate sync existed, but projected only from 2026-08-25:
  // they sat in `raw`, `address` and `options` where nothing above the query layer
  // could reach them. Attribution answers "where did this come from"; these answer
  // "what is it and who has it", which is the other half of working the list.

  /** HCP `work_status`. NEVER the test for won — that is option approval. */
  status: string | null;
  /** HCP's own id (`csr_…`) — the key for looking the estimate up in HousecallPro. */
  hcpEstimateId: string | null;
  /** The human-facing estimate number (e.g. "15441"). */
  estimateNumber: string | null;
  /** Assigned employee(s), comma-joined. The sales arborist. Null = unassigned. */
  assignedTo: string | null;
  /** HCP job-type name. Almost always null — barely set on estimates. */
  jobType: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** Options on the estimate — why `total` is the highest option, not their sum. */
  optionCount: number;
  /** First option note: in practice, the description of the work. */
  serviceNote: string | null;
}

/**
 * Projected identically by the list and the detail tool. Spread rather than repeated
 * so the two cannot drift into meaning different things by `assignedTo`.
 */
const hcpFieldColumns = {
  status: hcpEstimates.status,
  hcpEstimateId: hcpEstimates.hcpEstimateId,
  estimateNumber: estimateNumberSql,
  assignedTo: assignedToSql,
  jobType: jobTypeSql,
  street: addressPartSql("street"),
  city: addressPartSql("city"),
  state: addressPartSql("state"),
  zip: addressPartSql("zip"),
  optionCount: optionCountSql,
  serviceNote: serviceNoteSql,
} as const;

/** The same fields, copied onto the row. Keys match `hcpFieldColumns` exactly. */
function hcpFieldValues(r: {
  status: string | null;
  hcpEstimateId: string | null;
  estimateNumber: string | null;
  assignedTo: string | null;
  jobType: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  optionCount: number;
  serviceNote: string | null;
}) {
  return {
    status: r.status,
    hcpEstimateId: r.hcpEstimateId,
    estimateNumber: r.estimateNumber,
    assignedTo: r.assignedTo,
    jobType: r.jobType,
    street: r.street,
    city: r.city,
    state: r.state,
    zip: r.zip,
    optionCount: r.optionCount ?? 0,
    serviceNote: r.serviceNote,
  };
}

export interface EstimateListAgg {
  total: number;
  /** The close-rate denominator, mirroring `isCountableEstimate`. */
  countable: number;
  scheduled: number;
  won: number;
  attributed: number;
  /** Estimates WRITTEN before tracking existed — unattributable whatever the matching does. */
  createdBeforeTracking: number;
  wonCents: number;
}

export async function listEstimates(opts: WindowInput & {
  filters?: EstimateFilters;
  limit?: number;
  offset?: number;
}): Promise<{
  rows: EstimateListRow[];
  agg: EstimateListAgg;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}> {
  const { filters = {}, limit = 50, offset = 0 } = opts;
  const { since, until } = resolveWindow(opts, 7);

  // Recruiting/brand campaigns are not customer acquisition, so their estimates
  // stay out of this list and its totals — the same exclusion roi_daily applies.
  const excludedIds = await excludedCampaignIds();

  // At most one lead per estimate: matchLeadsToEstimates claims each lead exactly
  // once, so this join cannot fan out and double-count an estimate or its revenue.
  //
  // Windowed on CREATED. Every estimate has one, so an estimate with no appointment
  // still appears — windowing on `scheduled_start` alone is precisely what hid 34 of
  // them — and unlike `coalesce(scheduled, created)` the population does not change
  // shape when someone books a visit.
  const scope = and(
    isLiveEstimate,
    gte(hcpEstimates.createdAtHcp, since),
    // Only bounded when the caller named a fixed period; a rolling window runs to now.
    until ? lte(hcpEstimates.createdAtHcp, until) : undefined,
    campaignNotExcluded(leads.campaignId, excludedIds),
    filterSql(filters),
  );

  const fetched = await db
    .select({
      id: hcpEstimates.id,
      outcome: hcpEstimates.outcome,
      scheduledStart: hcpEstimates.scheduledStartHcp,
      createdAtHcp: hcpEstimates.createdAtHcp,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      // Name comes through the customer JOIN first: this app links to HousecallPro
      // rather than storing customer data, so a name corrected in HCP shows up here
      // immediately. The copy on the estimate is the fallback for a customer the
      // sync has not reached yet.
      custFirst: hcpCustomers.firstName,
      custLast: hcpCustomers.lastName,
      estName: hcpEstimates.customerName,
      phone: hcpEstimates.customerPhoneE164,
      email: hcpEstimates.customerEmailLc,
      estLocation: hcpEstimates.location,
      leadId: leads.id,
      leadType: leads.type,
      leadLocation: leads.location,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      campaignName: campaigns.name,
      keyword: leads.keyword,
      landingPage: landingPathSql(leads.landingPage),
      selfReportedSource: leads.selfReportedSource,
      ...hcpFieldColumns,
    })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .leftJoin(hcpCustomers, eq(hcpEstimates.hcpCustomerId, hcpCustomers.id))
    .where(scope)
    .orderBy(desc(hcpEstimates.createdAtHcp))
    .limit(limit)
    .offset(offset);

  const rows: EstimateListRow[] = fetched.map((r) => ({
    id: r.id,
    outcome: r.outcome,
    scheduled: r.scheduledStart != null,
    createdAt: r.createdAtHcp!,
    scheduledStart: r.scheduledStart,
    name: [r.custFirst, r.custLast].filter(Boolean).join(" ") || r.estName,
    phone: r.phone,
    email: r.email,
    approved: r.approved,
    total: r.total,
    leadId: r.leadId,
    leadType: r.leadType,
    sourceKey: r.sourceKey,
    sourceName: r.sourceName,
    campaignName: r.campaignName,
    keyword: r.keyword,
    landingPage: r.landingPage,
    selfReportedSource: r.selfReportedSource,
    // The attributed contact's location when there is one, the estimate's own
    // otherwise — the same precedence the rollup uses, so the two agree.
    location: r.leadLocation ?? r.estLocation,
    ...hcpFieldValues(r),
  }));

  // Counted over EXACTLY the population the list renders (same scope), so a
  // subtitle can never disagree with the sum of the visible rows. The sources /
  // campaigns joins are required whenever those filters are active — `scope` may
  // reference their columns.
  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      // Mirrors `isCountableEstimate`: an appointment, or a win settled without
      // one. Counting scheduled-only here while the numerator counted every won
      // estimate mixed two populations.
      countable: sql<number>`count(*) filter (where ${hcpEstimates.scheduledStartHcp} is not null or ${hcpEstimates.outcome} = 'won')::int`,
      scheduled: sql<number>`count(*) filter (where ${hcpEstimates.scheduledStartHcp} is not null)::int`,
      won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`,
      attributed: sql<number>`count(*) filter (where ${leads.id} is not null)::int`,
      createdBeforeTracking: sql<number>`count(*) filter (where ${hcpEstimates.createdAtHcp} < ${TRACKING_STARTED_AT})::int`,
      wonCents: sql<number>`coalesce(sum(coalesce(nullif(${hcpEstimates.approvedAmountCents},0), ${hcpEstimates.totalAmountCents})) filter (where ${hcpEstimates.outcome} = 'won'), 0)::int`,
    })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(scope);

  const total = agg?.total ?? 0;
  const hasMore = offset + rows.length < total;

  return {
    rows,
    // Paging metadata, so a caller can tell "these are all of them" from "this is
    // the first page". Without it a limited fetch is indistinguishable from a
    // complete one, which is how a generated view silently reports partial data.
    //
    // `total` is repeated here rather than left only on `agg`, so all three list
    // tools carry the same paging shape — one contract a client can rely on
    // without knowing which tool it called.
    total,
    hasMore,
    nextOffset: hasMore ? offset + rows.length : null,
    agg: agg ?? {
      total: 0,
      countable: 0,
      scheduled: 0,
      won: 0,
      attributed: 0,
      createdBeforeTracking: 0,
      wonCents: 0,
    },
  };
}

export interface EstimateDetail extends EstimateListRow {
  hcpCustomerId: string | null;
  /** The thread behind the attributed contact, when there is one. */
  conversationId: string | null;
  leadOccurredAt: Date | null;
}

/** One estimate with its whole attribution chain — the MCP `estimate_detail` tool. */
export async function getEstimateDetail(id: string): Promise<EstimateDetail | null> {
  const [r] = await db
    .select({
      id: hcpEstimates.id,
      outcome: hcpEstimates.outcome,
      ...hcpFieldColumns,
      hcpCustomerId: hcpEstimates.hcpCustomerId,
      scheduledStart: hcpEstimates.scheduledStartHcp,
      createdAtHcp: hcpEstimates.createdAtHcp,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      custFirst: hcpCustomers.firstName,
      custLast: hcpCustomers.lastName,
      estName: hcpEstimates.customerName,
      phone: hcpEstimates.customerPhoneE164,
      email: hcpEstimates.customerEmailLc,
      estLocation: hcpEstimates.location,
      leadId: leads.id,
      leadType: leads.type,
      leadLocation: leads.location,
      leadOccurredAt: leads.occurredAt,
      conversationId: conversations.id,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      campaignName: campaigns.name,
      keyword: leads.keyword,
      landingPage: landingPathSql(leads.landingPage),
      selfReportedSource: leads.selfReportedSource,
    })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .leftJoin(conversations, eq(leads.conversationId, conversations.id))
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .leftJoin(hcpCustomers, eq(hcpEstimates.hcpCustomerId, hcpCustomers.id))
    .where(eq(hcpEstimates.id, id))
    .limit(1);
  if (!r) return null;

  return {
    id: r.id,
    outcome: r.outcome,
    ...hcpFieldValues(r),
    hcpCustomerId: r.hcpCustomerId,
    scheduled: r.scheduledStart != null,
    createdAt: r.createdAtHcp!,
    scheduledStart: r.scheduledStart,
    name: [r.custFirst, r.custLast].filter(Boolean).join(" ") || r.estName,
    phone: r.phone,
    email: r.email,
    approved: r.approved,
    total: r.total,
    leadId: r.leadId,
    leadType: r.leadType,
    sourceKey: r.sourceKey,
    sourceName: r.sourceName,
    campaignName: r.campaignName,
    keyword: r.keyword,
    landingPage: r.landingPage,
    selfReportedSource: r.selfReportedSource,
    location: r.leadLocation ?? r.estLocation,
    conversationId: r.conversationId,
    leadOccurredAt: r.leadOccurredAt,
  };
}
