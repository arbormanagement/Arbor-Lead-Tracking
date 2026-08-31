import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "@/lib/db/client";
import { numberAssignments, sources, trackingNumbers } from "@/lib/db/schema";

/**
 * How long a number stays out AFTER a visitor's last pageview — `getActiveAssignmentForSession`
 * pushes this window forward on every pageview, so an actively browsing visitor never loses
 * their number. This is idle time only.
 *
 * It is also the pool's real capacity control: numbers ÷ hold time = visitors servable per
 * hour. At 30 minutes, five numbers served ~7.5 visitors/hour against a measured peak of 9,
 * so the pool sat exhausted through every busy hour and those visitors were handed the static
 * fallback — which is the site's own hard-coded number, making their sessions indistinguishable
 * from untracked direct traffic.
 *
 * 15 matches what CallRail's published sizing rule implies (pool = peak hourly visitors ÷ 4,
 * minimum 4 — i.e. each number recycles ~4×/hour). Arbor's peak is 9/hour, so that rule returns
 * the 4-number minimum and the existing 5 numbers are sufficient: this is a hold-time problem,
 * not a pool-size one. Halving it roughly doubles capacity to ~20 visitors/hour for no cost.
 *
 * The cost of shortening is a visitor who loads a page, idles past the window, then dials the
 * number still on screen after it has been re-leased — their call resolves to the new lease's
 * source. That trade is why this isn't shorter still.
 */
const LEASE_MINUTES = 15;
/** Cookie-blocked browsers mint a fresh sid per pageview; this caps the damage. Note it also
 *  means one visitor can hold two numbers, where CallRail assigns one per session — the next
 *  lever to pull if exhaustion returns after the hold-time fix. */
const MAX_ACTIVE_LEASES_PER_VISITOR = 2;

