import { and, desc, eq, gte, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { TouchModel } from "@/lib/attribution/model";
import { isLikelyBot } from "@/lib/bot";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { campaigns, hcpEstimates, leads, roiDaily, sources, webSessions } from "@/lib/db/schema";
import { isCancelledEstimate } from "@/lib/estimates/countable";
import { landingPathSql } from "@/lib/landing-page";
import { businessDate } from "@/lib/tz";

/**
 * The /sources numbers, extracted so the page views and the MCP tools
 * (`roi_summary`, `landing_pages`) read one implementation.
 *
 * Two window shapes coexist here deliberately, and their names say which is which:
 * channel/campaign figures read `roi_daily`, whose `date` is a BUSINESS date
 * (America/Chicago), so those windows compare against `businessDate(since)`; the
 * page view and the breakdowns read raw `web_sessions`/`leads` timestamps. Totals
 * from the two shapes will not reconcile at a window edge — that is the documented
 * /sources caveat, not a bug to chase.
 *
 * All money is integer CENTS.
 */

export interface SourcePerfRow {
  key: string | null;
  name: string | null;
  contacts: number;
  estimates: number;
  won: number;
  /** Cancelled estimates attributed to this source — counted directly, see below. */
  cancelled: number;
  spend: number;
  revenue: number;
}

export interface SourceLocationRow {
  key: string | null;
  location: string | null;
  contacts: number;
  estimates: number;
  won: number;
  spend: number;
  revenue: number;
}

export interface SourceCampaignRow {
  key: string | null;
  campaignId: string | null;
  campaignName: string | null;
  contacts: number;
  estimates: number;
  won: number;
  spend: number;
  revenue: number;
}

/**
 * Performance by source, from the `roi_daily` rollup — every figure is the same
 * number the ROI pipeline computed rather than a second count that could disagree
 * with it. Cancelled is the one figure counted directly (roi_daily holds only
 * countable estimates), via `isCancelledEstimate` — the exact complement of
 * `isCountableEstimate` within scheduled estimates, so "Estimates" and "Cancelled"
 * count the same kind of thing and cannot drift.
 */
/**
 * Which BRANCH a rolled-up row belongs to, derived from the campaign rather than
 * read from `roi_daily.location`.
 *
 * The two Google Business Profiles are the only thing that identifies a branch, and
 * they already arrive as campaigns: their website links carry
 * `utm_campaign=edwardsville` / `ofallon`, and since #137 a call to a profile's own
 * tracking number is given that same campaign. So the campaign IS the branch, and the
 * dedicated column was a second copy of it that also collected false positives — any
 * visitor who merely READ a page with a city in its path was recorded as a contact
 * from that branch. Deriving it here means one source of truth and no way for a page
 * view to masquerade as a branch touch.
 */
const branchExpr = sql<string>`case
  when ${campaigns.externalCampaignId} in ('edwardsville', 'ofallon') then ${campaigns.externalCampaignId}
  else 'unknown'
end`;

export async function sourcePerformance(
  days: number,
  touch: TouchModel,
): Promise<{ rows: SourcePerfRow[]; locationRows: SourceLocationRow[]; campaignRows: SourceCampaignRow[] }> {
  const windowStart = new Date(Date.now() - days * 86_400_000);
  const sinceBusinessDate = businessDate(windowStart);
  // Recruiting campaigns are not customer acquisition. roi_daily is built without
  // them; the cancelled count reads `leads` directly, so it filters here.
  const excluded = await excludedCampaignIds();
  const notRecruiting = campaignNotExcluded(leads.campaignId, excluded);

  const inWindow = and(gte(roiDaily.date, sinceBusinessDate), eq(roiDaily.touchType, touch));
  const agg = {
    contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
    estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
    won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
    spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
    revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
  };

  const [rolled, locationRows, campaignRows, cancelledRows] = await Promise.all([
    db
      .select({ key: sources.key, name: sources.displayName, ...agg })
      .from(roiDaily)
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .where(inWindow)
      .groupBy(sources.key, sources.displayName)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`)),
    // The same rollup, split by location — a read of data already stored, not a new
    // measurement. It matters most for GBP, which is really TWO profiles with their
    // own tracking numbers and utm_campaign tags.
    db
      .select({ key: sources.key, location: branchExpr, ...agg })
      .from(roiDaily)
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .leftJoin(campaigns, eq(roiDaily.campaignId, campaigns.id))
      .where(inWindow)
      .groupBy(sources.key, branchExpr)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`)),
    // The same rollup split by CAMPAIGN — what the channel view expands a source
    // into. Spend is real here, which is the difference from the location split
    // above: ad platforms report spend per campaign and never per location, so the
    // location sub-rows had to show a dash where the money goes.
    db
      .select({ key: sources.key, campaignId: roiDaily.campaignId, campaignName: campaigns.name, ...agg })
      .from(roiDaily)
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .leftJoin(campaigns, eq(roiDaily.campaignId, campaigns.id))
      .where(inWindow)
      .groupBy(sources.key, roiDaily.campaignId, campaigns.name)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`)),
    // Cancelled per source, bucketed exactly as the rollup buckets estimates: the
    // contact's day when we can attribute one, the appointment's day when we cannot.
    // The join mirrors the rollup's opportunity pass — one lead per estimate
    // (matchLeadsToEstimates claims each lead once), so this cannot fan out.
    db
      .select({ key: sources.key, n: sql<number>`count(*)::int` })
      .from(hcpEstimates)
      .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
      .leftJoin(sources, eq(leads.sourceId, sources.id))
      .where(
        and(
          isCancelledEstimate,
          gte(sql`coalesce(${leads.occurredAt}, ${hcpEstimates.scheduledStartHcp})`, windowStart),
          notRecruiting,
        ),
      )
      .groupBy(sources.key),
  ]);

  const cancelledByKey = new Map<string | null, number>(cancelledRows.map((c) => [c.key ?? null, c.n]));
  const rows: SourcePerfRow[] = rolled.map((r) => ({
    ...r,
    cancelled: cancelledByKey.get(r.key ?? null) ?? 0,
  }));

  return { rows, locationRows, campaignRows };
}

export interface BreakdownRow {
  value: string | null;
  contacts: number;
  estimates: number;
  won: number;
  revenue: number;
}

/**
 * Breakdown dimensions: landing page + keyword (captured on the lead by track.js /
 * click-id enrichment) and the caller's self-reported source from call transcripts —
 * the DNI-invisible channels (referrals, yard signs, trucks).
 *
 * Counts CONTACTS, not "qualified leads" — the lead-anchored `leadOnly` predicate is
 * the model the rollup stopped using. Windows on raw lead timestamps.
 */
export async function sourceBreakdowns(days: number): Promise<{
  landingPages: BreakdownRow[];
  keywords: BreakdownRow[];
  selfReported: BreakdownRow[];
}> {
  const windowStart = new Date(Date.now() - days * 86_400_000);
  const excluded = await excludedCampaignIds();
  const notRecruiting = campaignNotExcluded(leads.campaignId, excluded);

  const breakdownOf = (col: AnyPgColumn, groupBy: SQL | AnyPgColumn = col) =>
    db
      .select({
        value: sql<string | null>`${groupBy}`,
        contacts: sql<number>`count(*)::int`,
        estimates: sql<number>`count(*) filter (where ${leads.hcpEstimateId} is not null)::int`,
        won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`,
        revenue: sql<number>`coalesce(sum(${hcpEstimates.approvedAmountCents}) filter (where ${hcpEstimates.outcome} = 'won'), 0)::int`,
      })
      .from(leads)
      .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
      .where(and(gte(leads.occurredAt, windowStart), eq(leads.isSpam, false), isNotNull(col), ne(col, ""), notRecruiting))
      .groupBy(sql`${groupBy}`)
      .orderBy(desc(sql`count(*)`))
      .limit(8);

  // Landing pages group by PATH, not the raw stored URL — see lib/landing-page.ts.
  const [landingPages, keywords, selfReported] = await Promise.all([
    breakdownOf(leads.landingPage, landingPathSql(leads.landingPage)),
    breakdownOf(leads.keyword),
    breakdownOf(leads.selfReportedSource),
  ]);
  return { landingPages, keywords, selfReported };
}

