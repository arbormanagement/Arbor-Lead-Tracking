import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Reduce a stored landing page to the PATH it represents.
 *
 * `landing_page` is `location.href` verbatim — scheme, host, query string and hash.
 * Grouping on it splits one page into a row per click, because every paid arrival
 * carries its own `gclid`: `/services/tree-removal` is the second-busiest page on
 * the site and appeared as five separate rows that all *rendered identically*,
 * because the display already reduced them to a pathname. In a sample of recent
 * leads, 23 distinct stored values collapse to 9 real paths.
 *
 * Expressed as SQL rather than TypeScript so that grouping and display use the same
 * value by construction — normalising at render time is exactly how the two came
 * apart. It lives here rather than inline so the Channels and Landing-pages views
 * of /sources cannot disagree
 * about what a page is.
 *
 * Lowercased on the way through: paths are case-sensitive in principle, but a
 * `/About` link in one place and `/about` in another is a tagging accident, not two
 * pages. Trailing slashes go for the same reason. A URL that reduces to nothing —
 * the bare homepage — becomes `/`.
 *
 * The raw value stays on the row. It is the forensic record, and it is where the
 * evidence of ad-platform UTM template drift lives.
 */
export function landingPathSql(col: AnyPgColumn): SQL<string> {
  return sql<string>`coalesce(nullif(regexp_replace(regexp_replace(regexp_replace(lower(${col}), '[?#].*$', ''), '^https?://[^/]+', ''), '/+$', ''), ''), '/')`;
}
