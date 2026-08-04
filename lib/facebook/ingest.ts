import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, facebookLeads, leads, sources } from "@/lib/db/schema";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import type { FbLeadDetail } from "@/lib/integrations/facebook";

/**
 * Insert a Facebook lead-gen submission as a lead + facebook_leads detail row.
 * Idempotent on fb_leadgen_id (Meta redelivers, and the webhook + poller can both
 * see the same lead). Returns true if a new lead was created, false if it already
 * existed. Shared by the webhook and the polling sync.
 */
export async function ingestFacebookLead(detail: FbLeadDetail): Promise<boolean> {
  const c = mapFbFields(detail.fieldData);
  const sourceId = await getOrCreateSource("facebook/paid");
  const campaignId = detail.campaignId ? await resolveCampaign(detail.campaignId, sourceId) : null;
  const occurredAt = detail.createdTime ? new Date(detail.createdTime) : new Date();

  // One transaction, and the uniquely-constrained facebook_leads row goes in
  // FIRST: whoever wins the fb_leadgen_id conflict creates the lead, the loser
  // no-ops. The old check-then-insert (lead created before the constraint row)
  // let a webhook/poller race leave an orphan duplicate lead.
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(facebookLeads)
      .values({
        fbLeadgenId: detail.leadgenId,
        fbFormId: detail.formId,
        fbAdId: detail.adId,
        fbCampaignId: detail.campaignId,
        fields: Object.fromEntries(detail.fieldData.map((f) => [f.name, f.values?.[0] ?? ""])),
        createdTime: occurredAt,
      })
      .onConflictDoNothing({ target: facebookLeads.fbLeadgenId })
      .returning({ id: facebookLeads.id });
    if (!claimed) return false; // already ingested (redelivery, or the other path won)

    const [lead] = await tx
      .insert(leads)
      .values({
        type: "facebook_leadgen",
        status: "new",
        isLead: true, // a submitted lead-gen form is inherently a lead
        name: c.name,
        phoneE164: normalizePhone(c.phone),
        emailLc: normalizeEmail(c.email),
        message: c.message,
        sourceId,
        medium: "paid",
        campaignId,
        occurredAt,
      })
      .returning({ id: leads.id });

    await tx.update(facebookLeads).set({ leadId: lead.id }).where(eq(facebookLeads.id, claimed.id));
    return true;
  });
}

function mapFbFields(fieldData: Array<{ name: string; values: string[] }>) {
  const get = (needles: string[]) => {
    for (const f of fieldData) {
      const n = f.name.toLowerCase();
      if (needles.some((x) => n.includes(x)) && f.values?.[0]) return f.values[0];
    }
    return null;
  };
  const first = get(["first_name", "first name"]);
  const last = get(["last_name", "last name"]);
  const stitched = [first, last].filter(Boolean).join(" ") || null;
  return {
    name: get(["full_name", "full name", "name"]) ?? stitched,
    email: get(["email"]),
    phone: get(["phone", "telefono", "mobile"]),
    message: get(["message", "comment", "detail", "describe", "project"]),
  };
}

async function getOrCreateSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: key, platform: "facebook" }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}

async function resolveCampaign(externalId: string, sourceId: string | null): Promise<string | null> {
  await db
    .insert(campaigns)
    .values({ platform: "facebook", externalCampaignId: externalId, sourceId })
    .onConflictDoNothing({ target: [campaigns.platform, campaigns.externalCampaignId] });
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.platform, "facebook"), eq(campaigns.externalCampaignId, externalId)))
    .limit(1);
  return c?.id ?? null;
}
