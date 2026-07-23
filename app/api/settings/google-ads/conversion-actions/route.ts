import { getSession } from "@/lib/auth";
import { googleAds } from "@/lib/integrations/google-ads";

export const runtime = "nodejs";

/**
 * List the account's import (UPLOAD_CLICKS) conversion actions so Settings →
 * Integrations can offer the OCI targets as a pick-list (same UX as the Facebook
 * pixel finder). Admin-gated; ids + names only. Reads the saved Google Ads
 * credentials — so those must be saved first. Returns 200 with { ok:false, error }
 * on config/credential problems so the UI can show a friendly message.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const actions = await googleAds.listConversionActions();
    return Response.json({ ok: true, actions });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
