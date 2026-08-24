import { protectedResourceMetadata } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

/**
 * RFC 9728 protected resource metadata for /api/mcp. Public by spec — this is
 * how Claude discovers where the authorization server lives. Also served at
 * ./api/mcp (the path-suffix probe Claude tries first).
 */
export function GET() {
  return Response.json(protectedResourceMetadata());
}
