import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dniOutcomes, dniRefusals, webSessions } from "@/lib/db/schema";
import { businessDate } from "@/lib/tz";

/**
 * Swap coverage: what `/api/dni/assign` decided, and why.
 *
 * "Direct" is the largest channel on /sources and part of it is not word of mouth
 * at all — it is website visitors whose number never got swapped, who then dialled
 * the published number. Nothing recorded that, so the size of it was unknowable.
 *
 * This is the SERVER half of the answer, and deliberately only that half. The app
 * knows for certain whether it handed out a pool number; it cannot know whether the
 * number reached the screen, because a client-side report is blocked by exactly the
 * things that break the swap. A number that goes UP when its own reporting breaks is
 * worse than no number, so this measures only what the server witnessed first-hand.
 *
 * Read it as: `covered` is an UPPER BOUND on real coverage. Everything it counts as
 * covered did get a number from us; some of those still never made it onto the page.
 */
export type AssignOutcome =
  // got a pool number
  /** A number was leased for this session — the healthy path. */
  | "leased"
  /** This session already held one (a second pageview). */
  | "session_reuse"
  /** At the per-visitor lease cap, so their newest number was reused. */
  | "visitor_capped"
  /** Shared an existing lease with a visitor of identical attribution. */
  | "shared"
  /**
   * Pool was empty, so the stalest IDLE lease was bumped and its number handed over
   * (`leaseByTakeover`). Covered — but each one is a visitor the pool could not seat
   * without evicting someone, so a rising count is the pool-size signal.
   */
  | "reassigned"
  // did NOT get a pool number
  /** Pool empty AND no idle lease to bump — handed the STATIC number, which is what makes a visitor look `direct`. */
  | "static_fallback"
  /** Refused as a crawler (`lib/bot.ts`). An absent user-agent lands here too. */
  | "bot"
  /**
   * The per-IP FLOOD ceiling (120/min) refused it. One address is not one visitor —
   * this is the limiter a scanner or a scraper trips, and a shared NAT should not.
   */
  | "rate_limited_ip"
  /** The per-visitor budget (10/min on `vid`) refused it — a browser firing assign far more than a page needs. */
  | "rate_limited_visitor"
  /**
   * Both limiters, undifferentiated — rows recorded before 2026-09-05. Kept in the
   * type so old rows still count as refusals; nothing records it any more. The split
   * exists because 65 of these in a week could not be told apart: a visitor behind a
   * busy address losing their attribution needs a different fix from a scraper
   * hitting the ceiling, and the counter said the same thing for both.
   */
  | "rate_limited"
  /** `Origin` missing or not on the allowlist. */
  | "origin_rejected"
  /** Body failed validation — a malformed or hostile caller, or a broken track.js. */
  | "invalid_payload"
  /** Every path exhausted, including the static fallback. Should be ~0. */
  | "none"
  /** The handler threw. The page keeps its own number. */
  | "error"
  // not a visitor
  /** The scheduled canary (`lib/sync/dni-canary.ts`), kept out of the rate. */
  | "canary";

/** Outcomes where the visitor ended up on a rotating pool number. */
const COVERED: ReadonlySet<AssignOutcome> = new Set<AssignOutcome>([
  "leased",
  "session_reuse",
  "visitor_capped",
  "shared",
  "reassigned",
]);

/** Excluded from the rate entirely — our own monitoring, not a visitor. */
const SYNTHETIC: ReadonlySet<AssignOutcome> = new Set<AssignOutcome>(["canary"]);

/**
 * Also out of the rate, and reported on their own. A crawler is refused a number on
 * purpose and never dials one, so counting it as an uncovered visitor made the rate
 * read 62% against a real 90% — and a warning that is permanently red is furniture.
 */
const CRAWLERS: ReadonlySet<AssignOutcome> = new Set<AssignOutcome>(["bot"]);

