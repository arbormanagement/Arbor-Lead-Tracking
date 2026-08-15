import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { campaigns, hcpEstimates, leads, sources } from "@/lib/db/schema";
import { landingPathSql } from "@/lib/landing-page";

/**
 * Attribution filters on /estimates — the other half of "show me the estimates
 * behind this source row".
 *
 * /sources answers "which channel/campaign/page produced work"; this answers "which
 * work", by name. Every filter here corresponds to a row you can click on /sources,
 * so the two pages are two directions through the same join: an estimate reaches a
 * source only via `leads.hcp_estimate_id` → `leads.source_id`.
 *
 * **`null` is a first-class value in every one of these**, spelled `none`. Roughly
 * 41% of estimates have no lead at all, and "which estimates are unattributed?" is a
 * question worth being able to ask directly rather than by eliminating everything
 * else. `eq(col, 'none')` would match nothing and silently return an empty page.
 */
export interface EstimateFilters {
  /** `sources.key`, or "none" for estimates with no attributed source. */
  source?: string;
  /** `campaigns.name`, or "none". */
  campaign?: string;
  /** Normalised landing path (see lib/landing-page.ts), or "none". */
  page?: string;
  /** `edwardsville` | `ofallon` | `unknown`. */
  location?: string;
  /** Lead channel: call, web_form, sms, facebook_leadgen… or "none" for untracked. */
  type?: string;
}

export const NONE = "none";

/** Which of the params are actually set, in a stable order for rendering chips. */
export const FILTER_KEYS = ["source", "campaign", "page", "location", "type"] as const;

export function parseFilters(sp: Record<string, string | undefined>): EstimateFilters {
  const pick = (v: string | undefined) => {
    const s = v?.trim();
    return s ? s.slice(0, 200) : undefined;
  };
  return {
    source: pick(sp.source),
    campaign: pick(sp.campaign),
    page: pick(sp.page),
    location: pick(sp.location),
    type: pick(sp.type),
  };
}

export function hasAnyFilter(f: EstimateFilters): boolean {
  return FILTER_KEYS.some((k) => f[k] != null);
}

/**
 * SQL for the active filters, or undefined when none are set.
 *
 * Location mirrors the Location column exactly: `coalesce(lead, estimate)`. Note
 * that `leads.location` DEFAULTS TO 'unknown' rather than null, so a matched contact
 * whose location was never determined beats the estimate's own — filtering
 * `location=edwardsville` will not return an estimate that HCP marked edwardsville if
 * its lead says unknown. That is what the column displays, and a filter that
 * disagreed with the column it filters would be worse than one that inherits its
 * quirk. Verified against the real schema, including this case.
 */
export function filterSql(f: EstimateFilters): SQL | undefined {
  const parts: SQL[] = [];

  if (f.source) {
    parts.push(f.source === NONE ? isNull(leads.sourceId)! : eq(sources.key, f.source));
  }
  if (f.campaign) {
    parts.push(f.campaign === NONE ? isNull(leads.campaignId)! : eq(campaigns.name, f.campaign));
  }
  if (f.page) {
    parts.push(
      f.page === NONE
        ? or(isNull(leads.landingPage), eq(leads.landingPage, ""))!
        : eq(landingPathSql(leads.landingPage), f.page),
    );
  }
  if (f.location) {
    parts.push(sql`coalesce(${leads.location}, ${hcpEstimates.location}) = ${f.location}`);
  }
  if (f.type) {
    parts.push(f.type === NONE ? isNull(leads.id)! : eq(leads.type, f.type as never));
  }

  return parts.length ? and(...parts) : undefined;
}

/** Human label for a filter chip. */
export function filterLabel(key: (typeof FILTER_KEYS)[number], value: string): string {
  const noun = {
    source: "Source",
    campaign: "Campaign",
    page: "Landing page",
    location: "Location",
    type: "Channel",
  }[key];
  if (value === NONE) {
    return `${noun}: ${key === "type" ? "no tracked contact" : "none"}`;
  }
  const pretty =
    key === "location" ? (value === "ofallon" ? "O'Fallon" : value === "edwardsville" ? "Edwardsville" : value) : value;
  return `${noun}: ${pretty}`;
}

/** `/estimates` URL with one filter added or removed, preserving everything else. */
export function estimatesHref(
  base: { days?: number; g?: string; defaultDays: number },
  filters: EstimateFilters,
  change?: Partial<Record<(typeof FILTER_KEYS)[number], string | null>>,
): string {
  const q = new URLSearchParams();
  if (base.days != null && base.days !== base.defaultDays) q.set("days", String(base.days));
  if (base.g) q.set("g", base.g);
  const merged: Record<string, string | undefined> = { ...filters };
  for (const [k, v] of Object.entries(change ?? {})) {
    if (v === null) delete merged[k];
    else if (v != null) merged[k] = v;
  }
  for (const k of FILTER_KEYS) {
    const v = merged[k];
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `/estimates?${s}` : "/estimates";
}
