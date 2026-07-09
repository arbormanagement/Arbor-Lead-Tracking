import { inArray } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { attributions, conversionExports, facebookLeads, leads } from "@/lib/db/schema";
import { getSetting } from "@/lib/settings";
import { FB_INCLUDED_FORMS_KEY } from "@/lib/sync/facebook-leads";

export const runtime = "nodejs";

/**
 * Delete already-ingested Facebook lead-gen leads whose form is NOT in the selected
 * allowlist (i.e. forms you unchecked — recruiting, etc.). Admin-gated + destructive.
 * No-op if the allowlist is empty (empty = all forms allowed, so nothing is excluded).
 * Deletes dependents first (conversion_exports, attributions, facebook_leads) then leads.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const selected = await getSetting<string[]>(FB_INCLUDED_FORMS_KEY, []);
  if (!selected.length) {
    return Response.json({ ok: true, removed: 0, note: "No forms are excluded — nothing to remove." });
  }

  const rows = await db
    .select({ leadId: facebookLeads.leadId, formId: facebookLeads.fbFormId })
    .from(facebookLeads);
  const toRemove = rows
    .filter((r) => r.leadId && r.formId && !selected.includes(r.formId))
    .map((r) => r.leadId as string);

  if (!toRemove.length) return Response.json({ ok: true, removed: 0 });

  for (let i = 0; i < toRemove.length; i += 100) {
    const chunk = toRemove.slice(i, i + 100);
    await db.delete(conversionExports).where(inArray(conversionExports.leadId, chunk));
    await db.delete(attributions).where(inArray(attributions.leadId, chunk));
    await db.delete(facebookLeads).where(inArray(facebookLeads.leadId, chunk));
    await db.delete(leads).where(inArray(leads.id, chunk));
  }

  return Response.json({ ok: true, removed: toRemove.length });
}
