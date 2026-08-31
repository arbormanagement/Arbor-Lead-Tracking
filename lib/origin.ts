import { env } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/settings";

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

/**
 * The configured site origins, in order, before the app's own origin is folded in.
 * The DNI canary needs the FIRST one — the marketing site it should be checking —
 * which a Set cannot promise; reading the setting twice would let the canary and the
 * allowlist drift apart, which is the failure where the canary passes against a site
 * nobody visits.
 */
export async function trackingOrigins(): Promise<string[]> {
  const stored = await getSetting<string[] | null>(TRACKING_ORIGINS_KEY, null);
  const list = stored?.length ? stored : DEFAULT_ALLOWED_ORIGINS;
  return list.map((e) => normalizeOrigin(e.trim())).filter((o): o is string => !!o);
}

async function allowedSet(): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.set;

  const set = new Set<string>(await trackingOrigins());
  const own = normalizeOrigin(env.APP_BASE_URL);
  if (own) set.add(own);

  cached = { set, at: now };
  return set;
}

/**
 * `requireOrigin` closes the "just omit the header" hole for endpoints where a
 * rejection is cheap. Absent-passes is the right default for /api/track — a
 * rejected form post is a LOST LEAD, and some privacy tooling strips Origin — but
 * it is the wrong default for /api/dni/assign, where absent-passes lets anyone
 * with curl lease every number in the 5-number pool (browsers always send Origin
 * on POST, so no real visitor is affected, and a rejected assign merely leaves the
 * page on its static number).
 */
export async function isAllowedOrigin(
  req: Request,
  { requireOrigin = false }: { requireOrigin?: boolean } = {},
): Promise<boolean> {
  const origin = req.headers.get("origin");
  if (!origin) return !requireOrigin; // server-to-server — no Origin header to check
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

export type TrackingOriginsResult =
  | { ok: true; allowedOrigins: string[]; defaults: boolean }
  | { ok: false; invalid: string };

/**
 * Save the tracking-origin allowlist — the sites whose pages may POST to
 * /api/track and /api/dni/assign. Shared by `/api/settings/tracking` and the MCP
 * `arbor_set_tracking_origins` tool.
 *
 * Accepts a comma- or newline-separated string, or a list. An empty set clears the
 * stored value so the built-in arbor-mgmt.com defaults apply again — which is not
 * the same as an empty allowlist, and is why it reports `defaults` back. Bare
 * hostnames are accepted as a convenience and read as https.
 *
 * Takes effect within a minute: `trackingOrigins()` caches the built set briefly.
 */
export async function setTrackingOrigins(input: string | string[]): Promise<TrackingOriginsResult> {
  const entries = (Array.isArray(input) ? input : input.split(/[,\n]/)).map((s) => s.trim()).filter(Boolean);

  if (entries.length === 0) {
    await setSetting(TRACKING_ORIGINS_KEY, null);
    return { ok: true, allowedOrigins: DEFAULT_ALLOWED_ORIGINS, defaults: true };
  }

  const origins: string[] = [];
  for (const entry of entries) {
    const o = normalizeOrigin(entry.includes("://") ? entry : `https://${entry}`);
    if (!o) return { ok: false, invalid: entry };
    if (!origins.includes(o)) origins.push(o);
  }

  await setSetting(TRACKING_ORIGINS_KEY, origins);
  return { ok: true, allowedOrigins: origins, defaults: false };
}