/**
 * Buffer, flushed on elapsed time or size — NOT one write per request.
 *
 * The Railway `web` service is a long-lived node process (`DB_DRIVER=pg`, see
 * lib/db/client.ts), so in-process state survives between requests. Several
 * instances would each flush their own share; the upsert ADDS rather than sets, so
 * they compose rather than clobber.
 *
 * The trade is that a redeploy or crash drops whatever has not flushed yet — at
 * most FLUSH_EVERY_MS of counts. That is the right trade for a diagnostic rate and
 * the wrong one for anything billable, which is why nothing billable goes here.
 */
const FLUSH_EVERY_MS = 60_000;
const FLUSH_AT_COUNT = 200;

const buffer = new Map<string, number>();
let buffered = 0;
let lastFlushAt = Date.now();
let inFlight: Promise<void> | null = null;

const bufferKey = (date: string, outcome: string) => `${date} ${outcome}`;

/**
 * The second half of the buffer: WHO was refused (`dni_refusals`), for the exits whose
 * cause the outcome count alone cannot show. Keyed date / outcome / detail, separated by
 * a tab, which neither a business date, an outcome name nor a sanitised detail contains.
 */
const detailBuffer = new Map<string, number>();

/**
 * Distinct details kept per business day, per process. The detail is caller-supplied
 * (an Origin header, a visitor id), and this endpoint is public — without a cap anyone
 * could mint a row per request. Past the cap a new detail is counted as `(other)`, so
 * the total still adds up to the outcome count and nothing is silently dropped.
 */
const MAX_DETAILS_PER_DAY = 100;
const OVERFLOW_DETAIL = "(other)";
const MAX_DETAIL_CHARS = 200;
let detailsDay = "";
const detailsSeen = new Set<string>();

function boundedDetail(date: string, outcome: string, detail: string): string {
  if (date !== detailsDay) {
    detailsDay = date;
    detailsSeen.clear();
  }
  // Control characters (tab included) are stripped so a detail can never break the key.
  const clean = detail.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_DETAIL_CHARS) || "(empty)";
  const seenKey = `${outcome}\t${clean}`;
  if (detailsSeen.has(seenKey)) return clean;
  if (detailsSeen.size >= MAX_DETAILS_PER_DAY) return OVERFLOW_DETAIL;
  detailsSeen.add(seenKey);
  return clean;
}

/**
 * Count one decision. Never throws, and only touches the database on a flush tick —
 * the visitor's number matters, this number does not.
 *
 * `detail` is recorded only for refusals, and only where it says something the outcome
 * does not: the rejected Origin, or the visitor id that hit its budget.
 */
export async function recordAssignOutcome(outcome: AssignOutcome, detail?: string): Promise<void> {
  try {
    const date = businessDate(new Date());
    const k = bufferKey(date, outcome);
    buffer.set(k, (buffer.get(k) ?? 0) + 1);
    buffered += 1;
    if (detail !== undefined) {
      const dk = `${date}\t${outcome}\t${boundedDetail(date, outcome, detail)}`;
      detailBuffer.set(dk, (detailBuffer.get(dk) ?? 0) + 1);
    }
    if (buffered >= FLUSH_AT_COUNT || Date.now() - lastFlushAt >= FLUSH_EVERY_MS) {
      await flushAssignOutcomes();
    }
  } catch (err) {
    console.error("[dni/outcomes] record failed", err);
  }
}

/**
 * Write the buffer out. Safe to call concurrently — a flush already running is
 * awaited rather than duplicated, so two requests crossing the threshold together
 * cannot double-count.
 */
