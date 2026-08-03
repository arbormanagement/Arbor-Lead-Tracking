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
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Protect everything except public API surfaces, the snippet, login, and assets.
  matcher: [
    "/((?!api/track|api/dni|api/twilio|api/webhooks|api/cron|api/admin|api/auth|api/health|track.js|dni-test|login|_next|favicon.ico).*)",
  ],
};
