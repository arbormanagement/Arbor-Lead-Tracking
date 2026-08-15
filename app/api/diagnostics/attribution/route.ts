import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { attributionBreakdown } from "@/lib/diagnostics/attribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Why is an estimate unattributed? See lib/diagnostics/attribution.ts for the
 * breakdown itself — it lives there rather than inline so it can be exercised
 * directly against a database, which a route guarded by `cookies()` cannot be.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const days = Number(new URL(req.url).searchParams.get("days") ?? 90);
  return Response.json(await attributionBreakdown(days));
}
