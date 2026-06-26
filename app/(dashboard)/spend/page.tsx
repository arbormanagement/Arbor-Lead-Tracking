import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SpendPage() {
  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(20);

  return (
    <>
      <h1 className="page-title">Spend &amp; sync status</h1>
      <p className="page-sub">Ad spend pulled from Google &amp; Facebook via the Arbor MCP server</p>

      <div className="empty" style={{ marginBottom: 24 }}>
        Spend ingestion lands in Phase 2 — the <code>spend.sync.daily</code> Inngest job
        upserts <code>ad_spend</code> from <code>googleads_get_campaign_performance</code> and{" "}
        <code>facebook_ads_get_campaign_insights</code>.
      </div>

      <h2 className="page-title" style={{ fontSize: 16 }}>
        Recent sync runs
      </h2>
      {runs.length === 0 ? (
        <div className="empty">No sync runs recorded yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.job}</td>
                <td>
                  <span className="badge">{r.status}</span>
                </td>
                <td>{dateTime(r.startedAt)}</td>
                <td>{dateTime(r.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
