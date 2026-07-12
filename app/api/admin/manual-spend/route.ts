import { and, eq, sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { manualSpend } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Manual monthly spend for channels without an API sync (LSA, GBP, print, …).
 * POST upserts one (source, month) row; DELETE removes it. Amounts in integer
 * cents; `month` accepts "YYYY-MM" and is stored as the first of the month.
 * The next attribution run folds these into roi_daily (spread across the month).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { sourceId?: string; month?: string; amountCents?: number; note?: string }
    | null;
  const month = normalizeMonth(body?.month);
  const amountCents = Number(body?.amountCents);
  if (!body?.sourceId || !month || !Number.isFinite(amountCents) || amountCents < 0) {
    return Response.json({ error: "sourceId, month (YYYY-MM), and a non-negative amountCents are required" }, { status: 400 });
  }

  await db
    .insert(manualSpend)
    .values({ sourceId: body.sourceId, month, amountCents: Math.round(amountCents), note: body.note ?? null })
    .onConflictDoUpdate({
      target: [manualSpend.sourceId, manualSpend.month],
      set: {
        amountCents: sql`excluded.amount_cents`,
        note: sql`excluded.note`,
        updatedAt: sql`now()`,
      },
    });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const sourceId = url.searchParams.get("sourceId");
  const month = normalizeMonth(url.searchParams.get("month"));
  if (!sourceId || !month) {
    return Response.json({ error: "sourceId and month are required" }, { status: 400 });
  }
  await db.delete(manualSpend).where(and(eq(manualSpend.sourceId, sourceId), eq(manualSpend.month, month)));
  return Response.json({ ok: true });
}

function normalizeMonth(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-01` : null;
}
