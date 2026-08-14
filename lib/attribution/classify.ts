import { UNMAPPED_SOURCE_KEY, slugifySourceValue } from "@/lib/sources/naming";

export interface TouchParams {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  referrer?: string | null;
  /** The page this touch happened on. Used only to recognize a same-site referrer
   *  (an internal navigation) so it isn't classified as a referral from ourselves. */
  currentUrl?: string | null;
}

export interface Classification {
  /** Normalized source key, e.g. "google/cpc" — matches `sources.key`. */
  sourceKey: string;
  medium: string;
}

/**
 * Classify a web session's traffic source from click IDs, UTM params, and referrer.
 * Click IDs win over UTM, which wins over referrer host. This is frozen onto the DNI
 * lease (so a call to a shared-pool number resolves to the visitor's exact source)
 * and is the lead's last-touch source. Number pools are NOT keyed off this — DNI is
 * a single shared rotation; the source lives on the lease, not the number.
 */
export function classifySource(p: TouchParams): Classification {
  if (p.gclid || p.gbraid || p.wbraid) {
    return { sourceKey: "google/cpc", medium: "cpc" };
  }
  // Only the click ID proves an ad click — a bare facebook.com referrer is organic
  // social (shares, page links) and is handled in the referrer block below.
  if (p.fbclid) {
    return { sourceKey: "facebook/paid", medium: "paid" };
  }

  const src = p.utmSource?.toLowerCase();
  const med = p.utmMedium?.toLowerCase();
  if (src || med) {
    // Match on a squashed form. The same channel reaches us spelled several ways
    // — `utm_source=google+my+business` arrives as "google my business" (a `+` in
    // a query string decodes to a space), and the same value is written elsewhere
    // as google_my_business or googlemybusiness. Comparing the raw string meant
    // whichever spelling the tag happened to use decided the source.
    const srcKey = squash(src);
    const medKey = squash(med);

    // Google Ads' own name for itself, and unambiguous: nothing organic tags
    // itself `adwords`. Deliberately a source-only test, because the mediums that
    // arrive next to it are prose, not channels — the account had ad-group
    // tracking templates emitting `utm_source=adwords&utm_medium=Tree Removal in
    // {LOCATION(City)}`, and an account-level one emitting `utm_medium={adname}`,
    // which is not a real ValueTrack parameter and so passed through literally.
    // Those templates are fixed, but the URLs they minted are bookmarked, cached
    // and shared, so they keep arriving. Auto-tagging normally settles the click
    // before this point (a gclid is checked first); this catches the one without
    // it, which would otherwise mint a per-ad-group source that no Google Ads
    // spend is ever keyed to — a lead with real cost behind it and no way to see
    // that cost.
    if (srcKey === "adwords" || srcKey === "googleads") {
      return { sourceKey: "google/cpc", medium: "cpc" };
    }

    if (medKey === "cpc" || medKey === "ppc" || medKey === "paid") {
      if (srcKey.includes("google")) return { sourceKey: "google/cpc", medium: "cpc" };
      // Instagram inventory is bought and reported in the same Meta campaigns, so
      // `utm_source=instagram` must group with facebook/paid or Meta ROI splits in
      // two and neither half reconciles with the platform's spend.
      //
      // `fb` is here because it was found in the data, not in theory: three leads
      // sat on a `fb/paid` source, minted back when an unmatched UTM pair became
      // its own channel. That path is closed now, but the abbreviation is common
      // enough in hand-written tags that without this it would land in `other` —
      // trading a wrong channel for a missing one. Matched exactly rather than by
      // substring, since two letters appear inside plenty of unrelated words.
      if (srcKey === "fb" || srcKey.includes("facebook") || srcKey.includes("meta") || srcKey.includes("instagram"))
        return { sourceKey: "facebook/paid", medium: "paid" };
    }
    // Both Business Profiles link to the site with
    // `utm_source=google+my+business&utm_medium=organic`, which matched none of
    // the spellings this once tested for. The result was a second, parallel `google
    // my business/organic` source sitting alongside `gbp` — the calls to the two
    // GBP tracking numbers landed on one and every click through to the website on
    // the other, so neither told you what the profiles were worth.
    if (
      srcKey.includes("gbp") ||
      srcKey.includes("googlemybusiness") ||
      srcKey.includes("googlebusiness") ||
      medKey === "gbp"
    ) {
      return { sourceKey: "gbp", medium: "organic" };
    }
    // Anything not matched above is UNMAPPED, not a new channel. Minting
    // `${src}/${med}` from raw UTM text is what filled /sources with rows nobody
    // runs: a third party can tag a link to your site however they like, and the
    // ROI page would grow a channel for it. The raw values survive on
    // `web_sessions`, so an `other` row can always be opened up.
    return { sourceKey: UNMAPPED_SOURCE_KEY, medium: med ?? "referral" };
  }

  if (p.referrer) {
    const host = hostOf(p.referrer);
    // An internal navigation is not a referral. Without this, a visitor who lands
    // from a Google ad and then clicks through to /contact classifies as
    // `arbor-mgmt.com/referral` — inventing a self-referral source and burying the
    // real one. Callers should ALSO prefer the session's frozen attribution; this
    // only stops the bogus source key from being minted.
    const self = p.currentUrl ? hostOf(p.currentUrl) : null;
    if (host && self && host === self) return { sourceKey: "direct", medium: "none" };
    if (host && isFacebookHost(p.referrer)) return { sourceKey: "facebook/organic", medium: "social" };
    if (host && isSearchHost(host)) return { sourceKey: "organic/seo", medium: "organic" };
    // A referring HOST is evidence of a real, identifiable place — unlike a UTM
    // value, nobody can forge where the browser actually came from — so these keep
    // minting their own source. Slugified so nextdoor.com and Nextdoor.com cannot
    // become two rows.
    if (host) return { sourceKey: `${slugifySourceValue(host)}/referral`, medium: "referral" };
  }

  return { sourceKey: "direct", medium: "none" };
}

/**
 * Reduce a utm value to letters and digits, so the spelling a given tag happens
 * to use stops mattering: "google my business" (what `google+my+business`
 * decodes to), "google_my_business" and "GoogleMyBusiness" all compare equal.
 * Input is already lowercased by the caller.
 */
function squash(v?: string | null): string {
  return (v ?? "").replace(/[^a-z0-9]/g, "");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isFacebookHost(ref?: string | null): boolean {
  const h = ref ? hostOf(ref) : null;
  return !!h && /(^|\.)(facebook|fb|instagram)\.com$/.test(h);
}

function isSearchHost(host: string): boolean {
  // Anchored per engine (host arrives with `www.` stripped) so neither
  // `google.evil.com` nor subdomain products like `docs.google.com` classify as
  // organic search. Google keeps its ccTLDs (google.de, google.co.uk).
  return (
    /^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) ||
    host === "bing.com" ||
    host === "duckduckgo.com" ||
    host === "search.yahoo.com" ||
    host === "ecosia.org"
  );
}
