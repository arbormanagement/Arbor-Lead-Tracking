import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { LEAD_DISPOSITIONS } from "@/lib/api-contracts/tools";
import { setLeadDisposition } from "@/lib/leads/classify-override";

export const runtime = "nodejs";

/**
 * Set an enquiry's disposition by hand. The logic lives in
 * lib/leads/classify-override.ts, shared with the MCP `arbor_set_lead_disposition`
 * tool. Session or ADMIN_API_TOKEN. `disposition: null` clears the manual override.
 */
const Body = z.object({
  disposition: z.enum(LEAD_DISPOSITIONS).nullable(),
  reason: z.string().max(300).nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const row = await setLeadDisposition(id, parsed.data.disposition, parsed.data.reason);
  if (!row) return Response.json({ error: "lead not found" }, { status: 404 });
  return Response.json({ ok: true, ...row });
}
