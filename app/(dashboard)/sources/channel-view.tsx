import Link from "next/link";
import { Fragment } from "react";
import { dollars } from "@/lib/format";
import { qualifiedLocationLabel } from "@/lib/locations";
import { sourceBreakdowns, sourcePerformance } from "@/lib/queries/sources";
import { timeframeLabel } from "@/lib/timeframes";
import { estimateDrilldown } from "./drilldown";
import type { TouchModel } from "@/lib/attribution/model";

const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

/**
 * Channels — the default view of /sources, and the one the page was originally.
 *
 * The numbers live in lib/queries/sources.ts, shared with the MCP `roi_summary`
 * tool so the two surfaces cannot disagree. Every figure reads the `roi_daily`
 * rollup — the same number the ROI pipeline computed, not a second count.
 */
export async function ChannelView({ days, touch }: { days: number; touch: TouchModel }) {
  const [{ rows, locationRows }, breakdowns] = await Promise.all([
    sourcePerformance(days, touch),
    sourceBreakdowns(days),
  ]);

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
  type LocationRows = typeof locationRows;
  const byKeyLocation = new Map<string | null, LocationRows>();
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

  const totals = rows.reduce(
    (a, r) => ({
      contacts: a.contacts + r.contacts,
      estimates: a.estimates + r.estimates,
      won: a.won + r.won,
      cancelled: a.cancelled + r.cancelled,
      spend: a.spend + r.spend,
      revenue: a.revenue + r.revenue,
    }),
    { contacts: 0, estimates: 0, won: 0, cancelled: 0, spend: 0, revenue: 0 },
  );
  const maxRoas = Math.max(1, ...rows.map((r) => (r.spend > 0 ? r.revenue / r.spend : 0)));

  // Breakdown dimensions follow the page's own timeframe — they were once pinned to
  // 90 days while the table obeyed the pills, with nothing on screen saying the two
  // disagreed. See sourceBreakdowns for what they count and why.
  const { landingPages: byLanding, keywords: byKeyword, selfReported: bySelfReported } = breakdowns;

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
              const cancelled = r.cancelled;
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
                  {/* Through to the estimates this row is counting. /sources says
                      which channel produced work; this is the "which work". */}
                  <td>
                    <Link href={estimateDrilldown({ source: r.key ?? "none" }, days)} className="rowlink">
                      <span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{r.name ?? r.key ?? "Unattributed"}</span>
                    </Link>
                  </td>
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
                      <Link href={estimateDrilldown({ source: r.key ?? "none", location: sub.location ?? "unknown" }, days)} className="link muted">
                        {qualifiedLocationLabel(sub.location)}
                      </Link>
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
        <BreakdownCard title="◧ Landing pages" rows={byLanding} days={days} filterKey="page" empty="No landing pages captured yet — populates once track.js is live." />
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
  days,
  filterKey,
}: {
  title: string;
  rows: Array<{ value: string | null; contacts: number; estimates: number; won: number; revenue: number }>;
  empty: string;
  /** Only set where /estimates can actually filter on this dimension. Keywords and
   *  self-reported answers are not filterable there, so those cards stay plain
   *  rather than offering a link that would silently ignore the value. */
  days?: number;
  filterKey?: "page";
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
                  {filterKey && days != null && r.value ? (
                    <Link href={estimateDrilldown({ [filterKey]: r.value }, days)} className="link">
                      {displayValue(r.value)}
                    </Link>
                  ) : (
                    displayValue(r.value)
                  )}
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
