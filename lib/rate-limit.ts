/**
 * In-memory fixed-window rate limiter for the public/unauthenticated endpoints
 * (track, dni/assign, login). Single-process by design: the web service runs as
 * one long-lived Railway container, so no shared store is needed. Limits reset
 * on deploy, which is fine — this is abuse control, not billing.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

// Bound memory under key churn (e.g. an attacker rotating IPs): sweep expired
// windows whenever the map grows past the cap.
const MAX_KEYS = 50_000;

function sweep(now: number) {
  for (const [key, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Count a hit against `key` and report whether it stays within `limit` hits per
 * `windowMs`. Callers namespace their keys (`login:1.2.3.4`, `track:5.6.7.8`).
 */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) sweep(now);

  const w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  w.count++;
  return {
    ok: w.count <= limit,
    retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
  };
}

/** Client IP as seen through Railway's proxy (first hop of x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
