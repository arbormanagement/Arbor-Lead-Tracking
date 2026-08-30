import { displayNameFor } from "@/lib/sources/naming";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { sources } from "@/lib/db/schema";
import { releaseNumber, setNumberStatus, updateNumber } from "@/lib/twilio/numbers";
import { LOCATIONS } from "@/lib/locations";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Per-number lifecycle (admin-gated):
 *  PATCH  → edit pool / static / source / location, or enable/disable
 *  DELETE → release the number on Twilio (relinquish) and disable the row
 *
 * PATCH also accepts the machine token (lib/admin-auth.ts) so automation can fix
 * a number's routing — notably forwardDestination during the CallRail cutover.
 * Every PATCH field is reversible.
 *
 * DELETE stays session-only, deliberately: releasing a number on Twilio gives it
 * up for good, and a published tracking number cannot be got back. Same reasoning
 * as the purchase guard on POST /api/numbers — the token may change a number, not
 * acquire or destroy one.
 */
const Patch = z.object({
  pool: z.string().min(2).max(40).optional(),
  isStatic: z.boolean().optional(),
  staticSourceKey: z.string().optional(),
  location: z.enum(LOCATIONS).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  friendlyName: z.string().max(120).optional(),
  forwardDestination: z.string().max(20).nullable().optional(),
  whisperMessage: z.string().max(300).nullable().optional(),
  recordCalls: z.boolean().optional(),
  greetingMessage: z.string().max(300).nullable().optional(),
  greetingEnabled: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });
  const b = parsed.data;

  try {
    if (b.status) await setNumberStatus(id, b.status);

    const hasMeta =
      b.pool !== undefined || b.isStatic !== undefined || b.location !== undefined ||
      b.staticSourceKey !== undefined || b.friendlyName !== undefined ||
      b.forwardDestination !== undefined || b.whisperMessage !== undefined || b.recordCalls !== undefined ||
      b.greetingMessage !== undefined || b.greetingEnabled !== undefined;
    if (hasMeta) {
      const staticSourceId =
        b.staticSourceKey !== undefined ? await resolveSource(b.staticSourceKey) : undefined;
      const row = await updateNumber(id, {
        pool: b.pool,
        isStatic: b.isStatic,
        location: b.location,
        friendlyName: b.friendlyName,
        forwardDestination: b.forwardDestination,
        whisperMessage: b.whisperMessage,
        recordCalls: b.recordCalls,
        greetingMessage: b.greetingMessage,
        greetingEnabled: b.greetingEnabled,
        ...(staticSourceId !== undefined ? { staticSourceId } : {}),
      });
      return Response.json({ ok: true, number: row });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    const row = await releaseNumber(id);
    return Response.json({ ok: true, number: row });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

async function resolveSource(key: string): Promise<string | null> {
  if (!key) return null;
  await db.insert(sources).values({ key, displayName: displayNameFor(key) }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}