export interface CampaignPerfRow {
  campaignId: string | null;
  name: string | null;
  platform: string | null;
  sourceName: string | null;
  contacts: number;
  estimates: number;
  won: number;
  spend: number;
  revenue: number;
}

export interface LocationPerfRow {
  location: string | null;
  contacts: number;
  estimates: number;
  won: number;
  spend: number;
  revenue: number;
}

/**
 * Campaign-level ROI — the FLOOR of this app's money reporting. Below campaign
 * (ad group, keyword, ad) the sample collapses into noise wearing a decimal point.
 *
 * Recruiting campaigns need no filtering here: `rebuildRoiDaily` already applies
 * `campaignNotExcluded` to both the lead pass and the spend pass.
 */
export async function campaignPerformance(
  days: number,
  touch: TouchModel,
): Promise<{ rows: CampaignPerfRow[]; byLocation: LocationPerfRow[] }> {
  const since = businessDate(new Date(Date.now() - days * 86_400_000));
  // Reading BOTH touch models would double every figure, spend included.
  const inWindow = and(gte(roiDaily.date, since), eq(roiDaily.touchType, touch));

  const agg = {
    contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
    estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
    won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
    spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
    revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
  };

  const [rows, byLocation] = await Promise.all([
    db
      .select({
        campaignId: roiDaily.campaignId,
        name: campaigns.name,
        platform: campaigns.platform,
        sourceName: sources.displayName,
        ...agg,
      })
      .from(roiDaily)
      .leftJoin(campaigns, eq(roiDaily.campaignId, campaigns.id))
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .where(inWindow)
      .groupBy(roiDaily.campaignId, campaigns.name, campaigns.platform, sources.displayName)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.spendCents}),0)`)),
    db
      .select({ location: branchExpr, ...agg })
      .from(roiDaily)
      .leftJoin(campaigns, eq(roiDaily.campaignId, campaigns.id))
      .where(inWindow)
      .groupBy(branchExpr)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`)),
  ]);

  return { rows, byLocation };
}

