import { getSession } from "@/lib/auth";
import { facebook } from "@/lib/integrations/facebook";

export const runtime = "nodejs";

/**
 * List the ad account's pixels/datasets so Settings → Integrations can offer the
 * Conversions API id as a pick-list. Admin-gated; returns ids + names only (no
 * secrets). Reads the saved Facebook access token — so the token must be saved
 * first. Returns 200 with { ok:false, error } on config/token problems so the UI
 * can show a friendly message.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const pixels = await facebook.listPixels();
    return Response.json({ ok: true, pixels });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
