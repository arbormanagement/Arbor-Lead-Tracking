/**
 * County routing + tag filtering for the Google-review workflow. Pure module,
 * ported verbatim from Arbor-Automations `server/reviewWorkflow.ts` (the
 * merge's slices 3–4).
 *
 * Each county gets its own review URL because each GBP profile has its own
 * listing — Madison County jobs feed the Edwardsville profile, St. Clair the
 * O'Fallon one (whose review count is the #1 lever per the GBP strategy).
 */

export const MADISON_REVIEW_URL = "https://g.page/r/CerkEC9iGIAREBM/review";
export const STCLAIR_REVIEW_URL = "https://g.page/r/CdI9e9u73OS9EBM/review";

const MADISON_CITIES = [
  "edwardsville", "glen carbon", "troy", "maryville",
  "highland", "bethalto", "wood river", "alton", "godfrey",
  "granite city", "hamel", "worden", "alhambra", "marine",
  "st. jacob", "st jacob", "livingston",
];

const STCLAIR_CITIES = [
  "o'fallon", "ofallon", "belleville", "fairview heights",
  "shiloh", "swansea", "mascoutah", "lebanon", "scott afb",
  "caseyville",
  // Collinsville is a ROUTING choice, not a county claim — the city is mostly
  // in Madison County. Justin's call (2026-09-04): its reviews go to the
  // O'Fallon profile. It was already landing there, but only via the `622`
  // zip rule below, so an address with a BLANK zip went to Edwardsville
  // instead — the same customer routed two ways depending on whether HCP
  // happened to hold a zip. Listing it here makes the intent survive both a
  // missing zip and any future reordering.
  "collinsville",
];

/** Customers/jobs carrying any of these tags never get a review request. */
export const SKIP_TAGS = [
  "do not work for customer",
  "no feedback email",
  "contractor",
  "phc client",
  "hmi",
  "business",
];

export function shouldSkipReview(customerTags: string[], jobTags: string[]): boolean {
  const allTags = [...customerTags, ...jobTags].map((t) => t.toLowerCase().trim());
  return allTags.some((tag) => SKIP_TAGS.includes(tag));
}

/**
 * ⚠️ The `622` prefix is a COARSE fallback and it OUTRANKS `MADISON_CITIES`,
 * because this branch is tested first. Four towns named in that list carry
 * 622xx zips — Collinsville (62234), Troy (62294), Highland (62249) and
 * St. Jacob (62281) — so all four route to St. Clair whenever a zip is
 * present, and to Madison when it is blank. Collinsville is now deliberate
 * (see above); the other three are inherited behavior, flagged to Justin
 * 2026-09-04 and left as-is pending his call. Measure before changing the
 * order: `MADISON_CITIES` says one thing and the zip rule does another.
 */
export function determineCounty(city: string, zip: string): "madison" | "stclair" {
  const cityLower = (city || "").toLowerCase().trim();
  const zipStr = (zip || "").trim();

  if (STCLAIR_CITIES.includes(cityLower) || zipStr.startsWith("622")) {
    return "stclair";
  }
  if (MADISON_CITIES.includes(cityLower) || zipStr.startsWith("620")) {
    return "madison";
  }
  return "madison";
}

export function getReviewUrl(county: "madison" | "stclair"): string {
  return county === "stclair" ? STCLAIR_REVIEW_URL : MADISON_REVIEW_URL;
}
