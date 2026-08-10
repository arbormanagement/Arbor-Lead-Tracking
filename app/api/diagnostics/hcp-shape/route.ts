import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { probeHcpShape } from "@/lib/integrations/housecallpro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What do HousecallPro's list rows actually look like?
 *
 * `/jobs` returns no parseable `updated_at`, so its "incremental" sync degraded
 * into a full-history pull and the only way to find the real field names was
 * reading container logs. This answers that question directly.
 *
 * Deliberately NOT a log endpoint. Logs carry arbitrary content — customer phone
 * numbers and addresses inside error context, access tokens that ride in Graph
 * query strings — and putting that behind a bearer token creates a far bigger
 * exposure than the question is worth. This returns field NAMES, plus values only
 * for fields that parse as a date, because a timestamp identifies nobody.
 *
 * Separate from /api/diagnostics because it makes live upstream API calls; the
 * main snapshot should stay a pure database read.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const paths = ["/jobs", "/customers", "/estimates"] as const;
  const results: Record<string, unknown> = {};

  for (const p of paths) {
    try {
      results[p] = await probeHcpShape(p);
    } catch (err) {
      results[p] = { path: p, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // The actionable read: an endpoint with nothing windowable is one whose sync
  // cannot be incremental, and must rely on a server-side bound instead.
  const notWindowable = paths.filter((p) => {
    const r = results[p] as { windowable?: string[] } | undefined;
    return Array.isArray(r?.windowable) && r.windowable.length === 0;
  });

  return Response.json({
    ok: notWindowable.length === 0,
    note:
      notWindowable.length > 0
        ? `No usable incremental window on: ${notWindowable.join(", ")}. Those syncs depend on a server-side bound (see JOBS_MIN_WINDOW_DAYS). Check 'keys' below for the field the API actually uses.`
        : "Every endpoint exposes a date field the sync can window on.",
    endpoints: results,
  });
}
