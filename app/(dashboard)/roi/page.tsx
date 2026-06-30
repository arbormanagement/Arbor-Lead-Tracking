import { sql, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { roiDaily, sources } from "@/lib/db/schema";
import { dollars } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RoiPage() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = await db
    .select({
      sourceKey: sources.key,
      leads: sql<number>`coalesce(sum(${roiDaily.leadsCount}),0)::int`,
      calls: sql<number>`coalesce(sum(${roiDaily.callsCount}),0)::int`,
      forms: sql<number>`coalesce(sum(${roiDaily.formsCount}),0)::int`,
      won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
    .where(sql`${roiDaily.date} >= ${since}`)
    .groupBy(sources.key)
    .orderBy(sql`coalesce(sum(${roiDaily.revenueCents}),0) desc`);

  return (
    <>
      <h1 className="page-title">ROI by source</h1>
      <p className="page-sub">
        Last 30 days · last-touch attribution · revenue = won estimates (customer-approved) ÷ spend
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          No ROI rows yet. These populate once ad spend (Google/Facebook) and HousecallPro
          estimates are syncing and the attribution job has run.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Leads</th>
              <th>Calls</th>
              <th>Forms</th>
              <th title="Estimates won (customer-approved)">Won</th>
              <th>Spend</th>
              <th title="Value of won estimates">Revenue</th>
              <th>CPL</th>
              <th>ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cpl = r.leads ? dollars(Math.round(r.spend / r.leads)) : "—";
              const roi = r.spend ? (r.revenue / r.spend).toFixed(2) + "×" : "—";
              return (
                <tr key={r.sourceKey ?? "unknown"}>
                  <td>{r.sourceKey ?? "unattributed"}</td>
                  <td>{r.leads}</td>
                  <td>{r.calls}</td>
                  <td>{r.forms}</td>
                  <td>{r.won}</td>
                  <td>{dollars(r.spend)}</td>
                  <td>{dollars(r.revenue)}</td>
                  <td>{cpl}</td>
                  <td>{roi}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
