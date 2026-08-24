import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { LEAD_STATUSES, LEAD_TYPES, searchLeads } from "@/lib/queries/leads";

export const runtime = "nodejs";

/**
 * List leads. Read-only, admin-gated (session or machine token).
 *
 * This exists because nothing could read a lead back. The dashboard renders the
 * table server-side, so verifying "did that call land with the right source?" or
 * "did the form submission carry its gclid?" meant either opening the UI or
 * inferring it from webhook status codes — and DELETE /api/leads/[id] is
 * unusable without a way to discover an id in the first place.
 *
 * The query lives in lib/queries/leads.ts, shared with the MCP `list_leads` tool.
 * Filters are the ones actually needed to answer a support question: free-text
 * over name/email/phone/message, plus type/status/spam.
 */
const Query = z.object({
  q: z.string().max(200).optional(),
  type: z.enum(LEAD_TYPES).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  isSpam: z.enum(["true", "false"]).optional(),
  hasClickId: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "invalid query" }, { status: 400 });
  const p = parsed.data;

  const rows = await searchLeads({
    q: p.q,
    type: p.type,
    status: p.status,
    isSpam: p.isSpam === undefined ? undefined : p.isSpam === "true",
    hasClickId: p.hasClickId === undefined ? undefined : p.hasClickId === "true",
    limit: p.limit,
  });

  return Response.json({ ok: true, count: rows.length, leads: rows });
}
