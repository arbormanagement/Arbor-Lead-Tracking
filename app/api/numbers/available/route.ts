import { z } from "zod";
import { getSession } from "@/lib/auth";
import { searchAvailableNumbers } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Admin: list numbers available to buy from Twilio so the operator picks the
 * actual digits (CallRail-style), by area code (+ optional `contains` pattern)
 * or toll-free.
 */
const Query = z.object({
  areaCode: z.string().regex(/^\d{3}$/).optional(),
  contains: z.string().max(10).optional(),
  tollFree: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const parsed = Query.safeParse({
    areaCode: sp.get("areaCode") ?? undefined,
    contains: sp.get("contains") ?? undefined,
    tollFree: sp.get("tollFree") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const { areaCode, contains, tollFree } = parsed.data;
  if (!tollFree && !areaCode) {
    return Response.json({ error: "areaCode is required for local numbers" }, { status: 400 });
  }

  try {
    const numbers = await searchAvailableNumbers({ areaCode, contains, tollFree });
    return Response.json({ ok: true, numbers });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