export interface PagePerfRow {
  path: string;
  sessions: number;
  contacts: number;
  estimates: number;
  won: number;
  revenue: number;
}

/**
 * Page performance — a CRO view, deliberately not an attribution one. No spend:
 * money attaches to a campaign, not a page. The question is a RATE, which needs the
 * visitors who did NOT convert in the denominator — hence `web_sessions` rather than
 * working backwards from leads, and hence its own query rather than `roi_daily`
 * (which holds outcomes only).
 *
 * `unknownUa` counts sessions with no user-agent recorded (captured only from
 * 2026-08-13). They are counted as HUMAN, not bots: `isLikelyBot` treats an absent
 * agent as a bot, which is right at the DNI gate and wrong here — assuming bot would
 * silently shrink the denominator and inflate every conversion rate.
 */
/**
 * Which page a row is counted against.
 *
 * `entry` — the page the visit STARTED on. What an ad click or a search result
 * actually bought. This is the original behaviour and stays the default so no
 * existing surface moves.
 *
 * `conversion` — the page the visitor was on when they became a lead, and the
 * page they were last seen on for the session denominator. On a client-side
 * routed site these are usually different: someone lands on the home page from
 * the map pack, reads a location page, and calls. Under `entry` the home page
 * gets the whole credit and the location page can never earn any.
 *
 * Only `conversion` answers "which content persuades"; only `entry` answers
 * "which page should the ad point at". Both are real questions.
 */
export type PageBasis = "entry" | "conversion";

export async function landingPagePerformance(
  days: number,
  basis: PageBasis = "entry",
): Promise<{ rows: PagePerfRow[]; unknownUa: number }> {
  const since = new Date(Date.now() - days * 86_400_000);
  const excluded = await excludedCampaignIds();
  const sessionCol = basis === "conversion" ? webSessions.lastPage : webSessions.landingPage;
  const leadCol = basis === "conversion" ? leads.conversionPage : leads.landingPage;

  // Sessions carry their user-agent so crawlers can be dropped in JS through the
  // SAME predicate the DNI gate uses — replicating that regex in SQL would give two
  // definitions of "bot" that drift.
  const sessionRows = await db
    .select({ path: landingPathSql(sessionCol), ua: webSessions.userAgent })
    .from(webSessions)
    .where(and(gte(webSessions.startedAt, since), isNotNull(sessionCol), ne(sessionCol, "")));

  let unknownUa = 0;
  const sessionsByPath = new Map<string, number>();
  for (const s of sessionRows) {
    if (s.ua == null || s.ua.trim() === "") unknownUa++;
    else if (isLikelyBot(s.ua)) continue;
    sessionsByPath.set(s.path, (sessionsByPath.get(s.path) ?? 0) + 1);
  }

  // Contacts and what they became. Counted from `leads` — every non-spam contact,
  // not a "qualified lead" — so this agrees with the demand figure everywhere else.
  const outcomeRows = await db
    .select({
      path: landingPathSql(leadCol),
      contacts: sql<number>`count(*)::int`,
      estimates: sql<number>`count(*) filter (where ${leads.hcpEstimateId} is not null)::int`,
      won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`,
      revenue: sql<number>`coalesce(sum(${hcpEstimates.approvedAmountCents}) filter (where ${hcpEstimates.outcome} = 'won'), 0)::int`,
    })
    .from(leads)
    .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
    .where(
      and(
        gte(leads.occurredAt, since),
        eq(leads.isSpam, false),
        isNotNull(leadCol),
        ne(leadCol, ""),
        campaignNotExcluded(leads.campaignId, excluded),
      ),
    )
    .groupBy(landingPathSql(leadCol));

  const outcomeByPath = new Map(outcomeRows.map((r) => [r.path, r]));
  const paths = [...new Set([...sessionsByPath.keys(), ...outcomeByPath.keys()])];

  const rows: PagePerfRow[] = paths
    .map((path) => {
      const o = outcomeByPath.get(path);
      return {
        path,
        sessions: sessionsByPath.get(path) ?? 0,
        contacts: o?.contacts ?? 0,
        estimates: o?.estimates ?? 0,
        won: o?.won ?? 0,
        revenue: o?.revenue ?? 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.contacts - a.contacts);

  return { rows, unknownUa };
}
