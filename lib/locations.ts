/**
 * Where a LOCATION gets its name.
 *
 * The same problem `lib/sources/naming.ts` solves for sources and
 * `lib/landing-page.ts` for pages, one dimension over: five call sites each
 * hand-rolled `ofallon → "O'Fallon"`, and they had already drifted. `/sources`
 * called the third value "Location unknown", `/estimates` called it "Unknown", and
 * the campaign view rendered the raw enum through a CSS `text-transform:
 * capitalize` — which is also why it needed a special case for O'Fallon, the one
 * value capitalize gets wrong. A sixth surface would have invented a sixth spelling.
 *
 * Deliberately dependency-free so a client component can import it. The same list
 * backs `locationEnum` in the schema, but schema.ts loads the Postgres driver — the
 * split is the same one `lib/messaging/channels.ts` keeps from `thread.ts`.
 */

/** Every branch a contact, estimate or number can belong to. `unknown` is a real
 *  value, not a null stand-in: most contacts genuinely have no location, because
 *  only Google Business Profile determines one directly (see `inferLocation`). */
export const LOCATIONS = ["edwardsville", "ofallon", "unknown"] as const;

export type Location = (typeof LOCATIONS)[number];

const LABEL: Record<string, string> = {
  edwardsville: "Edwardsville",
  ofallon: "O'Fallon",
  unknown: "Unknown",
};

/**
 * Display name for a location. Use this anywhere the surrounding column, header or
 * section already says these values are locations — which is almost everywhere.
 *
 * Falls back to the raw value rather than "Unknown", so a location added to the enum
 * and not to this map surfaces as itself instead of silently merging into the
 * unknown bucket and under-reporting it.
 */
export function locationLabel(v: string | null | undefined): string {
  if (!v) return LABEL.unknown;
  return LABEL[v] ?? v;
}
