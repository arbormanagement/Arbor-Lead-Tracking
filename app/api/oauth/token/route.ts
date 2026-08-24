import {
  ACCESS_TTL_SEC,
  issueAccessToken,
  issueRefreshToken,
  redeemCode,
  rotateRefreshToken,
} from "@/lib/mcp-oauth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * OAuth token endpoint. Public (the client authenticates with PKCE, not a
 * secret — Claude registers as a public client), form-urlencoded per RFC 6749,
 * errors as RFC 6749 codes: Claude keys its re-consent flow on `invalid_grant`
 * specifically, so a custom code here would strand a connector in a retry loop.
 *
 * Claude allows this endpoint 10s (30s for refresh); everything here is one or
 * two indexed DB writes.
 */
const err = (error: string, description?: string, status = 400) =>
  Response.json({ error, ...(description ? { error_description: description } : {}) }, { status });

export async function POST(req: Request) {
  const limit = rateLimit(`oauth-token:${clientIp(req)}`, 30, 60_000);
  if (!limit.ok) return err("invalid_request", "rate limited", 429);

  const form = await req.formData().catch(() => null);
  if (!form) return err("invalid_request", "expected application/x-www-form-urlencoded");

  const grantType = String(form.get("grant_type") ?? "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const codeVerifier = String(form.get("code_verifier") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    if (!code || !codeVerifier || !clientId || !redirectUri) {
      return err("invalid_request", "code, code_verifier, client_id and redirect_uri are required");
    }

    const grant = await redeemCode({ code, clientId, redirectUri, codeVerifier });
    if (!grant) return err("invalid_grant");

    return Response.json({
      access_token: issueAccessToken(clientId, grant.scope),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: await issueRefreshToken(clientId, grant.scope),
      scope: grant.scope,
    });
  }

  if (grantType === "refresh_token") {
    const token = String(form.get("refresh_token") ?? "");
    if (!token) return err("invalid_request", "refresh_token is required");

    const rotated = await rotateRefreshToken(token);
    if (!rotated) return err("invalid_grant");

    return Response.json({
      access_token: issueAccessToken(rotated.clientId, rotated.scope),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SEC,
      // Rotation: the old refresh token was consumed in the same update that
      // read it; this is its replacement, per OAuth 2.1 for public clients.
      refresh_token: rotated.refreshToken,
      scope: rotated.scope,
    });
  }

  return err("unsupported_grant_type");
}
