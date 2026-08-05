import { env } from "@/lib/env";
import { getSession } from "@/lib/auth";
import { secretEquals } from "@/lib/secret-compare";

/**
 * Auth for admin routes that automation needs to drive — currently importing a
 * transferred phone number and setting the routing default, both needed for the
 * CallRail → Twilio cutover without a human at a browser.
 *
 * Two ways in:
 *   • a normal admin session cookie (what the UI uses), or
 *   • `Authorization: Bearer <ADMIN_API_TOKEN>` — the same pattern
 *     /api/cron/[job] already uses for CRON_SECRET.
 *
 * This is NOT a general admin bypass, by design:
 *   • Routes opt in individually. Everything else stays session-only.
 *   • Callers can tell the two apart (`via`), so a route can refuse the riskier
 *     parts of its own contract to a token — `/api/numbers` uses this to allow
 *     importing an owned number while refusing to *buy* one.
 *   • With ADMIN_API_TOKEN unset (the default) token auth is off entirely, so
 *     this cannot silently weaken an environment that never opted in.
 *
 * Revoking is deleting one env var. Rotating is changing it. Neither touches
 * the admin password.
 */

export type AdminAuth =
  | { ok: true; via: "session"; email: string }
  | { ok: true; via: "token" }
  | { ok: false };

export async function authorizeAdmin(req: Request): Promise<AdminAuth> {
  const session = await getSession();
  if (session) return { ok: true, via: "session", email: session.email };

  // Only consider the token when one is configured — an unset/blank env var must
  // never match a caller sending "Bearer ".
  const configured = env.ADMIN_API_TOKEN;
  if (configured && secretEquals(req.headers.get("authorization"), `Bearer ${configured}`)) {
    return { ok: true, via: "token" };
  }

  return { ok: false };
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export function forbidden(reason: string): Response {
  return Response.json({ error: reason }, { status: 403 });
}
