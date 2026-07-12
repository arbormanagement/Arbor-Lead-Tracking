import { and, desc, eq, gte, isNotNull, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { calls, leads, roiDaily, sources, trackingNumbers } from "@/lib/db/schema";
import { dollars } from "@/lib/format";
import { TIMEFRAMES, pickDays, timeframeLabel } from "@/lib/timeframes";
import { FormsClient } from "../settings/facebook-forms/forms-client";

export const dynamic = "force-dynamic";

const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

export default async function SourcesPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams;
  const days = pickDays(daysParam, 30);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // Performance by source (30d).
  const rows = await db
    .select({
      key: sources.key,
      name: sources.displayName,
      leads: sql<number>`coalesce(sum(${roiDaily.leadsCount}),0)::int`,
      quoted: sql<number>`coalesce(sum(${roiDaily.qualifiedCount}),0)::int`,
      won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(gte(roiDaily.date, since))
    .groupBy(sources.key, sources.displayName)
    .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`));

  const totals = rows.reduce(
    (a, r) => ({ leads: a.leads + r.leads, quoted: a.quoted + r.quoted, won: a.won + r.won, spend: a.spend + r.spend, revenue: a.revenue + r.revenue }),
    { leads: 0, quoted: 0, won: 0, spend: 0, revenue: 0 },
  );
  const maxRoas = Math.max(1, ...rows.map((r) => (r.spend > 0 ? r.revenue / r.spend : 0)));

  // Breakdown dimensions (90d): landing page + keyword (captured on the lead by
  // track.js / click-id enrichment) and the caller's self-reported source from
  // call transcripts — the DNI-invisible channels (referrals, yard signs, trucks).
  const bdSince = new Date(Date.now() - 90 * 86_400_000);
  const leadOnly = or(ne(leads.type, "call"), eq(leads.isLead, true));
  const breakdownOf = (col: AnyPgColumn) =>
    db
      .select({
        value: sql<string | null>`${col}`,
        leads: sql<number>`count(*)::int`,
        won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
        revenue: sql<number>`coalesce(sum(${leads.salesValueCents}) filter (where ${leads.status} = 'won'), 0)::int`,
      })
      .from(leads)
      .where(and(gte(leads.occurredAt, bdSince), eq(leads.isSpam, false), leadOnly, isNotNull(col), ne(col, "")))
      .groupBy(col)
      .orderBy(desc(sql`count(*)`))
      .limit(8);

  const [byLanding, byKeyword, bySelfReported] = await Promise.all([
    breakdownOf(leads.landingPage),
    breakdownOf(leads.keyword),
    breakdownOf(leads.selfReportedSource),
  ]);

  // Tracking-number summary (capture channel).
  const [numAgg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${trackingNumbers.status} = 'active')::int`,
      pool: sql<number>`count(*) filter (where not ${trackingNumbers.isStatic} and ${trackingNumbers.status} = 'active')::int`,
    })
    .from(trackingNumbers);
  const [callCount] = await db.select({ n: sql<number>`count(*)::int` }).from(calls);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Sources</h1>
          <p className="page-sub">Where leads come from, how they perform, and which channels feed the inbox · {timeframeLabel(days)}</p>
        </div>
        <div className="controls">
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>◷</span>
          {TIMEFRAMES.map((t) => (
            <Link
              key={t.days}
              href={t.days === 30 ? "/sources" : `/sources?days=${t.days}`}
              className="pill"
              style={days === t.days ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" } : undefined}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

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
              <th title="Every tracked lead">Leads</th>
              <th title="An estimate with a price was sent">Quoted</th>
              <th title="Estimate approved">Won</th>
              <th>Spend</th>
              <th title="Value of won estimates">Revenue</th>
              <th title="Cost per quoted lead">CPL</th>
              <th style={{ width: 150 }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cpl = r.quoted && r.spend ? dollars(Math.round(r.spend / r.quoted)) : "—";
              const roasNum = r.spend ? r.revenue / r.spend : 0;
              const roas = r.spend ? roasNum.toFixed(1) + "×" : r.revenue > 0 ? "organic" : "—";
              return (
                <tr key={r.key ?? `u${i}`}>
                  <td><span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{r.name ?? r.key ?? "Unattributed"}</span></td>
                  <td className="mono">{r.leads}</td>
                  <td className="mono">{r.quoted}</td>
                  <td>{r.won > 0 ? <span className="badge win">{r.won}</span> : <span className="muted mono">0</span>}</td>
                  <td className="mono muted">{dollars(r.spend)}</td>
                  <td className="mono">{r.revenue > 0 ? dollars(r.revenue) : <span className="muted">—</span>}</td>
                  <td className="mono muted">{cpl}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="mono" style={{ color: r.spend ? "var(--accent)" : "var(--muted)", fontWeight: 700, minWidth: 42 }}>{roas}</span>
                      {r.spend > 0 && <span className="bar"><i style={{ width: Math.max(4, Math.min(100, (roasNum / maxRoas) * 100)) + "%" }} /></span>}
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td>
              <td className="mono">{totals.leads}</td>
              <td className="mono">{totals.quoted}</td>
              <td className="mono">{totals.won}</td>
              <td className="mono muted">{dollars(totals.spend)}</td>
              <td className="mono">{dollars(totals.revenue)}</td>
              <td className="mono muted">{totals.quoted && totals.spend ? dollars(Math.round(totals.spend / totals.quoted)) : "—"}</td>
              <td className="mono" style={{ color: "var(--accent)" }}>{totals.spend ? (totals.revenue / totals.spend).toFixed(1) + "×" : "—"}</td>
            </tr>
          </tbody>
        </table>
        </div>
      )}

      {/* Breakdowns: landing pages, keywords, self-reported */}
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 4 }}>Breakdowns</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Last 90 days · landing pages &amp; keywords come from web tracking; “callers say” is the AI-extracted answer to
        “how did you hear about us” — catches referrals, yard signs, and trucks that number-tracking can&apos;t see.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 26 }}>
        <BreakdownCard title="◧ Landing pages" rows={byLanding} empty="No landing pages captured yet — populates once track.js is live." />
        <BreakdownCard title="⌕ Keywords" rows={byKeyword} empty="No keywords captured yet — populates from paid-search leads." />
        <BreakdownCard title="☏ Callers say" rows={bySelfReported} empty="No self-reported sources yet — extracted from call transcripts." />
      </div>

      {/* Capture channels */}
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 4 }}>Capture channels</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>The sources that feed leads into the inbox.</p>

      <div className="cards" style={{ marginBottom: 22 }}>
        <Link href="/numbers" className="card pad" style={{ display: "block" }}>
          <div className="label">☎ Call tracking →</div>
          <div className="value" style={{ fontSize: 20 }}>{numAgg?.active ?? 0} active</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{numAgg?.pool ?? 0} in website pool · {callCount?.n ?? 0} calls tracked</div>
        </Link>
        <Link href="/settings/integrations" className="card pad" style={{ display: "block" }}>
          <div className="label">✉ Web forms →</div>
          <div className="value" style={{ fontSize: 20 }}>track.js</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>install on arbor-mgmt.com to capture web-form leads</div>
        </Link>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 650, margin: "8px 0 12px" }}>ⓕ Facebook lead forms</h3>
      <FormsClient />
    </>
  );
}

function BreakdownCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ value: string | null; leads: number; won: number; revenue: number }>;
  empty: string;
}) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3><span className="muted">leads · won · revenue</span></div>
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
                <td className="mono" style={{ width: 40 }}>{r.leads}</td>
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
