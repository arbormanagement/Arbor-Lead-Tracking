import { z } from "zod";
import { getSession } from "@/lib/auth";
import { createPool, listPools } from "@/lib/pools";

export const runtime = "nodejs";

/**
 * Number pools (admin-gated): GET lists, POST creates. The work is in lib/pools.ts,
 * shared with the MCP pool tools.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ ok: true, pools: await listPools() });
}

const Body = z.object({
  key: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9_/-]*$/, "lowercase letters, digits, and - _ / only"),
  displayName: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  isDni: z.boolean().default(false),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid input" }, { status: 400 });
  }

  try {
    const row = await createPool(parsed.data);
    if (!row) return Response.json({ error: `Pool "${parsed.data.key}" already exists` }, { status: 409 });
    return Response.json({ ok: true, pool: row });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
