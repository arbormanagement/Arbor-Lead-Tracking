import { getSession } from "@/lib/auth";
import { runLeadCleanup } from "@/lib/leads/cleanup";

export const runtime = "nodejs";

/**
 * Delete leads already captured against a campaign now flagged as
 * non-customer-acquisition (recruiting). Admin-gated + destructive.
 *
 * Flagging a campaign keeps its leads out of every ROI number immediately; this is
 * the separate, explicit step that also clears them out of the inbox. The work is
 * lib/leads/cleanup.ts, shared with the MCP `arbor_cleanup_inquiries` tool. Ad spend is
 * deliberately kept — it stays as history, just uncounted.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await runLeadCleanup("excluded_campaigns", true);
  return Response.json({ ok: true, removed: result.removed, note: result.note });
}
