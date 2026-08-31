import { z } from "zod";
import { getSession } from "@/lib/auth";
import { probeCredential } from "@/lib/credentials/probe";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Lightweight connectivity probe per platform using the resolved (DB-or-env)
 * credentials, so Justin gets immediate feedback after entering keys. Each probe is
 * the cheapest authenticated call that proves the credential works.
 */
const Body = z.object({ platform: z.string() });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  try {
    const ok = await probeCredential(parsed.data.platform);
    return Response.json(ok);
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
