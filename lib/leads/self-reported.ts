/**
 * The customer's own "how did you hear about us", rolled up to a channel.
 *
 * The free text stays on `leads.self_reported_source` as the DETAIL — "referral -
 * neighbor", "referral - Edwards Roofing Company" — because the detail is the useful
 * part of a referral. But eight spellings of "referral - …" cannot roll up, and the
 * whole reason self-reporting exists is the ~31% of contacts that reach us on a
 * channel that cannot be traced to a spendable one (a published number, `direct`).
 * The channel is the instrument for that; the detail is the colour.
 *
 * Deliberately a short list. Every value is something the business could act on or
 * buy more of; anything else is `other` with the detail still attached.
 */
export const SELF_REPORTED_CHANNELS = [
  "referral", // a person: neighbor, friend, family, another business, "used you before" said by someone else
  "google_search", // searched online, found us on Google / Maps / the internet
  "social", // Facebook, Instagram, Nextdoor, a post or an ad they saw there
  "sign_or_truck", // a yard sign, a truck wrap, saw the crew working
  "repeat_customer", // has used us before themselves
  "other",
] as const;
export type SelfReportedChannel = (typeof SELF_REPORTED_CHANNELS)[number];

const RULES: Array<[SelfReportedChannel, RegExp]> = [
  ["repeat_customer", /\b(repeat|previous|prior|before|again|past customer|used you (?:guys )?(?:before|last|in)|had you out)\b/i],
  ["referral", /\b(referr|recommend|neighbou?r|friend|family|relative|coworker|co-worker|word of mouth|told me|someone (?:said|mentioned)|in-law|daughter|son|brother|sister|hoa|church|roofing|contractor|realtor|landscap)/i],
  ["sign_or_truck", /\b(sign|truck|trailer|crew|saw you|saw your|drove by|driving by|working (?:on|down|next)|in the neighbou?rhood|down the street)\b/i],
  ["social", /\b(facebook|fb|instagram|nextdoor|next door|tiktok|social|post)\b/i],
  ["google_search", /\b(google|search|online|internet|web|maps|yelp|bing|looked (?:you|it) up)\b/i],
];

/**
 * Roll free text up to a channel. `null` for nothing said. Order matters: "my
 * neighbor found you on Google" is a referral — the person is the reason we were
 * chosen, the search is how they checked — so people-words are tested before
 * search-words, and a self-declared repeat customer before either.
 */
export function normalizeSelfReported(text: string | null | undefined): SelfReportedChannel | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const [channel, re] of RULES) if (re.test(t)) return channel;
  return "other";
}
