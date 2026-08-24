import { eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";
import { listCampaignsWithVolume } from "@/lib/queries/campaigns";

export const runtime = "nodejs";

/**
 * List every known ad campaign with the spend and leads attached to it, plus which
 * are flagged as non-customer-acquisition (recruiting). POST replaces the flagged
 * set. Admin-gated.
 *
 * The listing lives in lib/queries/campaigns.ts, shared with the MCP
 * `list_campaigns` tool. The MCP write (`set_campaign_excluded`) flags one
 * campaign at a time; this POST keeps its replace-the-set semantics for the form.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  return Response.json({ ok: true, campaigns: await listCampaignsWithVolume() });
}

const Body = z.object({ excludedIds: z.array(z.string()) });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const { excludedIds } = parsed.data;
  // Set the flagged set exactly: flag the listed ids, clear everything else. The
  // two statements are ordered clear-then-flag so an id in both lands on `true`.
  if (excludedIds.length === 0) {
    await db.update(campaigns).set({ excluded: false }).where(eq(campaigns.excluded, true));
  } else {
    await db.update(campaigns).set({ excluded: false }).where(notInArray(campaigns.id, excludedIds));
    await db.update(campaigns).set({ excluded: true }).where(inArray(campaigns.id, excludedIds));
  }

  return Response.json({ ok: true, excludedIds });
}
