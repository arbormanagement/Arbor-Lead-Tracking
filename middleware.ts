import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Lightweight gate: redirect unauthenticated dashboard requests to /login based
 * on cookie presence. Authoritative HMAC verification happens in the dashboard
 * server layout (Node runtime) — middleware runs on the edge where node:crypto
 * isn't available, so we keep it to a cheap presence check for UX.
 *
 * Public surfaces (tracking, Twilio, webhooks, the snippet, login) are excluded
 * via the matcher below.
 */
export function middleware(req: NextRequest) {
  // Same presence-gate logic as the cookie, for machine callers: an API request
  // carrying a bearer token is passed through to its handler, which does the
  // authoritative timing-safe check in the Node runtime (see lib/admin-auth.ts).
  // Without this, a token request is redirected to /login and the route never
  // runs. This grants nothing on its own — routes that don't opt into token auth
  // still call getSession() and reject. Restricted to /api so dashboard pages
  // always require a real session cookie.
  const bearer =
    req.nextUrl.pathname.startsWith("/api/") &&
    (req.headers.get("authorization") ?? "").startsWith("Bearer ");

  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession && !bearer) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except public API surfaces, the snippet, login, and assets.
  // OAuth additions: .well-known discovery + register/token are public by spec
  // (nothing there grants access on its own); /oauth/authorize is EXCLUDED so it
  // can do its own session check and send the login redirect with the request's
  // query string intact — this presence gate sets `next` from the pathname only,
  // which would strip the OAuth params and strand the flow after login.
  // /api/mcp is excluded too: it is fully self-guarding (bearer/OAuth, fail
  // closed), and Claude's connector discovery BEGINS with an unauthenticated
  // request that must receive the handler's 401 + WWW-Authenticate — a redirect
  // to /login here would strand the flow before it starts.
  matcher: [
    // `api/webhook` (singular) carries the routes ported from Arbor-Automations at
    // their legacy paths — external systems (Retell, HCP, Meta, the website form)
    // are configured against them, and the Retell inbound webhook URL can only be
    // changed in Retell's dashboard, per phone number.
    "/((?!api/track|api/dni|api/twilio|api/webhooks|api/webhook|api/cron|api/admin|api/auth|api/oauth|api/mcp|api/health|\\.well-known|oauth/authorize|track.js|dni-test|login|_next|favicon.ico).*)",
  ],
};
