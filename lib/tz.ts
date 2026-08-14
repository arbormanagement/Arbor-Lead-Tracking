/**
 * Business-timezone day bucketing. Ad platforms report spend per account-timezone
 * day (America/Chicago for Arbor), so anything aggregated alongside spend must use
 * the same day boundary — a 10pm CT lead is "tomorrow" in UTC and would land on
 * the wrong roi_daily row if bucketed by toISOString().
 */
export const BUSINESS_TZ = "America/Chicago";

// en-CA formats as YYYY-MM-DD directly — no formatToParts reassembly needed.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of `d` in the business timezone. */
export function businessDate(d: Date): string {
  return fmt.format(d);
}

/** How far ahead of UTC `tz` is at the instant `at`, in ms. */
function offsetMsAt(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  // `hour` is "24" at midnight under hour12:false in some ICU versions.
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - at.getTime();
}

/**
 * Parse a WALL-CLOCK timestamp that carries no offset — "yyyy-MM-dd HH:mm:ss" —
 * as a time in `tz`, returning the correct instant.
 *
 * `new Date("2026-08-13 14:58:00")` does NOT do this: with no offset in the
 * string, Node reads it as the SERVER's local time. On Railway that is UTC, so a
 * Chicago wall time was landing five hours early (six in winter) — which is how a
 * Local Services lead and the call it produced ended up looking like two contacts
 * hours apart instead of the same one a minute apart.
 *
 * Google Ads returns every DATE_TIME field in the ACCOUNT's timezone with no
 * offset attached, so anything read from one of those fields must come through
 * here. Verified against the API: customer 8300392986 (Arbor Management) reports
 * `time_zone: America/Chicago`, which is why BUSINESS_TZ is the right default.
 *
 * The offset is resolved twice because it depends on the very instant being
 * derived: near a DST boundary the first guess can sit on the wrong side of the
 * transition, and re-deriving from the corrected instant settles it.
 */
export function parseWallTime(wall: string, tz: string = BUSINESS_TZ): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const asIfUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const firstPass = asIfUtc - offsetMsAt(new Date(asIfUtc), tz);
  return new Date(asIfUtc - offsetMsAt(new Date(firstPass), tz));
}
