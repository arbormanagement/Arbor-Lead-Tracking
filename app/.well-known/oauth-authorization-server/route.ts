import { authorizationServerMetadata } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

/** RFC 8414 authorization server metadata. Public by spec. */
export function GET() {
  return Response.json(authorizationServerMetadata());
}
