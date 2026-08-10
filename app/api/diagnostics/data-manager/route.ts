import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { probeDataManager } from "@/lib/integrations/data-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Can this account send offline conversions through the Data Manager API, and how
 * far back may an event be dated?
 *
 * Google closed ConversionUploadService.UploadClickConversions to new integrations,
 * so the existing exporter cannot work at all — every upload is rejected on policy,
 * not on data. Before porting to the replacement there are two unknowns that decide
 * the design, and guessing either would mean building the wrong thing:
 *
 *  1. SCOPE. Data Manager requires .../auth/datamanager. The stored refresh token
 *     was minted for .../auth/adwords, so it may simply not be authorized — which
 *     would make re-consent, not code, the first step.
 *  2. EVENT AGE. The docs mention a 72-hour bound on eventTimestamp. If that is a
 *     hard limit it defeats the entire use case: HCP estimates are approved weeks
 *     after the lead arrives, which is exactly why the export window is 90 days.
 *
 * `validateOnly: true` answers both against the real account without recording a
 * single conversion, so this is safe to run at any time.
 *
 * Runs server-side deliberately: the Google credentials stay on the host rather
 * than being pulled somewhere else to run the same check by hand.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  try {
    return Response.json(await probeDataManager());
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
