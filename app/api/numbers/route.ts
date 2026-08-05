import { eq } from "drizzle-orm";
import { z } from "zod";
import { authorizeAdmin, unauthorized, forbidden } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import { pools, sources, trackingNumbers } from "@/lib/db/schema";
import { provisionNumber } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Admin: provision (buy) or import a Twilio number into a pool. Session-gated.
 * Static numbers carry a source key (e.g. "gbp") so inbound calls resolve directly.
 */
const Body = z.object({
  pool: z.string().min(2).max(40),
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  purchasePhoneNumber: z.string().optional(),
  tollFree: z.boolean().default(false),
  importPhoneNumber: z.string().optional(),
  isStatic: z.boolean().default(false),
  staticSourceKey: z.string().optional(),
  location: z.enum(["edwardsville", "ofallon", "unknown"]).default("unknown"),
  friendlyName: z.string().max(120).optional(),
  forwardDestination: z.string().max(20).optional(),
  whisperMessage: z.string().max(300).optional(),
  recordCalls: z.boolean().default(true),
  greetingMessage: z.string().max(300).optional(),
  greetingEnabled: z.boolean().default(true),
});

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });
  const b = parsed.data;

  // Importing an already-owned number is free and reversible; buying one costs
  // money every month until somebody notices. A machine token may do the former
  // only — purchases stay behind an interactive login.
  if (auth.via === "token" && (b.areaCode || b.purchasePhoneNumber || b.tollFree)) {
    return forbidden(
      "token auth may only import an already-owned number (importPhoneNumber); purchasing requires an admin session",
    );
  }

  if (!b.areaCode && !b.importPhoneNumber && !b.purchasePhoneNumber && !b.tollFree) {
    return Response.json(
      { error: "Pick a number (purchasePhoneNumber), an area code, toll-free, or import an owned number" },
      { status: 400 },
    );
  }

  const [poolRow] = await db.select({ key: pools.key }).from(pools).where(eq(pools.key, b.pool)).limit(1);
  if (!poolRow) return Response.json({ error: `Unknown pool "${b.pool}"` }, { status: 400 });

  try {
    const staticSourceId = b.isStatic && b.staticSourceKey ? await resolveSource(b.staticSourceKey) : null;
    const row = await provisionNumber({
      pool: b.pool,
      areaCode: b.areaCode,
      purchasePhoneNumber: b.purchasePhoneNumber,
      tollFree: b.tollFree,
      importPhoneNumber: b.importPhoneNumber,
      isStatic: b.isStatic,
      staticSourceId,
      location: b.location,
      friendlyName: b.friendlyName,
      forwardDestination: b.forwardDestination || null,
      whisperMessage: b.whisperMessage || null,
      recordCalls: b.recordCalls,
      greetingMessage: b.greetingMessage || null,
      greetingEnabled: b.greetingEnabled,
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

/**
 * List tracking numbers. Read-only, and the counterpart the token flow needs:
 * PATCH /api/numbers/[id] takes a row id, and without this there is no way for a
 * machine caller to discover one. Also the verification step after a cutover
 * import — confirming a number actually landed with the right source and
 * forward destination.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const rows = await db
    .select({
      id: trackingNumbers.id,
      phoneNumber: trackingNumbers.phoneNumber,
      friendlyName: trackingNumbers.friendlyName,
      pool: trackingNumbers.pool,
      status: trackingNumbers.status,
      isStatic: trackingNumbers.isStatic,
      staticSourceId: trackingNumbers.staticSourceId,
      location: trackingNumbers.location,
      forwardDestination: trackingNumbers.forwardDestination,
      recordCalls: trackingNumbers.recordCalls,
      twilioSid: trackingNumbers.twilioSid,
    })
    .from(trackingNumbers)
    .orderBy(trackingNumbers.createdAt);

  return Response.json({ ok: true, numbers: rows });
}
