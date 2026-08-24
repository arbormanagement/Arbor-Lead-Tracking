import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mcpOauthGrants } from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * A minimal OAuth 2.1 authorization server in front of /api/mcp, built to
 * exactly what Claude's connector flow requires and nothing more:
 * dynamic client registration, authorization-code + PKCE (S256), refresh-token
 * rotation, RFC 8414 discovery. See GENERATIVE-UI.md.
 *
 * Exists because claude.ai's custom-connector UI authenticates via OAuth (the
 * `static_headers` bearer option is still a gated beta), and the artifact `mcp`
 * capability rides the claude.ai connector — so without this, the endpoint is
 * reachable from Claude Code only. The static MCP_API_TOKEN path stays
 * alongside for machine callers.
 *
 * Single-tenant on purpose, and simpler for it:
 *  - The "user" is the app's one admin; consent is gated by the existing
 *    /login session. No Google or other IdP — the connector spec needs US to
 *    be the authorization server either way (Claude registers itself as a
 *    client via DCR, which third-party IdPs don't allow), so federating the
 *    login screen would add a moving part without removing one.
 *  - Client registration is UNAUTHENTICATED by spec, so a client_id must not
 *    be trusted. Instead of a clients table, the client_id IS the registration:
 *    an HMAC-signed capsule of the redirect_uris. Verifying the signature
 *    re-validates the registration with no storage and nothing to clean up.
 *  - Redirect URIs are allowlisted to Claude's published callbacks. DCR being
 *    open means anyone can mint a client_id; the allowlist is what stops a
 *    crafted consent link from bouncing a code to an attacker's server.
 *  - Access tokens are stateless HMAC (1h). Codes and refresh tokens are
 *    stored hashed, single-use, in mcp_oauth_grants.
 *
 * Everything signs with COOKIE_SIGNING_SECRET — rotating that secret already
 * logs the admin out, and it invalidating MCP tokens too is the behavior you
 * want from a rotation.
 */

export const ACCESS_TTL_SEC = 60 * 60; // 1h
const REFRESH_TTL_SEC = 30 * 24 * 60 * 60; // 30d
const CODE_TTL_SEC = 5 * 60; // 5m

export const OAUTH_SCOPE = "mcp";

const base = () => env.APP_BASE_URL.replace(/\/$/, "");

// ── Discovery documents ──────────────────────────────────────────────────────

/** RFC 9728 protected resource metadata. `resource` must match the MCP URL exactly. */
export function protectedResourceMetadata() {
  return {
    resource: `${base()}/api/mcp`,
    authorization_servers: [base()],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata() {
  return {
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/api/oauth/token`,
    registration_endpoint: `${base()}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Claude registers as a PUBLIC client; PKCE is the proof, not a secret.
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [OAUTH_SCOPE],
  };
}

// ── Redirect allowlist ───────────────────────────────────────────────────────

/**
 * Claude's published callbacks only: the hosted surfaces' fixed URI, and
 * Claude Code's RFC 8252 loopback (any port — the port varies per session and
 * the spec requires ignoring it for loopback IPs; Claude Code declares both
 * localhost and 127.0.0.1 forms).
 */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === "https://claude.ai/api/mcp/auth_callback") return true;
  try {
    const u = new URL(uri);
    return (
      u.protocol === "http:" &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
      u.pathname === "/callback" &&
      u.search === "" &&
      u.hash === ""
    );
  } catch {
    return false;
  }
}

// ── Signed client ids (stateless DCR) ────────────────────────────────────────

interface ClientCapsule {
  v: 1;
  redirect_uris: string[];
  iat: number;
}

function hmac(data: string): string {
  return createHmac("sha256", env.COOKIE_SIGNING_SECRET).update(data).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function mintClientId(redirectUris: string[]): string {
  const capsule: ClientCapsule = { v: 1, redirect_uris: redirectUris, iat: Math.floor(Date.now() / 1000) };
  const body = Buffer.from(JSON.stringify(capsule)).toString("base64url");
  return `acl_${body}.${hmac(body)}`;
}

/** Returns the registered redirect_uris, or null for a forged/garbled client_id. */
export function verifyClientId(clientId: string): string[] | null {
  if (!clientId.startsWith("acl_")) return null;
  const [body, sig] = clientId.slice(4).split(".");
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const capsule = JSON.parse(Buffer.from(body, "base64url").toString()) as ClientCapsule;
    if (capsule.v !== 1 || !Array.isArray(capsule.redirect_uris)) return null;
    // Re-validate against the allowlist on every use: a client_id minted before
    // an allowlist tightening must not stay valid past it.
    if (!capsule.redirect_uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) return null;
    return capsule.redirect_uris;
  } catch {
    return null;
  }
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export function pkceMatches(verifier: string, challenge: string): boolean {
  const derived = createHash("sha256").update(verifier).digest("base64url");
  return safeEqual(derived, challenge);
}

// ── Stored grants: codes + refresh tokens ────────────────────────────────────

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Opportunistic cleanup so the table cannot grow forever; a week of expired
 *  rows is kept for debugging. Called from the token endpoint. */
async function sweepExpired(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  await db.delete(mcpOauthGrants).where(lt(mcpOauthGrants.expiresAt, cutoff));
}

export async function issueCode(args: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}): Promise<string> {
  const code = `mac_${randomBytes(32).toString("base64url")}`;
  await db.insert(mcpOauthGrants).values({
    kind: "code",
    secretHash: sha256(code),
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    codeChallenge: args.codeChallenge,
    scope: args.scope,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
  });
  return code;
}

/**
 * Exchange a code: single-use, bound to client_id + redirect_uri + PKCE.
 * The consume is an atomic conditional UPDATE, so a replayed code loses the
 * race instead of double-issuing.
 */
export async function redeemCode(args: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ scope: string } | null> {
  const [row] = await db
    .update(mcpOauthGrants)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(mcpOauthGrants.secretHash, sha256(args.code)),
        eq(mcpOauthGrants.kind, "code"),
        isNull(mcpOauthGrants.consumedAt),
      ),
    )
    .returning({
      clientId: mcpOauthGrants.clientId,
      redirectUri: mcpOauthGrants.redirectUri,
      codeChallenge: mcpOauthGrants.codeChallenge,
      scope: mcpOauthGrants.scope,
      expiresAt: mcpOauthGrants.expiresAt,
    });
  if (!row) return null;
  if (row.expiresAt < new Date()) return null;
  if (row.clientId !== args.clientId) return null;
  if (row.redirectUri !== args.redirectUri) return null;
  if (!row.codeChallenge || !pkceMatches(args.codeVerifier, row.codeChallenge)) return null;
  return { scope: row.scope ?? OAUTH_SCOPE };
}

