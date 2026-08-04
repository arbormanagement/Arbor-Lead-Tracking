import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { manualSpend, sources } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Manual monthly spend for channels without an API sync (LSA, GBP, print, …).
 * POST upserts one (source, month) row; DELETE removes it. Amounts in integer
 * cents; `month` accepts "YYYY-MM" and is stored as the first of the month.
 * The next attribution run folds these into roi_daily (spread across the month).
 */
const Body = z.object({
  sourceId: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "month must be YYYY-MM"),
  amountCents: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "sourceId, month (YYYY-MM), and a non-negative integer amountCents are required" }, { status: 400 });
  }
  const b = parsed.data;
  const month = normalizeMonth(b.month)!;

  // Check the source exists up front — otherwise an unknown id surfaces as a raw FK 500.
  const [source] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, b.sourceId)).limit(1);
  if (!source) return Response.json({ error: `unknown sourceId "${b.sourceId}"` }, { status: 404 });

  await db
    .insert(manualSpend)
    .values({ sourceId: b.sourceId, month, amountCents: b.amountCents, note: b.note ?? null })
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
