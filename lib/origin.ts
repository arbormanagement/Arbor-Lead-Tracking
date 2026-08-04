import { env } from "@/lib/env";

/**
 * Origin allowlist for the public tracking endpoints (/api/track, /api/dni/assign).
 * Browsers always send `Origin` on cross-origin POSTs, so a present-but-unlisted
 * origin is some other site's page posting at us — reject it. A missing header is
 * a server-to-server caller (uptime monitor, curl); those pass and rely on the
 * per-IP rate limit instead.
 */

// Built once: TRACKING_ALLOWED_ORIGINS plus the app's own origin (the /dni-test
// page posts to these routes same-origin).
const ALLOWED: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const entry of env.TRACKING_ALLOWED_ORIGINS.split(",")) {
    const o = normalizeOrigin(entry.trim());
    if (o) set.add(o);
  }
  const own = normalizeOrigin(env.APP_BASE_URL);
  if (own) set.add(own);
  return set;
})();

export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // server-to-server — no Origin header to check
  const normalized = normalizeOrigin(origin);
  return !!normalized && ALLOWED.has(normalized);
}

/** Normalize to `URL#origin` form so trailing slashes / case don't cause misses. */
function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null; // unparseable (e.g. the literal "null" from sandboxed iframes)
  }
}
