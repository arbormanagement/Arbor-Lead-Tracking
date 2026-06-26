import { eq } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { provisionNumber } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Admin: provision (buy) or import a Twilio number into a pool. Session-gated.
 * Static numbers carry a source key (e.g. "gbp") so inbound calls resolve directly.
 */
const Body = z.object({
  pool: z.enum(["google", "facebook", "organic", "lsa", "direct", "print", "reserved"]),
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  importPhoneNumber: z.string().optional(),
  isStatic: z.boolean().default(false),
  staticSourceKey: z.string().optional(),
  location: z.enum(["edwardsville", "ofallon", "unknown"]).default("unknown"),
  friendlyName: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });
  const b = parsed.data;

  if (!b.areaCode && !b.importPhoneNumber) {
    return Response.json({ error: "areaCode or importPhoneNumber is required" }, { status: 400 });
  }

  try {
    const staticSourceId = b.isStatic && b.staticSourceKey ? await resolveSource(b.staticSourceKey) : null;
    const row = await provisionNumber({
      pool: b.pool,
      areaCode: b.areaCode,
      importPhoneNumber: b.importPhoneNumber,
      isStatic: b.isStatic,
      staticSourceId,
      location: b.location,
      friendlyName: b.friendlyName,
    });
    return Response.json({ ok: true, number: row });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

async function resolveSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: key }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}
