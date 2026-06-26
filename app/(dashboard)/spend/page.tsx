import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";
import { dateTime } from "@/lib/format";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

export default async function SpendPage() {
  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(20);

  return (
    <>
      <h1 className="page-title">Spend &amp; sync status</h1>
      <p className="page-sub">Direct sync: HousecallPro revenue + Google/Facebook spend → ROI</p>

      <SyncButton />

      <div className="empty" style={{ marginBottom: 24 }}>
        Runs HCP → spend → attribution directly against each platform API (only providers
        with configured credentials run). Add <code>HCP_API_KEY</code> first to light up
        revenue, then Google/Facebook tokens for spend &amp; ROI. Inngest cron is wired at deploy.
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
