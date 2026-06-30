import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, numberAssignments, pools as poolsTable, sources, trackingNumbers } from "@/lib/db/schema";
import { formatPhoneDisplay } from "@/lib/phone";
import { dateTime } from "@/lib/format";
import { getTwilioConfig } from "@/lib/twilio/client";
import { env } from "@/lib/env";
import { AddNumberFlow } from "./add-number-flow";
import { NumbersTable } from "./numbers-table";
import { PoolsManager } from "./pools-manager";

export const dynamic = "force-dynamic";

export default async function NumbersPage() {
  const numbers = await db.select().from(trackingNumbers).orderBy(desc(trackingNumbers.createdAt)).limit(300);

  // Source key per static number (for display + the editor).
  const srcRows = await db.select({ id: sources.id, key: sources.key, displayName: sources.displayName }).from(sources);
  const srcById = new Map(srcRows.map((s) => [s.id, s.key]));

  // User-managed pools (drive the dropdowns + the pool manager).
  const poolRows = await db.select().from(poolsTable).orderBy(poolsTable.key);
  const poolOpts = poolRows.map((p) => ({ key: p.key, displayName: p.displayName, isDni: p.isDni }));
  // Live number count per pool (for the manager).
  const poolCounts = await db
    .select({ pool: trackingNumbers.pool, count: sql<number>`count(*)::int` })
    .from(trackingNumbers)
    .groupBy(trackingNumbers.pool);
  const poolCountByKey = new Map(poolCounts.map((p) => [p.pool, p.count]));

  // Call activity per number (count + last call) — the CallRail-style activity column.
  const activity = await db
    .select({
      tnId: calls.trackingNumberId,
      count: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${calls.createdAt})`,
    })
    .from(calls)
    .groupBy(calls.trackingNumberId);
  const activityById = new Map(activity.map((a) => [a.tnId, a]));

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

  const officeDefault =
    (await getTwilioConfig()).defaultDestination ?? env.TWILIO_DEFAULT_DESTINATION ?? "";

  const rows = numbers.map((n) => {
    const a = activityById.get(n.id);
    return {
      id: n.id,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      pool: n.pool,
      status: n.status,
      isStatic: n.isStatic,
      location: n.location ?? "unknown",
      sourceKey: n.staticSourceId ? srcById.get(n.staticSourceId) ?? null : null,
      forwardDestination: n.forwardDestination,
      whisperMessage: n.whisperMessage,
      recordCalls: n.recordCalls,
      leased: leasedSet.has(n.id),
      callCount: a?.count ?? 0,
      lastCallAt: a?.last ? dateTime(a.last as Date) : null,
    };
  });

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

  const sourceOpts = srcRows.map((s) => ({ key: s.key, displayName: s.displayName }));

  return (
    <>
      <h1 className="page-title">Tracking numbers</h1>
      <p className="page-sub">
        Buy a number, name it for a source, set where it rings — calls land in /leads attributed to that source.
      </p>

      <AddNumberFlow sources={sourceOpts} pools={poolOpts} officeDefault={officeDefault} />

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

      {rows.length === 0 ? (
        <div className="empty">
          No numbers yet. Use “Add tracking number” above — buy a local 618 number, name it
          (e.g. “GBP Edwardsville”), and pick where it forwards.
        </div>
      ) : (
        <NumbersTable rows={rows} sources={sourceOpts} pools={poolOpts} officeDefault={officeDefault} />
      )}

      <PoolsManager
        pools={poolRows.map((p) => ({
          key: p.key,
          displayName: p.displayName,
          description: p.description,
          isDni: p.isDni,
          numberCount: poolCountByKey.get(p.key) ?? 0,
        }))}
      />

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
