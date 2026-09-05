import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { setLeadAttribution } from "@/lib/leads/attribution";

export const runtime = "nodejs";

/**
 * Correct a lead's source and/or campaign by hand. The logic — validation against
 * existing sources/campaigns, the source↔campaign agreement check, the manual lock
 * the automatic repair passes respect — lives in lib/leads/attribution.ts, shared
 * with the MCP `arbor_set_inquiry_attribution` tool. Session or ADMIN_API_TOKEN.
 */
const Body = z.object({
  sourceKey: z.string().max(100).optional(),
  campaignId: z.string().max(64).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  manual: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const result = await setLeadAttribution(id, parsed.data);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
