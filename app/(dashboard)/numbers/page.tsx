import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { trackingNumbers } from "@/lib/db/schema";
import { formatPhoneDisplay } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function NumbersPage() {
  const rows = await db
    .select()
    .from(trackingNumbers)
    .orderBy(desc(trackingNumbers.createdAt))
    .limit(200);

  return (
    <>
      <h1 className="page-title">Tracking numbers</h1>
      <p className="page-sub">Twilio number pools for DNI + static source trackers</p>

      {rows.length === 0 ? (
        <div className="empty">
          No numbers provisioned yet. Add Twilio credentials, then provision numbers into
          per-channel pools (Phase 1 uses static source numbers; Phase 4 adds pooled DNI).
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Pool</th>
              <th>Type</th>
              <th>Location</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>{formatPhoneDisplay(n.phoneNumber)}</td>
                <td>
                  <span className="badge">{n.pool}</span>
                </td>
                <td>{n.isStatic ? "static" : "pooled"}</td>
                <td>{n.location}</td>
                <td>
                  <span className="badge">{n.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
