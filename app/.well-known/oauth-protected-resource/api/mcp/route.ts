import { protectedResourceMetadata } from "@/lib/mcp-oauth";

export const runtime = "nodejs";

/** Path-suffix variant of ../../route.ts — Claude probes this location first. */
export function GET() {
  return Response.json(protectedResourceMetadata());
}
