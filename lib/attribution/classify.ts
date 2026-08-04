export interface TouchParams {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  fbclid?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  referrer?: string | null;
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
    if (med === "cpc" || med === "ppc" || med === "paid") {
      if (src?.includes("google")) return { sourceKey: "google/cpc", medium: "cpc" };
      if (src?.includes("facebook") || src?.includes("meta"))
        return { sourceKey: "facebook/paid", medium: "paid" };
    }
    if (src?.includes("gbp") || src?.includes("google_business") || med === "gbp") {
      return { sourceKey: "gbp", medium: "organic" };
    }
    return { sourceKey: `${src ?? "other"}/${med ?? "referral"}`, medium: med ?? "referral" };
  }

  if (p.referrer) {
    const host = hostOf(p.referrer);
    if (host && isFacebookHost(p.referrer)) return { sourceKey: "facebook/organic", medium: "social" };
    if (host && isSearchHost(host)) return { sourceKey: "organic/seo", medium: "organic" };
    if (host) return { sourceKey: `${host}/referral`, medium: "referral" };
  }

  return { sourceKey: "direct", medium: "none" };
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
