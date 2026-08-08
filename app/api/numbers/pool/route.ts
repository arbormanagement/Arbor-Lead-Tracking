import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import { numberAssignments, sources, trackingNumbers } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * DNI pool health.
 *
 * Built after an hour of guessing. When the pool is exhausted the fallback hands
 * out the `direct` number — which is the SAME number the site hard-codes. So
 * "DNI is broken" and "DNI worked and gave you the fallback" look identical from
 * the page, and the only way to tell them apart was reading server logs.
 *
 * `free === 0` is the whole answer to "why am I still seeing 618-205-3094".
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const now = new Date();

  const poolRows = await db
    .select({
      id: trackingNumbers.id,
      phoneNumber: trackingNumbers.phoneNumber,
      status: trackingNumbers.status,
      leaseId: numberAssignments.id,
      expiresAt: numberAssignments.expiresAt,
      leaseSource: numberAssignments.source,
      leaseGclid: numberAssignments.gclid,
    })
    .from(trackingNumbers)
    .leftJoin(
      numberAssignments,
      and(
        eq(numberAssignments.trackingNumberId, trackingNumbers.id),
        isNull(numberAssignments.releasedAt),
        gt(numberAssignments.expiresAt, now),
      ),
    )
    .where(and(eq(trackingNumbers.isStatic, false), eq(trackingNumbers.status, "active")))
    .orderBy(trackingNumbers.createdAt);

  const numbers = poolRows.map((r) => ({
    phoneNumber: r.phoneNumber,
    leased: !!r.leaseId,
    expiresAt: r.expiresAt,
    secondsUntilFree: r.expiresAt ? Math.max(0, Math.round((+r.expiresAt - +now) / 1000)) : null,
    leaseSource: r.leaseSource,
    leaseHasGclid: !!r.leaseGclid,
  }));

  const leased = numbers.filter((n) => n.leased).length;
  const free = numbers.length - leased;

  // What a visitor would be handed right now if the pool could not serve them —
  // mirrors getFallbackNumber(), which excludes `test` and prefers `direct`.
  const staticRows = await db
    .select({ phoneNumber: trackingNumbers.phoneNumber, sourceKey: sources.key })
    .from(trackingNumbers)
    .leftJoin(sources, eq(sources.id, trackingNumbers.staticSourceId))
    .where(and(eq(trackingNumbers.isStatic, true), eq(trackingNumbers.status, "active")))
    .orderBy(trackingNumbers.createdAt);
  const usable = staticRows.filter((r) => r.sourceKey !== "test");
  const fallback = usable.find((r) => r.sourceKey === "direct") ?? usable[0] ?? null;

  const [{ count: activeLeases } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(numberAssignments)
    .where(and(isNull(numberAssignments.releasedAt), gt(numberAssignments.expiresAt, now)));

  const recent = await db
    .select({
      phoneNumber: trackingNumbers.phoneNumber,
      assignedAt: numberAssignments.assignedAt,
      expiresAt: numberAssignments.expiresAt,
      releasedAt: numberAssignments.releasedAt,
      source: numberAssignments.source,
      gclid: numberAssignments.gclid,
    })
    .from(numberAssignments)
    .innerJoin(trackingNumbers, eq(trackingNumbers.id, numberAssignments.trackingNumberId))
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(10);

  return Response.json({
    ok: true,
    poolSize: numbers.length,
    leased,
    free,
    exhausted: free === 0,
    // The trap worth stating outright: when this is true, a visitor sees the
    // fallback number, which for `direct` is identical to the site's hard-coded
    // one — so a working swap is indistinguishable from a broken one.
    fallbackNumber: fallback?.phoneNumber ?? null,
    fallbackSource: fallback?.sourceKey ?? null,
    activeLeasesTotal: activeLeases,
    numbers,
    recentAssignments: recent,
  });
}
