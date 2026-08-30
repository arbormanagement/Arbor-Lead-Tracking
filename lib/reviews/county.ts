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
  "edwardsville", "glen carbon", "troy", "maryville", "collinsville",
  "highland", "bethalto", "wood river", "alton", "godfrey",
  "granite city", "hamel", "worden", "alhambra", "marine",
  "st. jacob", "st jacob", "livingston",
];

const STCLAIR_CITIES = [
  "o'fallon", "ofallon", "belleville", "fairview heights",
  "shiloh", "swansea", "mascoutah", "lebanon", "scott afb",
  "caseyville",
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
