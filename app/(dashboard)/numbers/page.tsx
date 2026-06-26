import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { numberAssignments, trackingNumbers } from "@/lib/db/schema";
import { formatPhoneDisplay } from "@/lib/phone";
import { dateTime } from "@/lib/format";
import { ProvisionForm } from "./provision-form";

export const dynamic = "force-dynamic";

export default async function NumbersPage() {
  const numbers = await db.select().from(trackingNumbers).orderBy(desc(trackingNumbers.createdAt)).limit(300);

  // Active leases (released_at null, not expired) → live pool occupancy.
  const leasedRows = await db
    .select({ tnId: numberAssignments.trackingNumberId })
    .from(numberAssignments)
    .where(and(isNull(numberAssignments.releasedAt), gt(numberAssignments.expiresAt, new Date())));
  const leasedSet = new Set(leasedRows.map((r) => r.tnId));

  // Per-pool capacity (pooled numbers only).
  const pools = new Map<string, { total: number; leased: number }>();
  for (const n of numbers) {
    if (n.isStatic || n.status !== "active") continue;
    const p = pools.get(n.pool) ?? { total: 0, leased: 0 };
    p.total++;
    if (leasedSet.has(n.id)) p.leased++;
    pools.set(n.pool, p);
  }

  const recent = await db
    .select({
      id: numberAssignments.id,
      phone: trackingNumbers.phoneNumber,
      source: numberAssignments.source,
      assignedAt: numberAssignments.assignedAt,
      expiresAt: numberAssignments.expiresAt,
      releasedAt: numberAssignments.releasedAt,
    })
    .from(numberAssignments)
    .innerJoin(trackingNumbers, eq(numberAssignments.trackingNumberId, trackingNumbers.id))
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(20);

  return (
    <>
      <h1 className="page-title">Tracking numbers</h1>
      <p className="page-sub">Twilio pools for DNI + static source trackers</p>

      <ProvisionForm />

      {pools.size > 0 && (
        <div className="cards">
          {[...pools.entries()].map(([pool, c]) => {
            const free = c.total - c.leased;
            return (
              <div className="card" key={pool}>
                <div className="label">{pool} pool</div>
                <div className="value" style={{ color: free === 0 ? "var(--danger)" : undefined }}>
                  {free}/{c.total} free
                </div>
                <div style={{ color: "var(--muted)", fontSize: 12 }}>{c.leased} leased now</div>
              </div>
            );
          })}
        </div>
      )}

      {numbers.length === 0 ? (
        <div className="empty">
          No numbers yet. Add Twilio credentials, then provision numbers into pools above
          (static numbers for GBP/print/LSA; pooled numbers power per-visitor DNI).
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
              <th>Live</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((n) => (
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
                <td>{leasedSet.has(n.id) ? "● leased" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="page-title" style={{ fontSize: 16, marginTop: 28 }}>
        Recent assignments
      </h2>
      {recent.length === 0 ? (
        <div className="empty">No DNI assignments yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Source</th>
              <th>Assigned</th>
              <th>Expires</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr key={a.id}>
                <td>{formatPhoneDisplay(a.phone)}</td>
                <td>{a.source ?? "—"}</td>
                <td>{dateTime(a.assignedAt)}</td>
                <td>{dateTime(a.expiresAt)}</td>
                <td>{a.releasedAt ? "released" : a.expiresAt < new Date() ? "expired" : "active"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
