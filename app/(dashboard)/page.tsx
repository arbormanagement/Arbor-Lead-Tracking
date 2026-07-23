import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, roiDaily, sources } from "@/lib/db/schema";
import { dollars } from "@/lib/format";

export const dynamic = "force-dynamic";

// Fixed categorical order for source dots (validated hues + neutrals).
const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

export default async function OverviewPage() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const sinceDate = since.toISOString().slice(0, 10);

  // Funnel: captured → qualified (estimate created) → won (approved).
  const [f] = await db
    .select({
      captured: sql<number>`count(*)::int`,
      calls: sql<number>`count(*) filter (where ${leads.type} = 'call')::int`,
      forms: sql<number>`count(*) filter (where ${leads.type} = 'web_form')::int`,
      quoted: sql<number>`count(*) filter (where ${leads.quoteValueCents} > 0)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(and(gte(leads.occurredAt, since), eq(leads.isSpam, false), or(ne(leads.type, "call"), eq(leads.isLead, true))));

  const captured = f?.captured ?? 0;
  const quoted = f?.quoted ?? 0;
  const won = f?.won ?? 0;
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) + "%" : "—");

  // Daily spend/revenue for the chart + totals.
  const daily = await db
    .select({
      date: roiDaily.date,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .where(gte(roiDaily.date, sinceDate))
    .groupBy(roiDaily.date)
    .orderBy(roiDaily.date);

  const spend = daily.reduce((s, d) => s + d.spend, 0);
  const revenue = daily.reduce((s, d) => s + d.revenue, 0);
  const roas = spend > 0 ? (revenue / spend).toFixed(1) + "×" : "—";
  // Ads-Manager-style CPL: spend ÷ captured leads (not per-quoted).
  const cpl = captured > 0 && spend > 0 ? dollars(Math.round(spend / captured)) : "—";

  // Top sources by revenue.
  const top = await db
    .select({
      key: sources.key,
      name: sources.displayName,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(gte(roiDaily.date, sinceDate))
    .groupBy(sources.key, sources.displayName)
    .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`))
    .limit(6);

  const chart = buildChart(daily);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">Blended performance · last 30 days · Edwardsville + O&apos;Fallon</p>
        </div>
        <div className="controls">
          <span className="pill">◷ Last 30 days ▾</span>
          <span className="pill">◍ All locations ▾</span>
        </div>
      </div>

      {/* Funnel */}
      <div className="funnel">
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--muted)" }} />Captured</div>
          <div className="st-value mono">{captured}</div>
          <div className="st-sub">{f?.calls ?? 0} calls · {f?.forms ?? 0} forms</div>
        </div>
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--chart-spend)" }} />Quoted</div>
          {captured > 0 && <div className="st-conv">{pct(quoted, captured)} of captured</div>}
          <div className="st-value mono">{quoted}</div>
          <div className="st-sub">estimate with a price sent</div>
        </div>
        <div className="stage">
          <div className="st-label"><span className="st-dot" style={{ background: "var(--accent)" }} />Won</div>
          {quoted > 0 && <div className="st-conv">{pct(won, quoted)} close rate</div>}
          <div className="st-value mono" style={{ color: "var(--accent)" }}>{won}</div>
          <div className="st-sub">estimate approved · {dollars(revenue)} revenue</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="cards">
        <div className="card kpi"><div className="label">◐ Ad spend</div><div className="value mono">{dollars(spend)}</div></div>
        <div className="card kpi"><div className="label">◈ Revenue (won est.)</div><div className="value mono">{dollars(revenue)}</div></div>
        <div className="card kpi accent"><div className="label">✦ ROAS</div><div className="value mono pos">{roas}</div></div>
        <div className="card kpi"><div className="label" title="Spend ÷ captured leads — matches Ads Manager">☎ Cost / lead</div><div className="value mono">{cpl}</div></div>
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
                  const r = s.spend > 0 ? (s.revenue / s.spend).toFixed(1) + "×" : s.revenue > 0 ? "organic" : "—";
                  return (
                    <tr key={s.key ?? i}>
                      <td><span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{s.name ?? s.key ?? "Unknown"}</span></td>
                      <td className="muted mono">{dollars(s.spend)}</td>
                      <td className="mono" style={{ color: s.spend > 0 ? "var(--accent)" : "var(--muted)", fontWeight: 700, textAlign: "right" }}>{r}</td>
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
