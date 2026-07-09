import { z } from "zod";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { leads } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Manual lead override: mark a lead as a lead / not-a-lead by hand. Sets is_lead_manual
 * so auto-classification (AI/keyword) won't overwrite the human decision. `isLead:null`
 * clears the override back to auto. Admin-gated.
 */
const Body = z.object({ isLead: z.boolean().nullable() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const clearing = parsed.data.isLead === null;
  const [row] = await db
    .update(leads)
    .set(
      clearing
        ? { isLeadManual: false, leadReason: "auto (override cleared)" }
        : { isLead: parsed.data.isLead, isLeadManual: true, leadReason: parsed.data.isLead ? "manual: marked lead" : "manual: not a lead" },
    )
    .where(eq(leads.id, id))
    .returning({ id: leads.id, isLead: leads.isLead, isLeadManual: leads.isLeadManual });

  if (!row) return Response.json({ error: "lead not found" }, { status: 404 });
  return Response.json({ ok: true, ...row });
}
