/**
 * Where a source gets its NAME, and the one bucket that catches everything we do
 * not recognise.
 *
 * Two problems this exists to fix, both visible on /sources:
 *
 * 1. Six call sites created sources with `displayName: key`, so anything not in
 *    the seed list rendered as a raw slug next to properly-named channels —
 *    "facebook/organic" sitting beside "Facebook / Instagram Ads".
 * 2. The source list was EMERGENT. Any UTM tag on any link pointing at the site
 *    minted a new row on the ROI page, so the page ended up the shape of the
 *    tagging accidents rather than the shape of the business — eight sources for
 *    five real channels, including a duplicate Google Business Profile that split
 *    its calls from its clicks.
 */

/**
 * Unrecognised traffic goes here rather than minting a channel.
 *
 * This is the deliberate trade: a genuinely new channel will NOT appear on the ROI
 * page by itself. Someone promotes it once it matters, by adding it to
 * `SEED_SOURCES` and mapping it in `classifySource`. In exchange the source list
 * stays stable and comparable month to month, and a mistyped or third-party UTM
 * tag can never invent a channel you do not run.
 *
 * Nothing is lost by bucketing here: the raw utm_source / utm_medium / campaign
 * stay on `web_sessions`, so an `other` row can always be inspected to find out
 * what is actually in it.
 */
export const UNMAPPED_SOURCE_KEY = "other";

/**
 * Estimates written BEFORE tracking existed, which have no source and never can.
 *
 * Distinct from "unattributed" on purpose, and the distinction is the whole point:
 * an unattributed estimate written since the cutover is a question to answer — we
 * were watching and still have no source — while one written before it is simply
 * outside what this app can see. Lumping them together makes the second, far larger
 * group look like a tracking failure and buries the first. Measured 2026-08-28: over
 * 90 days, 801 of the 844 estimates with no source are pre-tracking and only 6 are
 * the real defect.
 *
 * The rule is narrow, and only this one cell of the matrix moves: an estimate that
 * HAS a source keeps it whatever its date (Meta lead forms carry their own history
 * back to May, so pre-cutover Meta estimates are genuinely attributed), and an
 * estimate with no source written since the cutover stays unattributed.
 *
 * This decays on its own as the window rolls forward, and disappears entirely if the
 * CallRail history is ever imported — see TRACKING_STARTED_AT.
 */
export const PRE_TRACKING_SOURCE_KEY = "n/a";

/** Keys whose names are fixed by the seed; everything else is derived. */
const KNOWN: Record<string, string> = {
  "google/cpc": "Google Ads (Search)",
  "google/lsa": "Google Local Services",
  "facebook/paid": "Meta Ads",
  "facebook/organic": "Meta (Organic)",
  "organic/seo": "Organic Search",
  gbp: "Google Business Profile",
  direct: "Direct",
  "email/newsletter": "Email Newsletter",
  referral: "Referral",
  [UNMAPPED_SOURCE_KEY]: "Other / Unmapped",
  [PRE_TRACKING_SOURCE_KEY]: "N/A (before tracking)",
};

/**
 * A human label for a source key. Falls back to a readable derivation rather than
 * the raw key, so a source created at runtime can never surface as a slug:
 *
 *   "facebook/organic"   → "Facebook (Organic)"   (known)
 *   "nextdoor.com/referral" → "Nextdoor.com (Referral)"
 *   "some-vendor"        → "Some Vendor"
 */
export function displayNameFor(key: string): string {
  const known = KNOWN[key];
  if (known) return known;

  const [head, tail] = key.split("/");
  const title = (s: string) =>
    s
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  return tail ? `${title(head!)} (${title(tail)})` : title(head!);
}

