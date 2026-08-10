import { cookies } from "next/headers";
import { getSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { setCredential } from "@/lib/credentials";
import { DATA_MANAGER_SCOPE } from "@/lib/integrations/data-manager";
import { exchangeCode, GOOGLE_SCOPES, STATE_COOKIE, verifyState } from "@/lib/integrations/google-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SETTINGS = "/settings/integrations/google_ads";

function back(status: "ok" | "error", message: string): Response {
  const url = new URL(SETTINGS, env.APP_BASE_URL);
  url.searchParams.set("google_oauth", status);
  url.searchParams.set("message", message.slice(0, 300));
  return Response.redirect(url.toString(), 302);
}

/**
 * Consent callback: turn the one-time code into a refresh token and store it.
 *
 * The redirect back to Settings carries the outcome as text rather than dropping
 * the user on a blank page — including the granted scope list, because "connected
 * successfully" while `datamanager` is missing is exactly the failure this whole
 * flow exists to make visible.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return Response.redirect(new URL("/login", env.APP_BASE_URL).toString(), 302);

  const jar = await cookies();
  const url = new URL(req.url);
  const denied = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const nonce = jar.get(STATE_COOKIE)?.value;

  // One-shot: whatever happens below, this nonce is spent.
  jar.delete({ name: STATE_COOKIE, path: "/api/oauth/google" });

  if (denied) return back("error", `Google returned "${denied}" — consent was not granted.`);
  if (!verifyState(state, nonce)) {
    return back("error", "Consent state did not verify (expired, or the flow was not started from this app). Try again.");
  }
  if (!code) return back("error", "Google did not return an authorization code.");
  if (!credentialEncryptionAvailable()) {
    return back("error", "CREDENTIALS_ENCRYPTION_KEY is not set — there is nowhere to store the refresh token.");
  }

  let result;
  try {
    result = await exchangeCode(code);
  } catch (err) {
    return back("error", err instanceof Error ? err.message : String(err));
  }
  if (!result.refreshToken) return back("error", result.error ?? "Token exchange failed.");

  try {
    await setCredential("google_ads", "refresh_token", result.refreshToken);
  } catch (err) {
    return back("error", `Token obtained but could not be saved: ${err instanceof Error ? err.message : String(err)}`);
  }

  const missing = GOOGLE_SCOPES.filter((s) => !result.grantedScopes.includes(s));
  if (missing.length) {
    return back(
      "error",
      `Refresh token saved, but these scopes were NOT granted: ${missing.join(", ")}. ` +
        `Offline conversion export needs ${DATA_MANAGER_SCOPE}.`,
    );
  }
  return back("ok", `Connected. Refresh token stored and encrypted. Granted scopes: ${result.grantedScopes.join(" ")}`);
}
