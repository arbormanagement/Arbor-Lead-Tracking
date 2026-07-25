import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "@/lib/db/client";
import { numberAssignments, trackingNumbers } from "@/lib/db/schema";

const LEASE_MINUTES = 30;

export interface AttributionSnapshot {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  keyword?: string | null;
  /** utm_content — carries the platform ad id ({creative} / {{ad.id}}). */
  content?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  landingPage?: string | null;
}

export interface LeaseResult {
  phoneNumber: string;
  assignmentId: string | null;
  reused: boolean;
}

/** Release leases whose window has elapsed so their numbers return to the pool. */
export async function releaseExpired(): Promise<void> {
  await db
    .update(numberAssignments)
    .set({ releasedAt: new Date() })
    .where(and(isNull(numberAssignments.releasedAt), lt(numberAssignments.expiresAt, new Date())));
}

/** A visitor revisiting within their session keeps the same number (one consistent
 *  number across pages). Extends the lease window on reuse. */
export async function getActiveAssignmentForSession(sid: string): Promise<LeaseResult | null> {
  const [row] = await db
    .select({
      id: numberAssignments.id,
      phone: trackingNumbers.phoneNumber,
    })
    .from(numberAssignments)
    .innerJoin(trackingNumbers, eq(numberAssignments.trackingNumberId, trackingNumbers.id))
    .where(
      and(
        eq(numberAssignments.webSessionId, sid),
        isNull(numberAssignments.releasedAt),
        gt(numberAssignments.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(1);

  if (!row) return null;
  await db
    .update(numberAssignments)
    .set({ expiresAt: new Date(Date.now() + LEASE_MINUTES * 60_000) })
    .where(eq(numberAssignments.id, row.id));
  return { phoneNumber: row.phone, assignmentId: row.id, reused: true };
}

/**
 * Atomically lease a free number from the single shared website pool — every
 * non-static active number is part of one rotation (CallRail-style); the visitor's
 * source is frozen onto the lease, not derived from the number, so a call resolves
 * to the exact source regardless of which number was handed out. A single statement:
 * a CTE picks one unleased number with FOR UPDATE SKIP LOCKED, a data-modifying CTE
 * inserts the assignment, and the final SELECT returns the phone — so concurrent
 * callers never grab the same number, with no interactive transaction (HTTP-driver
 * friendly). Returns null when the pool is exhausted.
 */
export async function leaseNumber(snap: AttributionSnapshot, sid: string, vid: string): Promise<LeaseResult | null> {
  const id = ulid();
  const q = sql`
    WITH picked AS (
      SELECT tn.id AS tn_id
      FROM tracking_numbers tn
      WHERE tn.status = 'active'
        AND tn.is_static = false
        AND NOT EXISTS (
          SELECT 1 FROM number_assignments na
          WHERE na.tracking_number_id = tn.id
            AND na.released_at IS NULL
            AND na.expires_at > now()
        )
      ORDER BY tn.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ),
    ins AS (
      INSERT INTO number_assignments
        (id, tracking_number_id, web_session_id, visitor_id, assigned_at, expires_at,
         source, medium, campaign, keyword, content, gclid, fbclid, landing_page, created_at)
      SELECT ${id}, tn_id, ${sid}, ${vid}, now(), now() + make_interval(mins => ${LEASE_MINUTES}),
         ${snap.source ?? null}, ${snap.medium ?? null}, ${snap.campaign ?? null}, ${snap.keyword ?? null},
         ${snap.content ?? null}, ${snap.gclid ?? null}, ${snap.fbclid ?? null}, ${snap.landingPage ?? null}, now()
      FROM picked
      RETURNING id AS assignment_id, tracking_number_id
    )
    SELECT ins.assignment_id, tn.phone_number
    FROM ins JOIN tracking_numbers tn ON tn.id = ins.tracking_number_id
  `;

  const res = await db.execute(q);
  const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  const row = rows[0] as { assignment_id: string; phone_number: string } | undefined;
  if (!row) return null;
  return { phoneNumber: row.phone_number, assignmentId: row.assignment_id, reused: false };
}

/**
 * Pool-exhaustion fallback: any static number we own, so the page still shows a
 * tracked number and the call resolves to that number's static source. Returns null
 * if we have no static number — then the page keeps its own hard-coded number.
 */
export async function getFallbackNumber(): Promise<LeaseResult | null> {
  const [row] = await db
    .select({ phone: trackingNumbers.phoneNumber })
    .from(trackingNumbers)
    .where(and(eq(trackingNumbers.isStatic, true), eq(trackingNumbers.status, "active")))
    .orderBy(trackingNumbers.createdAt)
    .limit(1);
  if (!row) return null;
  return { phoneNumber: row.phone, assignmentId: null, reused: false };
}
