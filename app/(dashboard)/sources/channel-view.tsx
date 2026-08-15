import { and, desc, eq, gte, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Fragment } from "react";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { hcpEstimates, leads, roiDaily, sources } from "@/lib/db/schema";
import { isCancelledEstimate } from "@/lib/estimates/countable";
import { landingPathSql } from "@/lib/landing-page";
import { dollars } from "@/lib/format";
import { timeframeLabel } from "@/lib/timeframes";
import { businessDate } from "@/lib/tz";
import type { TouchModel } from "@/lib/attribution/model";

const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

/**
 * Channels — the default view of /sources, and the one the page was originally.
 *
 * Reads the `roi_daily` rollup, so every figure here is the same number the ROI
 * pipeline computed rather than a second count that could disagree with it.
 */
export async function ChannelView({ days, touch }: { days: number; touch: TouchModel }) {
  // Two windows for the two shapes this view reads, and the names say which is
  // which. `roi_daily.date` is a BUSINESS date (America/Chicago), so its edge must
  // be one too — a UTC calendar date is a day ahead for most of the day, which
  // silently shifts which boundary day is included and puts the roi_daily figures
  // out of step with the lead counts beside them.
  const windowStart = new Date(Date.now() - days * 86_400_000);
  const sinceBusinessDate = businessDate(windowStart);
  // Recruiting campaigns are not customer acquisition. roi_daily is built without
  // them; the queries below read `leads` directly, so they filter here.
  const excluded = await excludedCampaignIds();
  const notRecruiting = campaignNotExcluded(leads.campaignId, excluded);

  // Performance by source, from the rollup.
  const rows = await db
    .select({
      key: sources.key,
      name: sources.displayName,
      contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
      estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
      won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(and(gte(roiDaily.date, sinceBusinessDate), eq(roiDaily.touchType, touch)))
    .groupBy(sources.key, sources.displayName)
    .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`));

  // The same rollup, split by location. `roi_daily` has keyed on location since it
  // was built, so this is a read of data already stored — not a new measurement.
  //
  // It matters most for Google Business Profile, which is really TWO profiles:
  // each tags its own website link (`utm_campaign=edwardsville` / `ofallon`) and
  // has its own tracking number, so calls and clicks both land on the right one.
  // Rolled up to a single GBP row, "which profile is working?" was unanswerable
  // even though the answer was in the table.
  const locationRows = await db
    .select({
      key: sources.key,
      location: roiDaily.location,
      contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
      estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
      won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(and(gte(roiDaily.date, sinceBusinessDate), eq(roiDaily.touchType, touch)))
    .groupBy(sources.key, roiDaily.location)
    .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`));

  // Sub-rows only where the split actually describes the SOURCE.
  //
  // Location is known two very different ways. Google Business Profile determines
  // it — two profiles, each with its own tracking number and its own
  // `utm_campaign` on its link — so essentially every GBP contact carries one.
  // Everywhere else it is INFERRED from the landing page, so it is really a fact
  // about the page a visitor happened to enter on, and most contacts have none.
  //
  // Expanding on the second kind is noise: Organic Search split 4 unknown / 1
  // O'Fallon / 1 Edwardsville — three rows to say almost nothing about organic.
  // So a source expands only when at least two NAMED locations have contacts and
  // those named locations are most of the source. That is a property of the data
  // rather than a list of blessed sources, so a channel that starts distinguishing
  // locations later starts expanding on its own.
  const byKeyLocation = new Map<string | null, typeof locationRows>();
  for (const r of locationRows) {
    if (!r.contacts && !r.estimates && !r.spend && !r.revenue) continue;
    const list = byKeyLocation.get(r.key ?? null);
    if (list) list.push(r);
    else byKeyLocation.set(r.key ?? null, [r]);
  }
  for (const [k, list] of byKeyLocation) {
    const named = list.filter((r) => r.location && r.location !== "unknown");
    const namedContacts = named.reduce((n, r) => n + r.contacts, 0);
    const allContacts = list.reduce((n, r) => n + r.contacts, 0);
    // `unknown` stays VISIBLE once a source qualifies — dropping it would leave
    // sub-rows that do not add up to the row above them, which is its own confusion.
    if (named.length < 2 || namedContacts * 2 <= allContacts) byKeyLocation.delete(k);
  }

  const LOCATION_LABEL: Record<string, string> = {
    edwardsville: "Edwardsville",
    ofallon: "O'Fallon",
    unknown: "Location unknown",
  };

  // Cancelled per source. roi_daily holds only countable estimates, so this is the
  // one figure on the page that must be counted directly — but it counts the SAME
  // KIND OF THING as the column beside it. It used to count `leads` with status
  // `cancelled` under the old lead predicate, so "Estimates 60 · Cancelled 4" put
  // two unrelated populations in one row and neither summed nor compared.
  //
  // `isCancelledEstimate` is the exact complement of `isCountableEstimate` within
  // scheduled estimates, and the join mirrors the rollup's opportunity pass: one
  // lead per estimate (matchLeadsToEstimates claims each lead once, so this cannot
  // fan out), attributed through that lead's source.
  const cancelledRows = await db
    .select({ key: sources.key, n: sql<number>`count(*)::int` })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .where(
      and(
        isCancelledEstimate,
        // Bucketed exactly as the rollup buckets estimates: the contact's day when
        // we can attribute one, the appointment's day when we cannot. Using
        // scheduled_start for both would put a cancelled estimate on a different
        // day from the countable one beside it and quietly break the comparison.
        gte(sql`coalesce(${leads.occurredAt}, ${hcpEstimates.scheduledStartHcp})`, windowStart),
        notRecruiting,
      ),
    )
    .groupBy(sources.key);
  const cancelledByKey = new Map<string | null, number>(cancelledRows.map((c) => [c.key ?? null, c.n]));

  const totals = rows.reduce(
    (a, r) => ({
      contacts: a.contacts + r.contacts,
      estimates: a.estimates + r.estimates,
      won: a.won + r.won,
      cancelled: a.cancelled + (cancelledByKey.get(r.key ?? null) ?? 0),
      spend: a.spend + r.spend,
      revenue: a.revenue + r.revenue,
    }),
    { contacts: 0, estimates: 0, won: 0, cancelled: 0, spend: 0, revenue: 0 },
  );
  const maxRoas = Math.max(1, ...rows.map((r) => (r.spend > 0 ? r.revenue / r.spend : 0)));

  // Breakdown dimensions: landing page + keyword (captured on the lead by track.js
  // / click-id enrichment) and the caller's self-reported source from call
  // transcripts — the DNI-invisible channels (referrals, yard signs, trucks).
  //
  // These follow the page's own timeframe now. They were pinned to 90 days while
  // the table above them obeyed the pills, so changing the timeframe moved half the
  // page and left the rest — with nothing on screen saying the two disagreed.
  //
  // Counting matches the table above too: contacts, not "qualified leads". The old
  // `leadOnly` predicate (type != 'call' OR is_lead) is the lead-anchored model the
  // rollup stopped using, so it is gone from this page entirely.
  const breakdownOf = (col: AnyPgColumn, groupBy: SQL | AnyPgColumn = col) =>
    db
      .select({
        value: sql<string | null>`${groupBy}`,
        contacts: sql<number>`count(*)::int`,
        estimates: sql<number>`count(*) filter (where ${leads.hcpEstimateId} is not null)::int`,
        won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
        revenue: sql<number>`coalesce(sum(${leads.salesValueCents}) filter (where ${leads.status} = 'won'), 0)::int`,
      })
      .from(leads)
      .where(and(gte(leads.occurredAt, windowStart), eq(leads.isSpam, false), isNotNull(col), ne(col, ""), notRecruiting))
      .groupBy(sql`${groupBy}`)
      .orderBy(desc(sql`count(*)`))
      .limit(8);

  // Landing pages group by PATH, not the raw stored URL — see lib/landing-page.ts.
  const landingPath = landingPathSql(leads.landingPage);

  const [byLanding, byKeyword, bySelfReported] = await Promise.all([
    breakdownOf(leads.landingPage, landingPath),
    breakdownOf(leads.keyword),
    breakdownOf(leads.selfReportedSource),
  ]);

  return (
    <>
      {/* Performance by source */}
      {rows.length === 0 ? (
        <div className="empty" style={{ marginBottom: 26 }}>
          No source performance yet — populates once ad spend + HousecallPro estimates are syncing.
        </div>
      ) : (
        <div className="table-scroll" style={{ marginBottom: 30 }}>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th title="People who contacted us — any channel, spam excluded">Contacts</th>
              <th title="Estimate visits booked and not cancelled">Estimates</th>
              <th title="Estimate approved">Won</th>
              <th title="Estimate or job cancelled">Cancelled</th>
              <th>Spend</th>
              <th title="Value of won estimates">Revenue</th>
              <th title="Cost per estimate: spend ÷ estimates attributed to this source">CPE</th>
              <th style={{ width: 150 }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cancelled = cancelledByKey.get(r.key ?? null) ?? 0;
              // Spend ÷ ESTIMATES attributed to this source. Only estimates we can tie to a
              // channel can have that channel's spend divided into them, so this is a
              // smaller denominator — and a higher, honester number — than the old
              // spend ÷ contacts.
              const cpe = r.estimates && r.spend ? dollars(Math.round(r.spend / r.estimates)) : "—";
              const roasNum = r.spend ? r.revenue / r.spend : 0;
              // Spend with no revenue yet is a wait-state, not a 0.0× verdict.
              const roas =
                r.spend && r.revenue > 0
                  ? roasNum.toFixed(1) + "×"
                  : r.revenue > 0
                    ? "organic"
                    : r.spend
                      ? "no rev yet"
                      : "—";
              const winning = r.spend > 0 && r.revenue > 0;
              const subs = byKeyLocation.get(r.key ?? null) ?? [];
              return (
                <Fragment key={r.key ?? `u${i}`}>
                <tr>
                  <td><span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{r.name ?? r.key ?? "Unattributed"}</span></td>
                  <td className="mono">{r.contacts}</td>
                  <td className="mono">{r.estimates}</td>
                  <td>{r.won > 0 ? <span className="badge win">{r.won}</span> : <span className="muted mono">0</span>}</td>
                  <td className="mono muted">{cancelled}</td>
                  <td className="mono muted">{dollars(r.spend)}</td>
                  <td className="mono">{r.revenue > 0 ? dollars(r.revenue) : <span className="muted">—</span>}</td>
                  <td className="mono muted">{cpe}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className={winning ? "mono" : ""} style={{ color: winning ? "var(--accent)" : "var(--muted)", fontWeight: winning ? 700 : 500, fontSize: winning ? undefined : 12, minWidth: 42 }}>{roas}</span>
                      {winning && <span className="bar"><i style={{ width: Math.max(4, Math.min(100, (roasNum / maxRoas) * 100)) + "%" }} /></span>}
                    </div>
                  </td>
                </tr>
                {/* Location sub-rows, server-rendered rather than a click-to-expand:
                    there are at most three and the whole point is to see them beside
                    each other. No Cancelled or ROAS here — cancelled is counted per
                    source only, and a location's ROAS divides a location's revenue by
                    the WHOLE source's spend, since ad platforms do not report spend
                    per location. Showing a number that wrong would be worse than
                    showing none. */}
                {subs.map((sub) => (
                  <tr key={`${r.key}/${sub.location}`} style={{ fontSize: 12.5 }}>
                    <td style={{ paddingLeft: 34 }}>
                      <span style={{ color: "var(--faint)", marginRight: 7 }}>↳</span>
                      <span className="muted">{LOCATION_LABEL[sub.location ?? "unknown"] ?? sub.location}</span>
                    </td>
                    <td className="mono muted">{sub.contacts}</td>
                    <td className="mono muted">{sub.estimates}</td>
                    <td className="mono muted">{sub.won}</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">{sub.revenue > 0 ? dollars(sub.revenue) : "—"}</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">—</td>
                  </tr>
                ))}
                </Fragment>
              );
            })}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td>
              <td className="mono">{totals.contacts}</td>
              <td className="mono">{totals.estimates}</td>
              <td className="mono">{totals.won}</td>
              <td className="mono muted">{totals.cancelled}</td>
              <td className="mono muted">{dollars(totals.spend)}</td>
              <td className="mono">{dollars(totals.revenue)}</td>
              <td className="mono muted">{totals.estimates && totals.spend ? dollars(Math.round(totals.spend / totals.estimates)) : "—"}</td>
              <td className="mono" style={{ color: "var(--accent)" }}>{totals.spend ? (totals.revenue / totals.spend).toFixed(1) + "×" : "—"}</td>
            </tr>
          </tbody>
        </table>
        </div>
      )}

      {/* Breakdowns: landing pages, keywords, self-reported */}
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 4 }}>Breakdowns</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        {timeframeLabel(days)} · contacts, and how many of them produced an estimate. Landing pages &amp; keywords come
        from web tracking; “callers say” is the AI-extracted answer to “how did you hear about us” — it catches the
        referrals, yard signs and trucks that number-tracking can&apos;t see.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 26 }}>
        <BreakdownCard title="◧ Landing pages" rows={byLanding} empty="No landing pages captured yet — populates once track.js is live." />
        <BreakdownCard title="⌕ Keywords" rows={byKeyword} empty="No keywords captured yet — populates from paid-search leads." />
        <BreakdownCard title="☏ Callers say" rows={bySelfReported} empty="No self-reported sources yet — extracted from call transcripts." />
      </div>
    </>
  );
}

function BreakdownCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ value: string | null; contacts: number; estimates: number; won: number; revenue: number }>;
  empty: string;
}) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3><span className="muted">contacts · est · won · revenue</span></div>
      {rows.length === 0 ? (
        <div className="empty" style={{ border: "none", padding: "20px 14px", fontSize: 12.5 }}>{empty}</div>
      ) : (
        <table style={{ border: "none", borderRadius: 0 }}>
          <tbody>
            {rows.map((r) => (
              <tr key={r.value ?? ""}>
                <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }} title={r.value ?? ""}>
                  {displayValue(r.value)}
                </td>
                <td className="mono" style={{ width: 40 }}>{r.contacts}</td>
                <td className="mono muted" style={{ width: 34 }}>{r.estimates}</td>
                <td style={{ width: 46 }}>{r.won > 0 ? <span className="badge win">{r.won}</span> : <span className="muted mono">0</span>}</td>
                <td className="mono" style={{ textAlign: "right", width: 80 }}>{r.revenue > 0 ? dollars(r.revenue) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Landing pages read better as paths; other values pass through. */
function displayValue(v: string | null): string {
  if (!v) return "—";
  try {
    if (v.startsWith("http")) {
      const u = new URL(v);
      return u.pathname === "/" ? u.hostname : u.pathname;
    }
  } catch {
    /* not a URL — show raw */
  }
  return v;
}
