import { getSession } from "@/lib/auth";
import { runLeadCleanup } from "@/lib/leads/cleanup";

export const runtime = "nodejs";

/**
 * Delete already-ingested Facebook lead-gen leads whose form is NOT in the selected
 * allowlist (forms you unchecked — recruiting, etc.). Admin-gated + destructive.
 * No-op when the allowlist is empty, since empty means all forms are allowed.
 *
 * The work is lib/leads/cleanup.ts, shared with the MCP `arbor_cleanup_inquiries` tool.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await runLeadCleanup("unselected_facebook_forms", true);
  return Response.json({ ok: true, removed: result.removed, note: result.note });
}
