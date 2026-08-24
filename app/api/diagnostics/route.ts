import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { diagnosticsReport } from "@/lib/diagnostics/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only operational snapshot. The checks live in lib/diagnostics/report.ts —
 * moved there (same pattern as /api/diagnostics/attribution) so the MCP
 * `diagnostics` tool and this route run one implementation.
 *
 * Admin-gated the same way /api/numbers/pool is: session cookie, or
 * `Authorization: Bearer $ADMIN_API_TOKEN`.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const { httpStatus, report } = await diagnosticsReport();
  return Response.json(report, { status: httpStatus });
}
