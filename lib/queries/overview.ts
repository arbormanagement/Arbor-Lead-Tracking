import { and, desc, eq, gte, sql } from "drizzle-orm";
import { selectedTouchModel, type TouchModel } from "@/lib/attribution/model";
import { db } from "@/lib/db/client";
import { roiDaily, sources } from "@/lib/db/schema";
import { businessDate } from "@/lib/tz";

/**
 * The `/` overview's numbers, extracted so the page and the MCP `funnel_overview`
 * tool read one implementation and cannot disagree.
 *
 * Everything reads `roi_daily`, the aggregate of record: it already applies the
 * countable-estimate predicate and the recruiting-campaign exclusion, so the funnel
 * cannot drift from /sources the way the old lead-side query did — which is
 * precisely how three different answers to "how many leads?" came to exist.
 *
 * All money is integer CENTS. `daily[].date` is a BUSINESS date (America/Chicago).
 */
export interface OverviewData {
  /** Which attribution model these figures were read under. */
  touch: TouchModel;
  funnel: { contacts: number; calls: number; forms: number; estimates: number; won: number };
  daily: Array<{ date: string; spend: number; revenue: number }>;
  topSources: Array<{ key: string | null; name: string | null; spend: number; revenue: number }>;
}

export async function overviewData(days: number): Promise<OverviewData> {
  const since = new Date(Date.now() - days * 86_400_000);
  // roi_daily.date is a BUSINESS date (America/Chicago), so the window edge
  // compared against it has to be one too. Deriving it from toISOString() reads a
  // UTC calendar date, which for most of the day is one day ahead of the business
  // date — silently trimming or including an extra boundary day.
  const sinceDate = businessDate(since);
  // roi_daily holds BOTH attribution models; every read must pick one or it
  // double-counts (spend included — it is written to both).
  const touch = await selectedTouchModel();
  const inWindow = and(gte(roiDaily.date, sinceDate), eq(roiDaily.touchType, touch));

  const [[f], daily, topSources] = await Promise.all([
    db
      .select({
        contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
        calls: sql<number>`coalesce(sum(${roiDaily.callsCount}),0)::int`,
        forms: sql<number>`coalesce(sum(${roiDaily.formsCount}),0)::int`,
        estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
        won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      })
      .from(roiDaily)
      .where(inWindow),
    db
      .select({
        date: roiDaily.date,
        spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
        revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
      })
      .from(roiDaily)
      .where(inWindow)
      .groupBy(roiDaily.date)
      .orderBy(roiDaily.date),
    db
      .select({
        key: sources.key,
        name: sources.displayName,
        spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
        revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
      })
      .from(roiDaily)
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .where(inWindow)
      .groupBy(sources.key, sources.displayName)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`))
      .limit(6),
  ]);

  return {
    touch,
    funnel: f ?? { contacts: 0, calls: 0, forms: 0, estimates: 0, won: 0 },
    daily,
    topSources,
  };
}
