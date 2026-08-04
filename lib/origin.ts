import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";

/**
 * Origin allowlist for the public tracking endpoints (/api/track, /api/dni/assign).
 * Browsers always send `Origin` on cross-origin POSTs, so a present-but-unlisted
 * origin is some other site's page posting at us — reject it. A missing header is
 * a server-to-server caller (uptime monitor, curl); those pass and rely on the
 * per-IP rate limit instead.
 *
 * The list lives in app settings (editable under /settings), falling back to the
 * marketing-site defaults. The app's own origin is always allowed (the /dni-test
 * page posts to these routes same-origin).
 */

export const TRACKING_ORIGINS_KEY = "tracking_allowed_origins";

export const DEFAULT_ALLOWED_ORIGINS = ["https://arbor-mgmt.com", "https://www.arbor-mgmt.com"];

// Settings read is one indexed select, but /api/track fires on every pageview —
// cache the built set briefly. A save takes effect within a minute.
const CACHE_MS = 60_000;
let cached: { set: ReadonlySet<string>; at: number } | null = null;

async function allowedSet(): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.set;

  const stored = await getSetting<string[] | null>(TRACKING_ORIGINS_KEY, null);
  const set = new Set<string>();
  for (const entry of stored?.length ? stored : DEFAULT_ALLOWED_ORIGINS) {
    const o = normalizeOrigin(entry.trim());
    if (o) set.add(o);
  }
  const own = normalizeOrigin(env.APP_BASE_URL);
  if (own) set.add(own);

  cached = { set, at: now };
  return set;
}

export async function isAllowedOrigin(req: Request): Promise<boolean> {
  const origin = req.headers.get("origin");
  if (!origin) return true; // server-to-server — no Origin header to check
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return (await allowedSet()).has(normalized);
}

/** Normalize to `URL#origin` form so trailing slashes / case don't cause misses. */
export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null; // unparseable (e.g. the literal "null" from sandboxed iframes)
  }
}
