import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { campaigns, hcpEstimates, leads, sources } from "@/lib/db/schema";
import { assignedToSql } from "@/lib/estimates/hcp-fields";
import { landingPathSql } from "@/lib/landing-page";

/**
 * Attribution filters on the estimate list — the other half of "show me the
 * estimates behind this source row".
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
 *
 * Lives in lib/ (moved from app/(dashboard)/estimates 2026-08-24) because the shared
 * query layer needs it too: /estimates the page and `list_estimates` the MCP tool
 * must mean the same thing by every filter, so there is exactly one `filterSql`.
 * URL/rendering helpers (`estimatesHref`, `filterLabel`) stay with the page.
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
  /**
   * Assigned employee — the sales arborist — matched as a substring, or "none" for
   * unassigned. Substring rather than equality because an estimate can carry more
   * than one assignee and they are stored joined; "Brooks" must still find a visit
   * Matt shared with someone.
   */
  arborist?: string;
  /** Service-address city (case-insensitive), or "none" where HCP has no address. */
  city?: string;
}

export const NONE = "none";

/** Which of the params are actually set, in a stable order for rendering chips. */
export const FILTER_KEYS = ["source", "campaign", "page", "location", "type", "arborist", "city"] as const;

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
    arborist: pick(sp.arborist),
    city: pick(sp.city),
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
 *
 * Any query using the source/campaign filters must join `sources` / `campaigns`
 * (via the lead), or Postgres rejects the reference.
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
  // These two filter the HCP side rather than the attribution chain — the first
  // filters that need no lead at all. Both read the same expressions the columns
  // are projected from, so a filter can never select a different set than the
  // column it is named after displays.
  if (f.arborist) {
    parts.push(
      f.arborist === NONE
        ? sql`${assignedToSql} is null`
        : sql`${assignedToSql} ilike ${"%" + f.arborist + "%"}`,
    );
  }
  if (f.city) {
    parts.push(
      f.city === NONE
        ? sql`nullif(trim(${hcpEstimates.address}->>'city'), '') is null`
        : sql`lower(${hcpEstimates.address}->>'city') = lower(${f.city})`,
    );
  }

  return parts.length ? and(...parts) : undefined;
}
