import { z } from "zod";
import { getSession } from "@/lib/auth";
import { deleteManualSpend, setManualSpend } from "@/lib/spend/manual";

export const runtime = "nodejs";

/**
 * Manual monthly spend for channels without an API sync (LSA, GBP, print, …).
 * POST upserts one (source, month) row; DELETE removes it. Amounts in integer
 * cents; `month` accepts "YYYY-MM" and is stored as the first of the month.
 * The next attribution run folds these into roi_daily (spread across the month).
 *
 * The work is in lib/spend/manual.ts, shared with the MCP manual-spend tools.
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
    return Response.json(
      { error: "sourceId, month (YYYY-MM), and a non-negative integer amountCents are required" },
      { status: 400 },
    );
  }

  const result = await setManualSpend(parsed.data);
  if (!result.ok) {
    return result.reason === "unknown_source"
      ? Response.json({ error: `unknown sourceId "${parsed.data.sourceId}"` }, { status: 404 })
      : Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const sourceId = url.searchParams.get("sourceId");
  const month = url.searchParams.get("month");
  if (!sourceId || !month) {
    return Response.json({ error: "sourceId and month are required" }, { status: 400 });
  }

  const result = await deleteManualSpend(sourceId, month);
  if (!result.ok) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
  return Response.json({ ok: true });
}
