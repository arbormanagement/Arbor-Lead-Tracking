import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getPlatformCreds } from "@/lib/credentials";
import { fetchWithRetry } from "./http";
import { DATA_MANAGER_SCOPE } from "./data-manager";

/**
 * Self-service Google OAuth consent, so adding a scope is a link the owner clicks
 * inside this app rather than a trip through the OAuth playground with a refresh
 * token pasted between two browser tabs.
 *
 * This exists because of a hard boundary that no amount of API access moves: an
 * access token can only carry scopes a human has consented to. The stored refresh
 * token was minted for `.../auth/adwords`, Data Manager needs `.../auth/datamanager`,
 * and nothing server-side can grant that to itself — Google's whole authorization
 * model would be broken if it could. So the shortest honest path is to make the
 * consent step one click and land the result straight in encrypted storage.
 *
 * Two properties worth keeping if this is ever extended:
 *   · `include_granted_scopes` makes consent INCREMENTAL. The new token keeps every
 *     scope the account already granted this client, so re-consenting to add Data
 *     Manager cannot quietly drop `adwords` and break spend sync.
 *   · the callback stores the refresh token via `setCredential`, i.e. encrypted with
 *     the CURRENT key. That matters right now: the rows written under the old
 *     CREDENTIALS_ENCRYPTION_KEY no longer decrypt, and anything written through
 *     this path is readable again by construction.
 *
 * SHARED CLIENT — read before changing anything here. OAuth client
 * `425178785038-….apps.googleusercontent.com` is used by BOTH this app and the
 * Arbor MCP server (Railway project "MCP Server", `GOOGLE_CLIENT_ID` /
 * `GOOGLE_REFRESH_TOKEN`, redirect `https://arbor-mcp.up.railway.app/oauth/google/callback`).
 * Two consequences:
 *   · adding a redirect URI is additive — the MCP server's stays registered — and
 *     a refresh token issued here does not invalidate the one it already holds.
 *     Google only evicts old tokens past 100 per client per account; there are two.
 *   · REVOKING the grant, however, kills every token for this client at once. So
 *     "revoke and retry" is never the right advice for a problem in this app.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google Ads read/report + offline conversion ingest. Kept together because the
 *  app needs both on one token and incremental consent means asking for both is
 *  never a downgrade. */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/adwords", DATA_MANAGER_SCOPE];

export const STATE_COOKIE = "arbor_goauth";
const STATE_TTL_SEC = 600;

export function redirectUri(): string {
  return `${env.APP_BASE_URL.replace(/\/$/, "")}/api/oauth/google/callback`;
}

function sign(data: string): string {
  return createHmac("sha256", env.COOKIE_SIGNING_SECRET).update(data).digest("base64url");
}

/** `nonce.exp.sig` — the nonce is also set as an httpOnly cookie, so a signed state
 *  captured from a URL can't be replayed from someone else's browser. */
export function createState(): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SEC;
  const body = `${nonce}.${exp}`;
  return { state: `${body}.${sign(body)}`, nonce };
}

export function verifyState(state: string | null, cookieNonce: string | undefined): boolean {
  if (!state || !cookieNonce) return false;
  const [nonce, exp, sig] = state.split(".");
  if (!nonce || !exp || !sig) return false;
  const expected = Buffer.from(sign(`${nonce}.${exp}`));
  const got = Buffer.from(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const a = Buffer.from(nonce);
  const b = Buffer.from(cookieNonce);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function oauthClient(): Promise<{ clientId: string; clientSecret: string }> {
  const c = await getPlatformCreds("google_ads");
  if (!c.client_id || !c.client_secret) {
    throw new Error(
      "Google Ads OAuth Client ID / Client Secret are not configured — set them in Settings → Integrations → Google Ads first.",
    );
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export function consentUrl(clientId: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // Offline + forced consent is the only combination Google guarantees returns a
    // refresh_token. Without `prompt=consent` an account that has already approved
    // this client gets an access token and nothing durable, and the callback would
    // have nothing to store.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface TokenExchange {
  refreshToken?: string;
  grantedScopes: string[];
  error?: string;
}

export async function exchangeCode(code: string): Promise<TokenExchange> {
  const { clientId, clientSecret } = await oauthClient();
  const res = await fetchWithRetry(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    },
    { timeoutMs: 30_000 },
  );
  const json = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  const grantedScopes = json.scope ? json.scope.split(" ") : [];
  if (!res.ok) {
    return { grantedScopes, error: `${json.error ?? res.status}: ${json.error_description ?? "token exchange failed"}` };
  }
  if (!json.refresh_token) {
    // Google withholds it when the grant already exists and prompt=consent was
    // dropped or overridden. Say so plainly — the symptom otherwise looks like a
    // successful connect that changed nothing.
    //
    // Deliberately NOT suggesting "revoke this app at myaccount.google.com and
    // retry", which is the usual advice: this OAuth client is SHARED with the
    // Arbor MCP server (see the note at the top of this file), and revoking the
    // grant would invalidate its GOOGLE_REFRESH_TOKEN too, taking out every
    // Google tool there to fix a problem in this app.
    return {
      grantedScopes,
      error:
        "Google returned no refresh_token — the existing grant was reused. Try Connect again. " +
        "Do NOT revoke access at myaccount.google.com: this OAuth client is shared with the Arbor MCP server " +
        "and revoking would invalidate its Google credentials as well.",
    };
  }
  return { refreshToken: json.refresh_token, grantedScopes };
}
