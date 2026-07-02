import { sql, eq, gte, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { roiDaily, sources } from "@/lib/db/schema";
import { dollars } from "@/lib/format";

export const dynamic = "force-dynamic";

const SRC_HUES = ["#2ea043", "#4c8dff", "#facc15", "#a371f7", "#e08a4c", "#8b98a5"];

export default async function RoiPage() {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const rows = await db
    .select({
      sourceKey: sources.key,
      name: sources.displayName,
      leads: sql<number>`coalesce(sum(${roiDaily.leadsCount}),0)::int`,
      qualified: sql<number>`coalesce(sum(${roiDaily.qualifiedCount}),0)::int`,
      won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(gte(roiDaily.date, since))
    .groupBy(sources.key, sources.displayName)
    .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`));

  const maxRoas = Math.max(
    1,
    ...rows.map((r) => (r.spend > 0 ? r.revenue / r.spend : 0)),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">ROI by source</h1>
          <p className="page-sub">Last 30 days · captured → qualified (estimate) → won (approved) · revenue = won estimates ÷ spend</p>
        </div>
        <div className="controls"><span className="pill">◷ Last 30 days ▾</span></div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          No ROI rows yet. These populate once ad spend (Google/Facebook) and HousecallPro
          estimates are syncing and the sync has run.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th title="Every tracked call/form">Captured</th>
              <th title="An estimate was created in HousecallPro">Qualified</th>
              <th title="Estimate approved">Won</th>
              <th>Spend</th>
              <th title="Value of won estimates">Revenue</th>
              <th title="Cost per qualified lead">CPL</th>
              <th style={{ width: 150 }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cpl = r.qualified && r.spend ? dollars(Math.round(r.spend / r.qualified)) : "—";
              const roasNum = r.spend ? r.revenue / r.spend : 0;
              const roas = r.spend ? roasNum.toFixed(1) + "×" : r.revenue > 0 ? "organic" : "—";
              return (
                <tr key={r.sourceKey ?? `u${i}`}>
                  <td><span className="src"><span className="dot" style={{ background: SRC_HUES[i % SRC_HUES.length] }} />{r.name ?? r.sourceKey ?? "Unattributed"}</span></td>
                  <td className="mono">{r.leads}</td>
                  <td className="mono">{r.qualified}</td>
                  <td>{r.won > 0 ? <span className="badge win">{r.won} won</span> : <span className="muted mono">0</span>}</td>
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
          </tbody>
        </table>
      )}
    </>
  );
}
