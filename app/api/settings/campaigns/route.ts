import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { adSpend, campaigns, leads } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * List every known ad campaign with the spend and leads attached to it, plus which
 * are flagged as non-customer-acquisition (recruiting). POST replaces the flagged
 * set. Admin-gated.
 *
 * Campaigns are created by the spend sync and the Facebook lead ingest, so this is
 * a read of what the syncs have already seen — there is nothing to configure until
 * a platform has been pulled at least once.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rows = await db
    .select({
      id: campaigns.id,
      platform: campaigns.platform,
      externalCampaignId: campaigns.externalCampaignId,
      name: campaigns.name,
      excluded: campaigns.excluded,
    })
    .from(campaigns);

  // Spend + lead volume per campaign — grouped separately and merged, so a campaign
  // with spend but no leads (or the reverse) still shows up with real numbers.
  const spendRows = await db
    .select({ campaignId: adSpend.campaignId, cents: sql<number>`coalesce(sum(${adSpend.spendCents}),0)::int` })
    .from(adSpend)
    .groupBy(adSpend.campaignId);
  const leadRows = await db
    .select({ campaignId: leads.campaignId, n: sql<number>`count(*)::int` })
    .from(leads)
    .groupBy(leads.campaignId);

  const spendBy = new Map(spendRows.map((r) => [r.campaignId, r.cents]));
  const leadsBy = new Map(leadRows.map((r) => [r.campaignId, r.n]));

  const out = rows
    .map((r) => ({ ...r, spendCents: spendBy.get(r.id) ?? 0, leadsCount: leadsBy.get(r.id) ?? 0 }))
    .sort((a, b) => b.spendCents - a.spendCents || (a.name ?? "").localeCompare(b.name ?? ""));

  return Response.json({ ok: true, campaigns: out });
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
