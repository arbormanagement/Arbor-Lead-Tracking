import { z } from "zod";
import { getSession } from "@/lib/auth";
import { setTrackingOrigins } from "@/lib/origin";

export const runtime = "nodejs";

/**
 * Save the tracking-origin allowlist (admin-gated) — the sites whose pages may
 * POST to /api/track and /api/dni/assign. Comma- or newline-separated; empty
 * restores the built-in arbor-mgmt.com defaults.
 *
 * The work is `setTrackingOrigins`, shared with the MCP
 * `arbor_set_tracking_origins` tool.
 */
const Body = z.object({ allowedOrigins: z.string().max(4000) });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const result = await setTrackingOrigins(parsed.data.allowedOrigins);
  if (!result.ok) return Response.json({ error: `Not a valid origin: "${result.invalid}"` }, { status: 400 });
  return Response.json({ ok: true, allowedOrigins: result.allowedOrigins, defaults: result.defaults });
}
