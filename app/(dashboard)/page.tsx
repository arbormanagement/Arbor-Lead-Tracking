import { touchModelLabel } from "@/lib/attribution/model";
import { wholeDollars } from "@/lib/format";
import { overviewData } from "@/lib/queries/overview";
import { CoverageNotice } from "./coverage-notice";

export const dynamic = "force-dynamic";

// Fixed categorical order for source dots (validated hues + neutrals).
const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

export default async function OverviewPage() {
  // The numbers live in lib/queries/overview.ts, shared with the MCP
  // `funnel_overview` tool so the two surfaces cannot disagree.
  const { touch, funnel: f, daily, topSources: top } = await overviewData(30);

  const contacts = f.contacts;
  const estimates = f.estimates;
  const won = f.won;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "—");

  const spend = daily.reduce((s, d) => s + d.spend, 0);
  const revenue = daily.reduce((s, d) => s + d.revenue, 0);
  const roas = spend > 0 ? (revenue / spend).toFixed(1) + "×" : "—";
  // Spend ÷ ESTIMATES, not ÷ contacts. Smaller denominator than the old CPL, so a
  // higher number — and an honest one: contacts include traffic no spend produced.
  const cpe = estimates > 0 && spend > 0 ? wholeDollars(Math.round(spend / estimates)) : "—";

  const chart = buildChart(daily);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Blended performance · last 30 days · {touchModelLabel(touch)}</p>
        </div>
        <div className="controls">
          <span className="pill">◷ Last 30 days ▾</span>
          <span className="pill">◍ All locations ▾</span>
        </div>
      </div>

      <CoverageNotice days={30} />

      {/* Funnel */}
      <div className="funnel">
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--muted)" }} />Contacts</div>
          <div className="st-value mono">{contacts}</div>
          <div className="st-sub">{f?.calls ?? 0} calls · {f?.forms ?? 0} forms</div>
        </div>
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--chart-spend)" }} />Estimates</div>
          <div className="st-value mono">{estimates}</div>
          {/* Deliberately NOT shown as a % of contacts: you book more estimates than
              you receive tracked contacts (repeat customers, referrals, canvassing),
              so the ratio would routinely exceed 100% and mean nothing. */}
          <div className="st-sub">visits booked, not cancelled</div>
        </div>
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--accent)" }} />Won</div>
          {estimates > 0 && <div className="st-conv">{pct(won, estimates)} close rate</div>}
          <div className="st-value mono" style={{ color: "var(--accent)" }}>{won}</div>
          <div className="st-sub">estimate approved · {wholeDollars(revenue)} revenue</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="cards">
        <div className="card kpi"><div className="label">◐ Ad spend</div><div className="value mono">{wholeDollars(spend)}</div></div>
        <div className="card kpi"><div className="label">◈ Revenue (won est.)</div><div className="value mono">{wholeDollars(revenue)}</div></div>
        <div className="card kpi accent"><div className="label">✦ ROAS</div><div className="value mono pos">{roas}</div></div>
        <div className="card kpi"><div className="label" title="Spend ÷ estimates attributed to a paid source">☎ Cost / estimate</div><div className="value mono">{cpe}</div></div>
      </div>

      {/* Chart + top sources */}
      <div className="row two">
        <div className="card">
          <div className="card-head">
            <h3>Spend vs. revenue</h3>
            <div className="legend">
              <span><i style={{ background: "var(--chart-spend)" }} />Spend</span>
              <span><i style={{ background: "var(--chart-rev)" }} />Revenue</span>
            </div>
          </div>
          <div className="card-body">
            {spend + revenue === 0 ? (
              <div className="empty" style={{ border: "none", padding: "48px 12px" }}>
                No spend or revenue yet — connect Google/Facebook (spend) and HousecallPro (revenue) in Settings.
              </div>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: chart }} />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Top sources</h3><span className="muted">by revenue</span></div>
          {top.length === 0 ? (
            <div className="empty" style={{ border: "none" }}>No source data yet.</div>
          ) : (
            <table style={{ border: "none", borderRadius: 0 }}>
              <tbody>
                {top.map((s, i) => {
                  // Spend with no revenue yet is a wait-state, not a 0.0× verdict.
                  const r =
                    s.spend > 0 && s.revenue > 0
                      ? (s.revenue / s.spend).toFixed(1) + "×"
                      : s.revenue > 0
                        ? "organic"
                        : s.spend > 0
                          ? "no rev yet"
                          : "—";
                  const winning = s.spend > 0 && s.revenue > 0;
                  return (
                    <tr key={s.key ?? i}>
                      <td><span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{s.name ?? s.key ?? "Unknown"}</span></td>
                      <td className="muted mono">{wholeDollars(s.spend)}</td>
                      <td className={winning ? "mono" : ""} style={{ color: winning ? "var(--accent)" : "var(--muted)", fontWeight: winning ? 700 : 500, fontSize: winning ? undefined : 12, textAlign: "right" }}>{r}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

/** Inline SVG area chart — 2 series (spend/revenue), one $ axis, validated hues,
 *  legend + direct end-labels (secondary encoding, so identity isn't color-alone). */
function buildChart(daily: Array<{ date: string; spend: number; revenue: number }>): string {
  const W = 640, H = 200, P = 8;
  if (daily.length === 0) return "";
  const pts = daily.length === 1 ? [daily[0], daily[0]] : daily;
  const max = Math.max(1, ...pts.map((d) => Math.max(d.spend, d.revenue)));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - P - (v / max) * (H - P * 2);

  const line = (key: "spend" | "revenue") => pts.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const area = (key: "spend" | "revenue") => `${line(key)} L${W},${H} L0,${H} Z`;

  return `
  <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Spend versus revenue over the last 30 days">
    <defs>
      <linearGradient id="gRev" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#2ea043" stop-opacity=".34"/><stop offset="1" stop-color="#2ea043" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="gSpd" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#4c8dff" stop-opacity=".22"/><stop offset="1" stop-color="#4c8dff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <g stroke="#242c37" stroke-width="1">
      <line x1="0" y1="${(H - P) * 0.25}" x2="${W}" y2="${(H - P) * 0.25}"/>
      <line x1="0" y1="${(H - P) * 0.5}" x2="${W}" y2="${(H - P) * 0.5}"/>
      <line x1="0" y1="${(H - P) * 0.75}" x2="${W}" y2="${(H - P) * 0.75}"/>
      <line x1="0" y1="${H - P}" x2="${W}" y2="${H - P}"/>
    </g>
    <path d="${area("spend")}" fill="url(#gSpd)"/>
    <path d="${line("spend")}" fill="none" stroke="#4c8dff" stroke-width="2"/>
    <path d="${area("revenue")}" fill="url(#gRev)"/>
    <path d="${line("revenue")}" fill="none" stroke="#2ea043" stroke-width="2.5"/>
    <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1].revenue).toFixed(1)}" r="3.5" fill="#2ea043"/>
  </svg>`;
}
