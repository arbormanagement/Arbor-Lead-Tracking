/**
 * Can `track.js` actually swap the numbers on this page?
 *
 * The canary used to assert that the site REFERENCES track.js, which proves the
 * snippet is installed and nothing about whether it has anything to work on. Those
 * are different failures, and the second one is the quiet one: the snippet loads,
 * the assign call succeeds, the pool hands out a number, every server-side signal
 * reads healthy — and the visitor still sees the published number, because the
 * element holding it is not something `swapNumbers` looks for.
 *
 * `swapNumbers` (app/track.js/route.ts) rewrites exactly two things:
 *   • `[data-arbor-phone]` — explicitly marked elements
 *   • `a[href^="tel:"]`    — call links, unless inside `[data-arbor-ignore]`
 *
 * A number rendered as plain text in a footer, a heading, or a non-anchor button is
 * invisible to both, and there is no way to find that out from inside this app —
 * it is a fact about the website's markup, which changes on the website's deploy
 * schedule, not ours.
 *
 * Audited against all 34 pages of arbor-mgmt.com on 2026-08-21: every page carried
 * the snippet and 1–4 `tel:` anchors, and NO page rendered a published number in
 * plain visible text. So this starts life green, which is the point — it is a
 * regression detector, and it is worth exactly as much as its false-positive rate.
 *
 * ## Why the meta tags and JSON-LD are deliberately ignored
 *
 * The homepage carries `+1-618-205-3094` in `<meta name="description">`, in two
 * JSON-LD `telephone` fields and in an HTML comment. Those SHOULD stay on the
 * published number forever — structured data feeds Google Business and must be
 * stable, and a rotating pool number in schema.org markup would be actively wrong.
 * Counting them as unswapped targets would make this check permanently red and it
 * would be switched off within a week. Hence the stripping below.
 */

/** Digits only, for comparing a rendered string to a stored E.164 number. */
function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** "(618) 205-3094" / "618-205-3094" / "618.205.3094" — how a number gets written. */
const PHONE_RE = /\(?\b\d{3}\)?[\s.\-–]?\d{3}[\s.\-–]?\d{4}\b/g;

const TEL_ANCHOR_RE = /<a\b[^>]*href=["']tel:[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;

export interface SwapTargets {
  /** `a[href^="tel:"]` anchors — what swapNumbers rewrites. */
  telAnchors: number;
  /** `[data-arbor-phone]` marked elements. */
  markedElements: number;
  /** Does the page load the snippet at all? */
  referencesTrackJs: boolean;
  /**
   * Published numbers rendered in visible text that NO selector can reach. Each one
   * is a place a visitor reads the untracked number and dials it, landing in
   * `direct`. This is the finding worth waking someone for.
   */
  unswappable: string[];
}

/**
 * Parse a page's HTML for what the swap can and cannot reach.
 *
 * Regex rather than a DOM parser, deliberately: this runs on the `cron` service
 * where adding a parser (let alone a browser) is a dependency decision, and the
 * question here is coarse — "is there a tel: anchor, and is there a bare number
 * outside one". It is approximate at the edges (an `<a>` containing a nested `</a>`
 * in an attribute string would confuse it) and that is acceptable for a monitor
 * whose failure mode is a second look by a human.
 */
export function findSwapTargets(html: string, trackJsUrl: string, publishedE164: string[]): SwapTargets {
  const telAnchors = html.match(TEL_ANCHOR_RE)?.length ?? 0;
  const markedElements = html.match(/data-arbor-phone/g)?.length ?? 0;

  // Everything the swap cannot reach AND a visitor cannot read is noise here:
  // tel: anchors (already swappable), scripts (JSON-LD, bundles), styles, comments,
  // and meta tags. See the note at the top for why those must keep the real number.
  const visible = html
    .replace(TEL_ANCHOR_RE, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<meta[^>]*>/gi, " ")
    // An input placeholder is not rendered content the way text is, and the site's
    // quote form carries the literal "(555) 123-4567".
    .replace(/<input[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const published = new Set(publishedE164.map(digits).filter(Boolean));
  const unswappable = new Set<string>();
  for (const match of visible.match(PHONE_RE) ?? []) {
    const d = digits(match);
    // Compare on the last 10 digits so a stored +1618… matches a rendered 618….
    if (published.has(d) || published.has("1" + d)) unswappable.add(match.trim());
  }

  return {
    telAnchors,
    markedElements,
    referencesTrackJs: html.includes(trackJsUrl),
    unswappable: [...unswappable],
  };
}
