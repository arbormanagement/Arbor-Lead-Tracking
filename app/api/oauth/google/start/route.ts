import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { consentUrl, createState, oauthClient, STATE_COOKIE } from "@/lib/integrations/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Begin Google consent. Session-gated only — no bearer-token path, deliberately:
 * this ends with a browser at Google's consent screen, so a caller that isn't a
 * logged-in browser has nothing to gain from it.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.redirect(new URL("/login", env.APP_BASE_URL).toString(), 302);

  let clientId: string;
  try {
    ({ clientId } = await oauthClient());
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const { state, nonce } = createState();
  (await cookies()).set(STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // must survive the top-level redirect back from Google
    path: "/api/oauth/google",
    maxAge: 600,
  });

  return Response.redirect(consentUrl(clientId, state), 302);
}
