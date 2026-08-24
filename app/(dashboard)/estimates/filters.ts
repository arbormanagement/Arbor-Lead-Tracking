import {
  FILTER_KEYS,
  NONE,
  type EstimateFilters,
} from "@/lib/estimates/filters";

/**
 * Page-side half of the estimate filters: URL building and chip labels.
 *
 * The filter definitions and their SQL moved to lib/estimates/filters.ts
 * (2026-08-24) so the shared query layer — and through it the MCP tools — apply
 * exactly the same meaning to every filter this page renders. Everything the page
 * imports from here still works; the SQL half is re-exported.
 */
export { FILTER_KEYS, NONE, filterSql, hasAnyFilter, parseFilters } from "@/lib/estimates/filters";
export type { EstimateFilters } from "@/lib/estimates/filters";

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
