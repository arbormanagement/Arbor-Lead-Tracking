import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { issueCode, OAUTH_SCOPE, verifyClientId } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

/**
 * The consent form's target: re-validates everything the page validated (the
 * form is client-held state, so nothing it says is trusted), then issues the
 * single-use code and bounces back to the client.
 *
 * Session required — this is the moment a human grants access. The Origin
 * check stops a cross-site form auto-submitting an approval with the admin's
 * cookie; the consent page is same-origin, so a real approval always carries it.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(env.APP_BASE_URL).origin) {
    return Response.json({ error: "cross-origin approval rejected" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "invalid form" }, { status: 400 });
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const scope = String(form.get("scope") ?? "") || OAUTH_SCOPE;

  const registered = verifyClientId(clientId);
  if (!registered || !registered.includes(redirectUri) || !codeChallenge) {
    return Response.json({ error: "invalid authorization request" }, { status: 400 });
  }

  const code = await issueCode({ clientId, redirectUri, codeChallenge, scope });

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 303);
}
