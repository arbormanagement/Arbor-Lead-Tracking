import { z } from "zod";
import { isAllowedRedirect, mintClientId } from "@/lib/mcp-oauth";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * RFC 7591 dynamic client registration — unauthenticated by spec, so it grants
 * nothing on its own: the returned client_id is an HMAC-signed capsule of the
 * redirect_uris (see lib/mcp-oauth.ts), every one of which must be on Claude's
 * published-callback allowlist, and nothing issues a token without the admin
 * approving on the consent page.
 */
const Body = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  // Claude sends more registration metadata (client_name, grant_types, …);
  // it is advisory and unauthenticated, so it is accepted and ignored.
});

export async function POST(req: Request) {
  const limit = rateLimit(`oauth-register:${clientIp(req)}`, 10, 60_000);
  if (!limit.ok) {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "rate limited" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "redirect_uris is required" },
      { status: 400 },
    );
  }

  const bad = parsed.data.redirect_uris.find((u) => !isAllowedRedirect(u));
  if (bad) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description: `redirect_uri not allowed: ${bad}. This server accepts Claude's published callbacks only.`,
      },
      { status: 400 },
    );
  }

  return Response.json(
    {
      client_id: mintClientId(parsed.data.redirect_uris),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: parsed.data.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 },
  );
}
