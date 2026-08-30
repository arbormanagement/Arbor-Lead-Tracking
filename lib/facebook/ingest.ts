import { displayNameFor } from "@/lib/sources/naming";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, facebookLeads, leads, sources } from "@/lib/db/schema";
import { preview, recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { createHcpEstimateForFbLead, fbHcpWriteEnabled } from "@/lib/facebook/hcp-write";
import type { FbLeadDetail } from "@/lib/integrations/facebook";

/** Outcome of an ingest attempt — `excluded` means the ad's campaign is flagged as
 *  non-customer-acquisition (recruiting), so the submission is deliberately dropped.
 *  `deferred` means we could not determine the campaign and refuse to guess; the
 *  submission is left un-ingested for a later run to retry. */
export type IngestResult = "created" | "duplicate" | "excluded" | "deferred";

/**
 * Insert a Facebook lead-gen submission as a lead + facebook_leads detail row.
 * Idempotent on fb_leadgen_id (Meta redelivers, and the webhook + poller can both
 * see the same lead). Shared by the webhook and the polling sync.
 */
export async function ingestFacebookLead(detail: FbLeadDetail): Promise<IngestResult> {
  const c = mapFbFields(detail.fieldData);
  const sourceId = await getOrCreateSource("facebook/paid");
  // An unresolved campaign is NOT the same as no campaign. Ingest is idempotent on
  // fb_leadgen_id, so admitting a lead whose campaign we merely failed to look up
  // is irreversible in practice — the next poll sees a duplicate and never
  // re-evaluates it. Defer instead and let a later run (the poller re-fetches on a
  // rolling window) decide once Graph answers.
  if (detail.campaignLookupFailed) {
    console.warn(`[fb ingest] deferring ${detail.leadgenId} — campaign for ad ${detail.adId} unresolved`);
    return "deferred";
  }
  const campaign = detail.campaignId ? await resolveCampaign(detail.campaignId, sourceId) : null;
  // Recruiting campaigns don't produce customers. Drop the submission before it
  // becomes a lead rather than filtering it downstream — an applicant in the inbox
  // is noise, and one in the ROI denominator understates the channel that paid.
  if (campaign?.excluded) return "excluded";
  const campaignId = campaign?.id ?? null;
  const occurredAt = detail.createdTime ? new Date(detail.createdTime) : new Date();

  // One transaction, and the uniquely-constrained facebook_leads row goes in
  // FIRST: whoever wins the fb_leadgen_id conflict creates the lead, the loser
  // no-ops. The old check-then-insert (lead created before the constraint row)
  // let a webhook/poller race leave an orphan duplicate lead.
  const created = await db.transaction(async (tx) => {
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
    if (!claimed) return null; // already ingested (redelivery, or the other path won)

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
        selfReportedSource: c.selfReportedSource,
        sourceId,
        medium: "paid",
        campaignId,
        occurredAt,
      })
      .returning({ id: leads.id });

    await tx.update(facebookLeads).set({ leadId: lead.id }).where(eq(facebookLeads.id, claimed.id));
    return { leadId: lead.id, facebookLeadId: claimed.id };
  });

  if (!created) return "duplicate";

  // Threading runs AFTER the transaction commits, deliberately: the idempotency
  // claim above is the thing that must not be held open, and a threading failure
  // is recoverable (thread-backfill picks it up) while a lost lead is not.
  try {
    const thread = await upsertThread(
      { phone: c.phone, email: c.email, name: c.name, at: occurredAt },
      { endpointKey: detail.formId ? `fb:${detail.formId}` : "fb:leadgen", sourceId },
    );
    if (thread) {
      await db
        .update(leads)
        .set({ conversationId: thread.conversationId, contactId: thread.contactId })
        .where(eq(leads.id, created.leadId));
      await db
        .update(facebookLeads)
        .set({ conversationId: thread.conversationId })
        .where(eq(facebookLeads.id, created.facebookLeadId));
      await recordThreadActivity(thread.conversationId, {
        channel: "facebook",
        direction: "inbound",
        preview: preview(c.message) ?? "Facebook lead form submitted",
        occurredAt,
      });
    }
  } catch (err) {
    console.error("[facebook] threading failed (lead recorded)", err);
  }

  // The merge's slice 5: turn the lead into an HCP customer + estimate, the job
  // Arbor-Automations used to do — but ONLY for a lead this function CREATED,
  // so excluded (recruiting), deferred, and duplicate submissions never reach
  // HCP. Gated off by default; see lib/facebook/hcp-write.ts for why.
  if (fbHcpWriteEnabled()) {
    await createHcpEstimateForFbLead(detail);
  }

  return "created";
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
    // Meta lead forms can carry a custom "how did you hear about us" question, and
    // it was being discarded the same way the web form's was. Matching is substring
    // here (Meta's own field naming), so the needles stay specific enough that a
    // hidden tracking field cannot pass as the customer's own answer.
    selfReportedSource: get(["hear_about", "hear about", "heard_about", "heard about", "how_did_you_find", "referral_source", "referred_by"]),
  };
}

async function getOrCreateSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: displayNameFor(key), platform: "facebook" }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}

async function resolveCampaign(
  externalId: string,
  sourceId: string | null,
): Promise<{ id: string; excluded: boolean } | null> {
  await db
    .insert(campaigns)
    .values({ platform: "facebook", externalCampaignId: externalId, sourceId })
    .onConflictDoNothing({ target: [campaigns.platform, campaigns.externalCampaignId] });
  const [c] = await db
    .select({ id: campaigns.id, excluded: campaigns.excluded })
    .from(campaigns)
    .where(and(eq(campaigns.platform, "facebook"), eq(campaigns.externalCampaignId, externalId)))
    .limit(1);
  return c ?? null;
}
