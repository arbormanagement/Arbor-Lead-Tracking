import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { setRoutingConfig } from "@/lib/routing";

export const runtime = "nodejs";

/**
 * Save routing settings (admin-gated): the account-wide default call-forward
 * number, and where inbound texts are relayed. Each field is optional — send only
 * the one being changed; empty clears it.
 *
 * The work is `setRoutingConfig`, shared with the MCP `arbor_set_routing` tool so
 * the two cannot diverge on normalization or on re-pointing the Twilio-side voice
 * fallback.
 */
const Body = z.object({
  defaultForward: z.string().optional(),
  smsForward: z.string().optional(),
});

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const result = await setRoutingConfig(parsed.data);
  if (!result.ok) {
    const what = result.field === "smsForward" ? "mobile number" : "phone number";
    return Response.json({ error: `Enter a valid ${what} (e.g. +16188368004)` }, { status: 400 });
  }
  return Response.json(result);
}
