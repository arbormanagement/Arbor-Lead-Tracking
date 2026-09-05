import { eq, sql } from "drizzle-orm";
import { authorizeAdmin, unauthorized, forbidden } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import {
  attributions,
  calls,
  conversionExports,
  facebookLeads,
  formSubmissions,
  hcpEstimates,
  leads,
} from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * Delete a lead and the rows that hang off it.
 *
 * Deleting is irreversible, so this refuses anything that looks like real
 * business data rather than a test artifact:
 *
 *   • a lead with a CALL — the call is a real telephony event with a recording
 *     and a Twilio SID. Deleting the lead would either destroy that or orphan
 *     it, and neither is something an automation should decide.
 *   • a lead already linked into HousecallPro (customer/job/estimate) — it has
 *     been matched to real work.
 *   • a lead already EXPORTED as a conversion — Google/Meta have it; removing
 *     our record makes the export unauditable and un-reversible.
 *
 * What that leaves is exactly the intended use: junk and test web-form rows.
 * `force: true` overrides the HCP/export guards for an interactive admin
 * session, but never the call guard and never for a machine token.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const { id } = await params;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true" && auth.via === "session";

  const [lead] = await db
    .select({
      id: leads.id,
      type: leads.type,
      name: leads.name,
      hcpCustomerId: leads.hcpCustomerId,
      estimates: sql<number>`(select count(*)::int from ${hcpEstimates} e where e.lead_id = ${leads.id})`,
    })
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);

  if (!lead) return Response.json({ error: "no such lead" }, { status: 404 });

  const [call] = await db.select({ id: calls.id }).from(calls).where(eq(calls.leadId, id)).limit(1);
  if (call) {
    return forbidden(
      "this lead has a call attached — delete refuses to destroy or orphan a real telephony record. Mark it spam instead.",
    );
  }

  const linkedToHcp = !!(lead.hcpCustomerId || lead.estimates > 0);
  if (linkedToHcp && !force) {
    return forbidden(
      "this lead is linked to HousecallPro (customer/job/estimate) — it has been matched to real work. Re-send with ?force=true from an admin session to override.",
    );
  }

  const [exported] = await db
    .select({ id: conversionExports.id })
    .from(conversionExports)
    .where(eq(conversionExports.leadId, id))
    .limit(1);
  if (exported && !force) {
    return forbidden(
      "this lead has already been exported as a conversion — Google/Meta hold it and deleting our record makes that unauditable. Re-send with ?force=true from an admin session to override.",
    );
  }

  // Children first: attributions and conversion_exports are NOT NULL on lead_id,
  // so they must go before the lead itself rather than being nulled out.
  //
  // All five statements are one transaction. Run loose, a failure partway through
  // leaves a lead stripped of its attributions and export record but still present
  // — and the next attribution rebuild happily re-derives a last-touch for it, so
  // the half-deleted state looks repaired while the export history stays gone.
  await db.transaction(async (tx) => {
    await tx.delete(attributions).where(eq(attributions.leadId, id));
    await tx.delete(conversionExports).where(eq(conversionExports.leadId, id));
    await tx.delete(formSubmissions).where(eq(formSubmissions.leadId, id));
    await tx.update(facebookLeads).set({ leadId: null }).where(eq(facebookLeads.leadId, id));
    await tx.delete(leads).where(eq(leads.id, id));
  });

  return Response.json({
    ok: true,
    deleted: { id: lead.id, type: lead.type, name: lead.name },
    forced: force,
  });
}
