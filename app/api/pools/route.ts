import { asc } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { pools } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Number pools (admin-gated):
 *   GET  → list pools
 *   POST → create a pool (key is the stable identifier stored on numbers)
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db.select().from(pools).orderBy(asc(pools.key));
  return Response.json({ ok: true, pools: rows });
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
  const b = parsed.data;

  try {
    const [row] = await db
      .insert(pools)
      .values({ key: b.key, displayName: b.displayName, description: b.description ?? null, isDni: b.isDni })
      .onConflictDoNothing({ target: pools.key })
      .returning();
    if (!row) return Response.json({ error: `Pool "${b.key}" already exists` }, { status: 409 });
    return Response.json({ ok: true, pool: row });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