export async function flushAssignOutcomes(): Promise<number> {
  if (inFlight) {
    await inFlight;
    return 0;
  }
  if (buffer.size === 0 && detailBuffer.size === 0) {
    lastFlushAt = Date.now();
    return 0;
  }

  // Take the pending set BEFORE the first await, so increments arriving during the
  // write land in a fresh buffer instead of being cleared unwritten.
  const pending = [...buffer.entries()];
  const pendingDetails = [...detailBuffer.entries()];
  buffer.clear();
  detailBuffer.clear();
  buffered = 0;
  lastFlushAt = Date.now();

  const written = pending.length + pendingDetails.length;
  const work = (async () => {
    while (pending.length) {
      const [k, n] = pending[0]!;
      const sep = k.indexOf(" ");
      const date = k.slice(0, sep);
      const outcome = k.slice(sep + 1);
      await db
        .insert(dniOutcomes)
        .values({ date, outcome, count: n })
        .onConflictDoUpdate({
          target: [dniOutcomes.date, dniOutcomes.outcome],
          // `+ n`, never `= n`: the row is shared with every other instance and with
          // this instance's earlier flushes.
          set: { count: sql`${dniOutcomes.count} + ${n}`, updatedAt: new Date() },
        });
      // Written as it goes, so a failure part-way re-buffers only what is left —
      // re-buffering a row already written would count it twice.
      pending.shift();
    }
    while (pendingDetails.length) {
      const [k, n] = pendingDetails[0]!;
      const [date, outcome, detail] = k.split("\t") as [string, string, string];
      await db
        .insert(dniRefusals)
        .values({ date, outcome, detail, count: n })
        .onConflictDoUpdate({
          target: [dniRefusals.date, dniRefusals.outcome, dniRefusals.detail],
          set: { count: sql`${dniRefusals.count} + ${n}`, updatedAt: new Date() },
        });
      pendingDetails.shift();
    }
  })();

  inFlight = work.then(
    () => undefined,
    (err) => {
      // Put the unwritten counts back rather than dropping them — the next flush
      // retries. Losing a refusal is the direction that makes coverage look BETTER
      // than it is, which is the one lie this whole thing exists to avoid.
      for (const [k, n] of pending) buffer.set(k, (buffer.get(k) ?? 0) + n);
      for (const [k, n] of pendingDetails) detailBuffer.set(k, (detailBuffer.get(k) ?? 0) + n);
      buffered += pending.reduce((acc, [, n]) => acc + n, 0);
      console.error("[dni/outcomes] flush failed; counts re-buffered", err);
    },
  );
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
  return written;
}

export interface SwapCoverageDay {
  date: string;
  visitors: number;
  covered: number;
  coveredPct: number | null;
  byOutcome: Record<string, number>;
}

export interface RefusalDetail {
  detail: string;
  count: number;
  /** For a visitor id: the user agent its most recent session recorded, if any. */
  userAgent?: string | null;
}

export interface RefusalBreakdown {
  /** Distinct details recorded (an `(other)` overflow row counts once). */
  distinct: number;
  total: number;
  top: RefusalDetail[];
}

export interface SwapCoverage {
  windowDays: number;
  /** Requests that came from a real visitor (canary and refused crawlers excluded). */
  visitors: number;
  /** Requests refused as crawlers — deliberately not visitors, and not in the rate. */
  bots: number;
  /** Of those, how many left with a rotating pool number. */
  covered: number;
  /** Percentage, or null when nothing has been recorded yet. */
  coveredPct: number | null;
  byOutcome: Record<string, number>;
  /**
   * The same rate per business day, oldest first. A 7-day total cannot say whether a
   * fix worked — the window straddles the deploy — so read the days either side of it.
   */
  byDay: SwapCoverageDay[];
  /** Who the two unexplained refusal exits turned away, over the same window. */
  refusals: { origin_rejected: RefusalBreakdown; rate_limited_visitor: RefusalBreakdown };
  note: string;
}

const pct = (covered: number, visitors: number) =>
  visitors ? Math.round((covered / visitors) * 1000) / 10 : null;

/** Fold one outcome count into running visitor / covered / bot totals. */
function tally(t: { visitors: number; covered: number; bots: number }, outcome: string, n: number) {
  if (SYNTHETIC.has(outcome as AssignOutcome)) return;
  if (CRAWLERS.has(outcome as AssignOutcome)) {
    t.bots += n;
    return;
  }
  t.visitors += n;
  if (COVERED.has(outcome as AssignOutcome)) t.covered += n;
}

const REFUSAL_TOP_N = 10;

