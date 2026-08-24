import { z } from "zod";
import { getSession } from "@/lib/auth";
import { setLeadClassification } from "@/lib/leads/classify-override";

export const runtime = "nodejs";

/**
 * Manual lead override: mark a lead as a lead / not-a-lead by hand. The logic
 * lives in lib/leads/classify-override.ts, shared with the MCP `classify_lead`
 * tool. Admin-gated.
 */
const Body = z.object({ isLead: z.boolean().nullable() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const row = await setLeadClassification(id, parsed.data.isLead);
  if (!row) return Response.json({ error: "lead not found" }, { status: 404 });
  return Response.json({ ok: true, ...row });
}
