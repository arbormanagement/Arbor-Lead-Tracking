import { z } from "zod";
import { getSession } from "@/lib/auth";
import { deletePool, updatePool } from "@/lib/pools";

export const runtime = "nodejs";

/**
 * Per-pool admin: edit display metadata, or delete an unused pool. The `key` is the
 * stable identifier stored on tracking_numbers.pool, so it is immutable here —
 * editing changes the display name / description / DNI flag only.
 *
 * The work is in lib/pools.ts, shared with the MCP pool tools, including the two
 * guards that stop a delete stranding numbers.
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
    const row = await updatePool(key, parsed.data);
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
  try {
    const result = await deletePool(key);
    if (result.ok) return Response.json({ ok: true });
    if (result.reason === "reserved") {
      return Response.json({ error: "The reserved pool is the default and can’t be deleted" }, { status: 400 });
    }
    if (result.reason === "in_use") {
      return Response.json(
        { error: `${result.numbers} number(s) still use "${key}" — reassign them to another pool first` },
        { status: 409 },
      );
    }
    return Response.json({ error: "pool not found" }, { status: 404 });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
