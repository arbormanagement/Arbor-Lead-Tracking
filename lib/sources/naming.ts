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

/** Keys whose names are fixed by the seed; everything else is derived. */
const KNOWN: Record<string, string> = {
  "google/cpc": "Google Ads (Search)",
  "google/lsa": "Google Local Services",
  "facebook/paid": "Facebook / Instagram Ads",
  "facebook/organic": "Facebook (Organic)",
  "organic/seo": "Organic Search",
  gbp: "Google Business Profile",
  direct: "Direct",
  referral: "Referral",
  [UNMAPPED_SOURCE_KEY]: "Other / Unmapped",
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

/**
 * Collapse a UTM value to a stable slug so spelling variants cannot become
 * separate sources.
 *
 * `classifySource` already compares a squashed form when matching KNOWN channels,
 * but its fallback used the raw value — so "Home Advisor" and "home_advisor" would
 * still have minted two rows. That is the mechanism that produced the duplicate
 * Google Business Profile; fixing the GBP match alone left it live for every other
 * channel.
 */
export function slugifySourceValue(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