async function readRefusals(since: string, outcome: string, withUserAgent: boolean): Promise<RefusalBreakdown> {
  const rows = await db
    .select({ detail: dniRefusals.detail, n: sql<number>`sum(${dniRefusals.count})::int` })
    .from(dniRefusals)
    .where(sql`${dniRefusals.date} >= ${since} AND ${dniRefusals.outcome} = ${outcome}`)
    .groupBy(dniRefusals.detail)
    .orderBy(sql`2 DESC`);

  const top: RefusalDetail[] = rows.slice(0, REFUSAL_TOP_N).map((r) => ({ detail: r.detail, count: Number(r.n ?? 0) }));
  if (withUserAgent && top.length) {
    // A refused request is turned away before it seeds a session, so the agent comes
    // from the visitor's earlier, accepted requests — null means none was ever accepted.
    const uas = await db.execute(sql`
      SELECT DISTINCT ON (${webSessions.visitorId}) ${webSessions.visitorId} AS vid, ${webSessions.userAgent} AS ua
      FROM ${webSessions}
      WHERE ${webSessions.visitorId} IN (${sql.join(top.map((t) => sql`${t.detail}`), sql`, `)})
      ORDER BY ${webSessions.visitorId}, ${webSessions.createdAt} DESC
    `);
    const byVid = new Map<string, string | null>();
    for (const r of ((uas as unknown as { rows?: Array<{ vid: string; ua: string | null }> }).rows ?? [])) {
      byVid.set(r.vid, r.ua);
    }
    for (const t of top) t.userAgent = byVid.get(t.detail) ?? null;
  }
  return {
    distinct: rows.length,
    total: rows.reduce((acc, r) => acc + Number(r.n ?? 0), 0),
    top,
  };
}

/**
 * Roll the counters up for /api/diagnostics. Flushes first, so a quiet period cannot
 * leave the most recent minute of traffic invisible.
 */
export async function readSwapCoverage(windowDays = 7): Promise<SwapCoverage> {
  await flushAssignOutcomes().catch(() => 0);

  const since = businessDate(new Date(Date.now() - windowDays * 86_400_000));
  const rows = await db
    .select({ date: dniOutcomes.date, outcome: dniOutcomes.outcome, n: sql<number>`sum(${dniOutcomes.count})::int` })
    .from(dniOutcomes)
    .where(sql`${dniOutcomes.date} >= ${since}`)
    .groupBy(dniOutcomes.date, dniOutcomes.outcome);

  const byOutcome: Record<string, number> = {};
  const total = { visitors: 0, covered: 0, bots: 0 };
  const days = new Map<string, SwapCoverageDay & { bots: number }>();
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    const date = String(r.date);
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + n;
    tally(total, r.outcome, n);

    let day = days.get(date);
    if (!day) {
      day = { date, visitors: 0, covered: 0, bots: 0, coveredPct: null, byOutcome: {} };
      days.set(date, day);
    }
    day.byOutcome[r.outcome] = n;
    tally(day, r.outcome, n);
  }

  const byDay = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ bots: _bots, ...d }) => ({ ...d, coveredPct: pct(d.covered, d.visitors) }));

  const [originRejected, rateLimitedVisitor] = await Promise.all([
    readRefusals(since, "origin_rejected", false),
    readRefusals(since, "rate_limited_visitor", true),
  ]);

  return {
    windowDays,
    visitors: total.visitors,
    bots: total.bots,
    covered: total.covered,
    coveredPct: pct(total.covered, total.visitors),
    byOutcome,
    byDay,
    refusals: { origin_rejected: originRejected, rate_limited_visitor: rateLimitedVisitor },
    note:
      "Server-side only: 'covered' means a pool number was handed out, not that it reached the " +
      "page. Treat it as an upper bound. A visit where track.js never ran is invisible here by " +
      "construction — the dni.canary job is what catches that. Crawlers are refused on purpose " +
      "and reported under `bots`, outside the rate. `refusals` names who the origin and " +
      "per-visitor limits turned away (recorded from 2026-09-22; `(other)` is the per-day cap).",
  };
}
