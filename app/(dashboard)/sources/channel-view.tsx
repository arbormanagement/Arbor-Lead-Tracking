import Link from "next/link";
import { Fragment } from "react";
import { dollars } from "@/lib/format";
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
  const [{ rows, campaignRows }, breakdowns] = await Promise.all([
    sourcePerformance(days, touch),
    sourceBreakdowns(days),
  ]);

  // Sub-rows only where the split actually describes the SOURCE.
  //
  // This expands a source into its CAMPAIGNS. It used to expand into locations,
  // which was the wrong axis for the one channel it was really built for: Google
  // Business Profile is two LISTINGS, and a listing is not a place. Measured over
  // the 12 GBP wins to 2026-08-30, the listing and the service-address city
  // disagreed half the time — the Edwardsville listing produced work in Granite
  // City, Alton and Fairview Heights — so a row labelled "Edwardsville" under GBP
  // was making a claim about the customer that was false as often as not. The two
  // listings are campaigns now, and this reads them.
  //
  // Spend is shown here and was a dash on the location rows, because that is a real
  // difference and not a presentational one: platforms report spend per campaign and
  // never per location.
  //
  // A source expands only when at least TWO named campaigns show activity, so a
  // single-campaign channel does not grow a sub-row restating its own total. That is
  // a property of the data rather than a list of blessed sources, so a channel that
  // starts running a second campaign starts expanding on its own.
  type CampaignRows = typeof campaignRows;
  const byKeyCampaign = new Map<string | null, CampaignRows>();
  for (const r of campaignRows) {
    if (!r.contacts && !r.estimates && !r.spend && !r.revenue) continue;
    const list = byKeyCampaign.get(r.key ?? null);
    if (list) list.push(r);
    else byKeyCampaign.set(r.key ?? null, [r]);
  }
  for (const [k, list] of byKeyCampaign) {
    if (list.filter((r) => r.campaignId).length < 2) byKeyCampaign.delete(k);
    // Revenue first, then spend, so a campaign that has produced nothing but has
    // consumed budget still surfaces rather than being ordered off the end.
    else list.sort((a, b) => b.revenue - a.revenue || b.spend - a.spend);
  }
  // Google Ads alone carries nine campaigns. Past a handful the sub-rows stop being
  // an aside on the channel table and become a worse copy of the campaign view, so
  // the tail is a link to the real one.
  const MAX_SUBS = 5;

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
              const subs = byKeyCampaign.get(r.key ?? null) ?? [];
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
                {/* Campaign sub-rows, server-rendered rather than click-to-expand:
                    there are at most a handful and the whole point is to see them
                    beside each other. No Cancelled or ROAS — cancelled is counted per
                    source only, and ROAS is already the parent row's job. */}
                {subs.slice(0, MAX_SUBS).map((sub) => (
                  <tr key={`${r.key}/${sub.campaignId ?? "none"}`} style={{ fontSize: 12.5 }}>
                    <td style={{ paddingLeft: 34 }}>
                      <span style={{ color: "var(--faint)", marginRight: 7 }}>↳</span>
                      <Link
                        href={estimateDrilldown(
                          { source: r.key ?? "none", campaign: sub.campaignName ?? "none" },
                          days,
                        )}
                        className="link muted"
                      >
                        {sub.campaignName ?? "No campaign"}
                      </Link>
                    </td>
                    <td className="mono muted">{sub.contacts}</td>
                    <td className="mono muted">{sub.estimates}</td>
                    <td className="mono muted">{sub.won}</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">{sub.spend > 0 ? dollars(sub.spend) : "—"}</td>
                    <td className="mono muted">{sub.revenue > 0 ? dollars(sub.revenue) : "—"}</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">—</td>
                  </tr>
                ))}
                {subs.length > MAX_SUBS && (
                  <tr key={`${r.key}/more`} style={{ fontSize: 12.5 }}>
                    <td style={{ paddingLeft: 34 }}>
                      <span style={{ color: "var(--faint)", marginRight: 7 }}>↳</span>
                      <Link href={`/sources?view=campaign&days=${days}`} className="link muted">
                        +{subs.length - MAX_SUBS} more campaigns
                      </Link>
                    </td>
                    <td className="mono muted" colSpan={8} />
                  </tr>
                )}
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
