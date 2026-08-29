/**
 * The three grains of "where does work come from", now one page instead of three
 * nav items (Justin, 2026-08-15).
 *
 * They were separate tabs because they read different tables — Channel and Campaign
 * come from the `roi_daily` rollup, Pages reads `web_sessions` + `leads` directly.
 * That is a real difference in the DATA, but it was never a difference in the
 * QUESTION, and the nav was showing the reader our storage layout.
 *
 * Page keeps its own columns rather than being forced into the spend table: it has
 * no spend by design (cost attaches to a campaign, not a landing page) and its whole
 * point is a RATE, which needs the visitors who did NOT convert in the denominator.
 * Flattening it into a shared shape would have meant either an empty Spend column or
 * dropping the conversion rate — so the views share a shell, not a table.
 */
import type { PageBasis } from "@/lib/queries/sources";

export type SourceView = "channel" | "campaign" | "page";

export const DEFAULT_VIEW: SourceView = "channel";

export const VIEWS: Array<{ key: SourceView; label: string; sub: string }> = [
  {
    key: "channel",
    label: "Channels",
    sub: "Where contacts come from and what they turn into",
  },
  {
    key: "campaign",
    label: "Campaigns",
    sub: "Spend and return per campaign",
  },
  {
    key: "page",
    label: "Landing pages",
    sub: "Which landing pages turn visits into work",
  },
];

export function parseView(v: string | undefined): SourceView {
  return VIEWS.some((x) => x.key === v) ? (v as SourceView) : DEFAULT_VIEW;
}

/**
 * Which page a visit and a lead are counted against, on the Landing pages view.
 *
 * Entry is the default because it is what this view has always meant and what an
 * ad buys. Conversion answers the different question — which page was on screen
 * when they got in touch — and on a client-side routed site that is usually not
 * the page they arrived on.
 */
export const DEFAULT_BASIS: PageBasis = "entry";

export function parseBasis(v: string | undefined): PageBasis {
  return v === "conversion" ? "conversion" : DEFAULT_BASIS;
}

/** Default timeframe, shared so the pills and the query cannot disagree. */
export const DEFAULT_DAYS = 30;

/** URL for a given view/timeframe, omitting both defaults so the plain path is canonical. */
export function sourcesHref(view: SourceView, days: number, basis: PageBasis = DEFAULT_BASIS): string {
  const q = new URLSearchParams();
  if (view !== DEFAULT_VIEW) q.set("view", view);
  if (days !== DEFAULT_DAYS) q.set("days", String(days));
  // Only meaningful on the page view, and omitted at its default so the plain
  // path stays canonical.
  if (view === "page" && basis !== DEFAULT_BASIS) q.set("basis", basis);
  const s = q.toString();
  return s ? `/sources?${s}` : "/sources";
}
