import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { dniOutcomes } from "@/lib/db/schema";
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
  // did NOT get a pool number
  /** Pool empty — handed the STATIC number, which is what makes a visitor look `direct`. */
  | "static_fallback"
  /** Refused as a crawler (`lib/bot.ts`). An absent user-agent lands here too. */
  | "bot"
  /** Per-IP budget exceeded. */
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
]);

/** Excluded from the rate entirely — our own monitoring, not a visitor. */
const SYNTHETIC: ReadonlySet<AssignOutcome> = new Set<AssignOutcome>(["canary"]);

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
 * Count one decision. Never throws, and only touches the database on a flush tick —
 * the visitor's number matters, this number does not.
 */
export async function recordAssignOutcome(outcome: AssignOutcome): Promise<void> {
  try {
    const k = bufferKey(businessDate(new Date()), outcome);
    buffer.set(k, (buffer.get(k) ?? 0) + 1);
    buffered += 1;
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
  if (buffer.size === 0) {
    lastFlushAt = Date.now();
    return 0;
  }

  // Take the pending set BEFORE the first await, so increments arriving during the
  // write land in a fresh buffer instead of being cleared unwritten.
  const pending = [...buffer.entries()];
  buffer.clear();
  buffered = 0;
  lastFlushAt = Date.now();

  const work = (async () => {
    for (const [k, n] of pending) {
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
    }
  })();

  inFlight = work.then(
    () => undefined,
    (err) => {
      // Put the counts back rather than dropping them — the next flush retries.
      // Losing a refusal is the direction that makes coverage look BETTER than it
      // is, which is the one lie this whole thing exists to avoid.
      for (const [k, n] of pending) buffer.set(k, (buffer.get(k) ?? 0) + n);
      buffered += pending.reduce((acc, [, n]) => acc + n, 0);
      console.error("[dni/outcomes] flush failed; counts re-buffered", err);
    },
  );
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
  return pending.length;
}

export interface SwapCoverage {
  windowDays: number;
  /** Requests that came from a real visitor (canary excluded). */
  visitors: number;
  /** Of those, how many left with a rotating pool number. */
  covered: number;
  /** Percentage, or null when nothing has been recorded yet. */
  coveredPct: number | null;
  byOutcome: Record<string, number>;
  note: string;
}

/**
 * Roll the counters up for /api/diagnostics. Flushes first, so a quiet period cannot
 * leave the most recent minute of traffic invisible.
 */
export async function readSwapCoverage(windowDays = 7): Promise<SwapCoverage> {
  await flushAssignOutcomes().catch(() => 0);

  const since = businessDate(new Date(Date.now() - windowDays * 86_400_000));
  const rows = await db
    .select({ outcome: dniOutcomes.outcome, n: sql<number>`sum(${dniOutcomes.count})::int` })
    .from(dniOutcomes)
    .where(sql`${dniOutcomes.date} >= ${since}`)
    .groupBy(dniOutcomes.outcome);

  const byOutcome: Record<string, number> = {};
  let visitors = 0;
  let covered = 0;
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    byOutcome[r.outcome] = n;
    if (SYNTHETIC.has(r.outcome as AssignOutcome)) continue;
    visitors += n;
    if (COVERED.has(r.outcome as AssignOutcome)) covered += n;
  }

  return {
    windowDays,
    visitors,
    covered,
    coveredPct: visitors ? Math.round((covered / visitors) * 1000) / 10 : null,
    byOutcome,
    note:
      "Server-side only: 'covered' means a pool number was handed out, not that it reached the " +
      "page. Treat it as an upper bound. A visit where track.js never ran is invisible here by " +
      "construction — the dni.canary job is what catches that.",
  };
}
