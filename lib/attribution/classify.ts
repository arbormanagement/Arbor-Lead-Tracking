import type { poolEnum } from "@/lib/db/schema";

type Pool = (typeof poolEnum.enumValues)[number];

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
  /** Which Twilio number pool to lease a DNI number from. */
  pool: Pool;
  medium: string;
}

/**
 * Classify a web session's traffic source from click IDs, UTM params, and referrer.
 * Click IDs win over UTM, which wins over referrer host. This drives BOTH the DNI
 * pool selection and the lead's last-touch source.
 */
export function classifySource(p: TouchParams): Classification {
  if (p.gclid || p.gbraid || p.wbraid) {
    return { sourceKey: "google/cpc", pool: "google", medium: "cpc" };
  }
  if (p.fbclid || isFacebookHost(p.referrer)) {
    return { sourceKey: "facebook/paid", pool: "facebook", medium: "paid" };
  }

  const src = p.utmSource?.toLowerCase();
  const med = p.utmMedium?.toLowerCase();
  if (src || med) {
    if (med === "cpc" || med === "ppc" || med === "paid") {
      if (src?.includes("google")) return { sourceKey: "google/cpc", pool: "google", medium: "cpc" };
      if (src?.includes("facebook") || src?.includes("meta"))
        return { sourceKey: "facebook/paid", pool: "facebook", medium: "paid" };
    }
    if (src?.includes("gbp") || src?.includes("google_business") || med === "gbp") {
      return { sourceKey: "gbp", pool: "organic", medium: "organic" };
    }
    return { sourceKey: `${src ?? "other"}/${med ?? "referral"}`, pool: "organic", medium: med ?? "referral" };
  }

  if (p.referrer) {
    const host = hostOf(p.referrer);
    if (host && isSearchHost(host)) return { sourceKey: "organic/seo", pool: "organic", medium: "organic" };
    if (host) return { sourceKey: `${host}/referral`, pool: "organic", medium: "referral" };
  }

  return { sourceKey: "direct", pool: "direct", medium: "none" };
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
  return /(^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./.test(host);
}
