import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { pools, trackingNumbers } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Per-pool admin: edit display metadata, or delete an unused pool. The `key` is the
 * stable identifier stored on tracking_numbers.pool, so it is immutable here —
 * editing changes the display name / description / DNI flag only.
 */
const Patch = z.object({
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  isDni: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { key } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  try {
    const [row] = await db
      .update(pools)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(pools.key, key))
      .returning();
    if (!row) return Response.json({ error: "pool not found" }, { status: 404 });
    return Response.json({ ok: true, pool: row });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { key } = await params;
  if (key === "reserved") {
    return Response.json({ error: "The reserved pool is the default and can’t be deleted" }, { status: 400 });
  }

  try {
    // Block deletion while numbers still reference the pool — reassign them first.
    const [{ inUse }] = await db
      .select({ inUse: sql<number>`count(*)::int` })
      .from(trackingNumbers)
      .where(eq(trackingNumbers.pool, key));
    if (inUse > 0) {
      return Response.json(
        { error: `${inUse} number(s) still use "${key}" — reassign them to another pool first` },
        { status: 409 },
      );
    }
    const deleted = await db.delete(pools).where(eq(pools.key, key)).returning();
    if (!deleted.length) return Response.json({ error: "pool not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