export interface AttributionSnapshot {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  keyword?: string | null;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
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
/**
 * Hand back every live lease held by ONE session.
 *
 * Exists for the DNI canary, which leases a real number every run to prove the pool
 * still works and must not then sit on it for the full window — six numbers cannot
 * spare one to a robot. Scoped to `web_session_id` on purpose: when the canary is
 * handed a SHARED lease (`findShareableLease`) the row belongs to a real visitor and
 * matches nothing here, so this can never release a number out from under a customer
 * mid-visit.
 */
export async function releaseSessionLeases(sid: string): Promise<number> {
  const released = await db
    .update(numberAssignments)
    .set({ releasedAt: new Date() })
    .where(and(eq(numberAssignments.webSessionId, sid), isNull(numberAssignments.releasedAt)))
    .returning({ id: numberAssignments.id });
  return released.length;
}

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
 * Per-visitor lease cap — a visitor churning session ids (cookie-blocked browsers
 * mint a fresh sid per pageview) must not drain the pool. At/over the cap this
 * returns their newest active lease so the page still shows a consistent tracked
 * number; under the cap it returns null and the caller leases normally.
 */
export async function getNewestAssignmentAtVisitorCap(vid: string): Promise<LeaseResult | null> {
  const rows = await db
    .select({
      id: numberAssignments.id,
      phone: trackingNumbers.phoneNumber,
    })
    .from(numberAssignments)
    .innerJoin(trackingNumbers, eq(numberAssignments.trackingNumberId, trackingNumbers.id))
    .where(
      and(
        eq(numberAssignments.visitorId, vid),
        isNull(numberAssignments.releasedAt),
        gt(numberAssignments.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(MAX_ACTIVE_LEASES_PER_VISITOR);

  if (rows.length < MAX_ACTIVE_LEASES_PER_VISITOR) return null;
  return { phoneNumber: rows[0]!.phone, assignmentId: rows[0]!.id, reused: true };
}

/**
 * Hand back a number already leased to someone whose attribution is IDENTICAL to this
 * visitor's, instead of spending a second number to say the same thing.
 *
 * The pool exists to tell SOURCES apart. Two visitors who both resolve to `direct` with no
 * click id, no campaign and no keyword are already indistinguishable in every report the app
 * produces — `roi_daily` keys on (date, source, campaign), and both would land on
 * the same row. Giving them separate numbers buys nothing and consumes the capacity that a
 * visitor arriving on a gclid genuinely needs, because that one cannot be shared with anybody.
 *
 * Checked BEFORE leasing, not as an exhaustion fallback. Sharing only on exhaustion would be
 * too late to help — the numbers would already be spent — and it would make a visitor's
 * displayed number depend on how full the pool happened to be when they landed.
 *
 * What this deliberately gives up: the shared caller's lead links to the other session's
 * `landing_page`, since `/voice` resolves the newest assignment on the number. That is a
 * coarser answer to "which page drove this call", never a wrong one to "which source did".
 * Candidates on the same landing page are preferred first, so it usually costs nothing at all.
 *
 * A click id is never shared in either direction: it identifies one specific ad click, so two
 * visitors behind it is a wrong answer rather than a coarse one.
 */
export async function findShareableLease(snap: AttributionSnapshot): Promise<LeaseResult | null> {
  if (snap.gclid || snap.gbraid || snap.wbraid || snap.fbclid) return null;

  // IS NOT DISTINCT FROM, because these columns are routinely null and `= null` is never true —
  // plain equality would match nothing and silently disable sharing for exactly the direct /
  // organic traffic it exists to serve.
  const [row] = await db
    .select({ id: numberAssignments.id, phone: trackingNumbers.phoneNumber })
    .from(numberAssignments)
    .innerJoin(trackingNumbers, eq(trackingNumbers.id, numberAssignments.trackingNumberId))
    .where(
      and(
        isNull(numberAssignments.releasedAt),
        gt(numberAssignments.expiresAt, new Date()),
        isNull(numberAssignments.gclid),
        isNull(numberAssignments.gbraid),
        isNull(numberAssignments.wbraid),
        isNull(numberAssignments.fbclid),
        sql`${numberAssignments.source} IS NOT DISTINCT FROM ${snap.source ?? null}`,
        sql`${numberAssignments.medium} IS NOT DISTINCT FROM ${snap.medium ?? null}`,
        sql`${numberAssignments.campaign} IS NOT DISTINCT FROM ${snap.campaign ?? null}`,
        sql`${numberAssignments.keyword} IS NOT DISTINCT FROM ${snap.keyword ?? null}`,
      ),
    )
    .orderBy(sql`(${numberAssignments.landingPage} IS NOT DISTINCT FROM ${snap.landingPage ?? null}) DESC`, desc(numberAssignments.assignedAt))
    .limit(1);

  if (!row) return null;

  // Push the window forward as if this were the holder's own pageview. Without it the number
  // on a sharer's screen can expire mid-visit and be re-leased to someone else, which is the
  // one way sharing could turn a coarse answer into a wrong one.
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
  // `number_assignments_active_idx` is UNIQUE, so the residual double-lease race
  // (two visitors passing the NOT EXISTS check against their own snapshots) now
  // surfaces as a unique violation instead of silently handing both the same
  // number. Losing that race just means someone else took this number first —
  // retry and the CTE picks the next free one. Bounded so an exhausted pool or a
  // genuine defect can't spin.
  for (let attempt = 0; ; attempt++) {
    try {
      return await leaseOnce(snap, sid, vid);
    } catch (err) {
      if (attempt >= LEASE_RACE_RETRIES || !isActiveLeaseConflict(err)) throw err;
    }
  }
}

const LEASE_RACE_RETRIES = 3;

/** Postgres unique_violation on the one-active-lease-per-number index. */
function isActiveLeaseConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string; cause?: unknown };
  if (e.code === "23505") return true;
  // Some drivers (neon-http) wrap the driver error; fall back to the constraint name.
  if (typeof e.message === "string" && e.message.includes("number_assignments_active_idx")) return true;
  return e.cause ? isActiveLeaseConflict(e.cause) : false;
}

async function leaseOnce(snap: AttributionSnapshot, sid: string, vid: string): Promise<LeaseResult | null> {
  // Fresh id per attempt — reusing one would turn a retry into a PK collision.
  const id = ulid();
  const q = sql`
    WITH picked AS (
      SELECT tn.id AS tn_id
      FROM tracking_numbers tn
      -- Only pools explicitly flagged for website DNI rotate. Without this join
      -- every active non-static number is in rotation the moment it is bought,
      -- including one provisioned for a mailer or billboard that the admin has
      -- not yet marked static — its callers would then resolve to a random web
      -- session's attribution. New numbers default to pool 'reserved' (is_dni
      -- false), so they now stay out until deliberately placed in a DNI pool.
      JOIN pools p ON p.key = tn.pool AND p.is_dni = true
      WHERE tn.status = 'active'
        AND tn.is_static = false
        AND NOT EXISTS (
          SELECT 1 FROM number_assignments na
          WHERE na.tracking_number_id = tn.id
            AND na.released_at IS NULL
            AND na.expires_at > now()
        )
      -- Least-recently-released first (never-leased numbers before any recycled
      -- one), so a stale tab still showing an expired number has the longest
      -- possible window before that number is handed to someone else.
      ORDER BY (
        SELECT MAX(na2.released_at) FROM number_assignments na2
        WHERE na2.tracking_number_id = tn.id
      ) ASC NULLS FIRST, tn.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    ),
    ins AS (
      INSERT INTO number_assignments
        (id, tracking_number_id, web_session_id, visitor_id, assigned_at, expires_at,
         source, medium, campaign, keyword, gclid, gbraid, wbraid, fbclid, landing_page, created_at)
      SELECT ${id}, tn_id, ${sid}, ${vid}, now(), now() + make_interval(mins => ${LEASE_MINUTES}),
         ${snap.source ?? null}, ${snap.medium ?? null}, ${snap.campaign ?? null}, ${snap.keyword ?? null},
         ${snap.gclid ?? null}, ${snap.gbraid ?? null}, ${snap.wbraid ?? null},
         ${snap.fbclid ?? null}, ${snap.landingPage ?? null}, now()
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
 * Pool-exhaustion fallback: a static number we own, so the page still shows a
 * tracked number and the call resolves to that number's static source. Returns null
 * if we have no usable static number — then the page keeps its own hard-coded number.
 *
 * Choosing by `createdAt` was actively harmful: the oldest static row is the TEST
 * line (+1 618 427 8164, created long before the ten transferred numbers), so every
 * exhausted-pool visitor was shown the test number and their call was attributed to
 * source `test` — losing the real source and click id, and polluting reporting with
 * customer calls. Observed live 2026-08-08.
 *
 * So: never hand out the test line, and prefer the number that is genuinely the
 * site's public default (`direct`) over whatever happens to sort first.
 */
const FALLBACK_EXCLUDED_SOURCES = ["test"];
const FALLBACK_PREFERRED_SOURCE = "direct";

export async function getFallbackNumber(): Promise<LeaseResult | null> {
  const rows = await db
    .select({ phone: trackingNumbers.phoneNumber, sourceKey: sources.key })
    .from(trackingNumbers)
    .leftJoin(sources, eq(sources.id, trackingNumbers.staticSourceId))
    .where(and(eq(trackingNumbers.isStatic, true), eq(trackingNumbers.status, "active")))
    .orderBy(trackingNumbers.createdAt);

  const usable = rows.filter((r) => !FALLBACK_EXCLUDED_SOURCES.includes(r.sourceKey ?? ""));
  if (!usable.length) return null;

  const chosen = usable.find((r) => r.sourceKey === FALLBACK_PREFERRED_SOURCE) ?? usable[0];
  return { phoneNumber: chosen.phone, assignmentId: null, reused: false };
}