export async function issueRefreshToken(clientId: string, scope: string): Promise<string> {
  const token = `mrt_${randomBytes(32).toString("base64url")}`;
  await db.insert(mcpOauthGrants).values({
    kind: "refresh",
    secretHash: sha256(token),
    clientId,
    scope,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
  });
  return token;
}

/**
 * Rotate a refresh token (OAuth 2.1 requirement for public clients): the old
 * token is consumed in the same atomic update that reads it, and a new one is
 * issued in the same response. A consumed token presented again is
 * invalid_grant — the RFC 6749 code Claude keys its re-auth flow on.
 */
export async function rotateRefreshToken(
  token: string,
): Promise<{ clientId: string; scope: string; refreshToken: string } | null> {
  await sweepExpired();
  const [row] = await db
    .update(mcpOauthGrants)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(mcpOauthGrants.secretHash, sha256(token)),
        eq(mcpOauthGrants.kind, "refresh"),
        isNull(mcpOauthGrants.consumedAt),
      ),
    )
    .returning({
      clientId: mcpOauthGrants.clientId,
      scope: mcpOauthGrants.scope,
      expiresAt: mcpOauthGrants.expiresAt,
    });
  if (!row || row.expiresAt < new Date()) return null;
  const scope = row.scope ?? OAUTH_SCOPE;
  const refreshToken = await issueRefreshToken(row.clientId, scope);
  return { clientId: row.clientId, scope, refreshToken };
}

// ── Stateless access tokens ──────────────────────────────────────────────────

interface AccessPayload {
  v: 1;
  cid: string;
  scope: string;
  exp: number;
}

export function issueAccessToken(clientId: string, scope: string): string {
  const payload: AccessPayload = {
    v: 1,
    cid: clientId,
    scope,
    exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `mat_${body}.${hmac(body)}`;
}

export function verifyAccessToken(token: string): AccessPayload | null {
  if (!token.startsWith("mat_")) return null;
  const [body, sig] = token.slice(4).split(".");
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as AccessPayload;
    if (payload.v !== 1 || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
