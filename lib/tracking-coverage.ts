/**
 * When this app started seeing traffic, and why every window that reaches further
 * back understates every channel.
 *
 * The CallRail cutover was **2026-08-08**: the ten CallRail numbers moved into
 * Arbor's Twilio account and the website dropped `swap.js` the same day. Before
 * that, calls rang CallRail's numbers and this app has no record of them —
 * measured across all sources, leads run at 1–6 a day through 2026-08-07 and
 * 18–37 a day from 2026-08-08.
 *
 * **The failure mode this exists to prevent is a silent one, and it is severe.**
 * Ad spend is complete for the whole window — the spend sync does a rolling 35-day
 * re-pull and a cold-start backfill reaching to each platform's earliest lead. So a
 * 30-day view on `/sources` or `/roi` puts THIRTY days of spend beside SIX days of
 * attributed outcomes and calls the quotient ROAS. Every paid channel therefore
 * reads far worse than it is, with nothing on screen saying so.
 *
 * It is also unequal between channels, which is worse than uniformly wrong:
 * Facebook lead forms come from Meta's Graph API and carry their own history (223
 * contacts before the cutover), while calls, web forms, GBP and Local Services all
 * sit at zero. Meta consequently looks strong next to Google for a reason that has
 * nothing to do with either.
 *
 * A constant rather than a derived value, deliberately. Deriving "earliest lead"
 * would be knocked off by a single stray backdated row, and the honest answer is a
 * known event on a known date, not an inferred one. **When the CallRail history is
 * imported, move this back to the earliest imported contact** — that is the fix;
 * this notice is only the guardrail until then.
 */
export const TRACKING_STARTED_AT = new Date("2026-08-08T00:00:00Z");

/** Human date for the notice, in the business timezone. */
export const TRACKING_STARTED_LABEL = "8 August 2026";

/**
 * Does the selected window reach back before there was anything to track?
 * Returns the number of uncovered days, or 0 when the window is fully covered.
 */
export function uncoveredDays(days: number): number {
  const windowStart = Date.now() - days * 86_400_000;
  if (windowStart >= TRACKING_STARTED_AT.getTime()) return 0;
  return Math.ceil((TRACKING_STARTED_AT.getTime() - windowStart) / 86_400_000);
}
