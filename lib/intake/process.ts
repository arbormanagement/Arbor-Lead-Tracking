/**
 * Turn an inbound lead (Retell voice, website form, Facebook lead form) into an
 * HCP customer + estimate — the successor to Arbor-Automations' `processWebhook`
 * (the merge's slice 2), with the one addition the merge exists for: the created
 * estimate is LINKED to the lead/contact that produced it, at creation, instead
 * of being fuzzy-matched back hours later by `matchLeadsToEstimates`.
 *
 * Runs in the background after the webhook has already answered (Retell is
 * waiting on the phone), so every outcome lands on the `automation_intakes` row
 * and failures raise an alert email — a background throw would otherwise vanish.
 */
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { automationIntakes, contacts, conversations, hcpCustomers, hcpEstimates, leads } from "@/lib/db/schema";
import { sendEmail, sendFailureAlert, escapeHtml } from "@/lib/email/sendgrid";
import { createCustomer, createEstimate, findCustomerByPhone } from "@/lib/integrations/housecallpro-write";
import { resolveContact } from "@/lib/contacts/resolve";
import { normalizePhone as toE164 } from "@/lib/phone";

export type IntakeSource = "retell" | "website" | "facebook";

export interface IntakeData {
  firstName: string;
  lastName: string;
  email: string;
  /** Bare 10 digits — the shape HCP stores and the webhooks validate. */
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  serviceNeeded: string;
}

const SOURCE_LABELS: Record<IntakeSource, string> = {
  retell: "Retell Voice Estimate",
  website: "Website Lead",
  facebook: "Facebook Lead Ads",
};

/**
 * Record the intake. Returns null when a Facebook submission with this
 * leadgen id was already claimed — the unique index arbitrates the webhook and
 * the poller seeing the same lead, so exactly one caller processes it.
 */
export async function createIntake(
  source: IntakeSource,
  data: IntakeData,
  opts: { fbLeadgenId?: string } = {},
): Promise<typeof automationIntakes.$inferSelect | null> {
  const [row] = await db
    .insert(automationIntakes)
    .values({
      source,
      fbLeadgenId: opts.fbLeadgenId ?? null,
      firstName: data.firstName || null,
      lastName: data.lastName || null,
      email: data.email || null,
      phoneE164: toE164(data.phone),
      street: data.street || null,
      city: data.city || null,
      state: data.state || null,
      zip: data.zip || null,
      serviceNeeded: data.serviceNeeded || null,
    })
    .onConflictDoNothing({ target: automationIntakes.fbLeadgenId })
    .returning();
  return row ?? null;
}

/** Mark an intake failed before processing even starts (e.g. unusable phone). */
export async function updateIntakeFailed(id: string, errorMessage: string) {
  await updateIntake(id, { status: "failed", errorMessage });
}

async function updateIntake(id: string, set: Partial<typeof automationIntakes.$inferInsert>) {
  await db
    .update(automationIntakes)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(automationIntakes.id, id));
}

/**
 * Best-effort estimate → lead link. The enquiry that produced this estimate is
 * usually minutes old: the call came through `/api/twilio/voice`, or the form
 * through `track.js`, so a contact and an open lead already exist. Claiming it
 * here makes attribution deterministic; `matchLeadsToEstimates` remains the
 * hourly repair path for anything this misses, so every failure mode degrades
 * to today's behavior. Never throws.
 */
async function linkEstimateToLead(
  intakeId: string,
  data: IntakeData,
  hcpCustomerId: string,
  hcpEstimateId: string,
): Promise<string | null> {
  try {
    const contact = await resolveContact({
      phone: data.phone,
      email: data.email || null,
      name: [data.firstName, data.lastName].filter(Boolean).join(" ") || null,
    });
    if (!contact) return null;

    // Adopt the HCP identity on the contact spine (fills a gap only — a contact
    // already linked keeps its link; the link-hcp sweep owns corrections).
    // contacts.hcp_customer_id references hcp_customers.id (our ULID), not the
    // HCP-side id, so resolve through the mirror; if the sync hasn't seen this
    // customer yet, skip silently — the sweep catches it after the next pull.
    if (!contact.hcpCustomerId) {
      const [mirror] = await db
        .select({ id: hcpCustomers.id })
        .from(hcpCustomers)
        .where(eq(hcpCustomers.hcpCustomerId, hcpCustomerId))
        .limit(1);
      if (mirror) {
        await db
          .update(contacts)
          .set({ hcpCustomerId: mirror.id, updatedAt: new Date() })
          .where(and(eq(contacts.id, contact.id), isNull(contacts.hcpCustomerId)));
      }
    }

    // The estimate row itself won't exist in the mirror until the next sync;
    // leads.hcp_estimate_id references hcp_estimates.id, so the claim can only
    // be written once the sync has ingested it — UNLESS it's already there.
    const [estimateRow] = await db
      .select({ id: hcpEstimates.id })
      .from(hcpEstimates)
      .where(eq(hcpEstimates.hcpEstimateId, hcpEstimateId))
      .limit(1);

    const [thread] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.contactId, contact.id))
      .limit(1);
    if (!thread) return null;

    const [openLead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.conversationId, thread.id),
          isNull(leads.hcpEstimateId),
          // Bound the claim to a recent enquiry: this webhook fires minutes
          // after the lead, and claiming a weeks-old open lead would steal the
          // slot matchLeadsToEstimates might assign more carefully.
          gte(leads.occurredAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(desc(leads.occurredAt))
      .limit(1);
    if (!openLead) return null;

    if (estimateRow) {
      await db
        .update(leads)
        .set({ hcpEstimateId: estimateRow.id, updatedAt: new Date() })
        .where(and(eq(leads.id, openLead.id), isNull(leads.hcpEstimateId)));
      return openLead.id;
    }

    // Estimate not synced yet (the common case — it was created seconds ago).
    // Record the intended claim on the intake row; the attribution sweep's
    // normal matching will land it, now guaranteed to find the lead open.
    await updateIntake(intakeId, { leadId: openLead.id });
    return openLead.id;
  } catch (err) {
    console.log(`[intake] lead linking failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export async function processIntake(intakeId: string, data: IntakeData, source: IntakeSource): Promise<void> {
  await updateIntake(intakeId, { status: "processing" });

  try {
    const existing = await findCustomerByPhone(data.phone);

    let customerId: string;
    if (existing) {
      console.log(`[intake] existing customer found via ${existing.foundVia}: ${existing.id}`);
      customerId = existing.id;
      await updateIntake(intakeId, { customerFound: true, hcpCustomerId: customerId });
    } else {
      const created = await createCustomer({
        first_name: data.firstName,
        last_name: data.lastName,
        email: data.email,
        mobile_number: data.phone,
        street: data.street,
        city: data.city,
        state: data.state,
        zip: data.zip,
      });
      customerId = created.id;
      await updateIntake(intakeId, { customerFound: false, hcpCustomerId: customerId });
    }

    // Deliberate parity with the old app: retell estimates are ALSO labeled
    // "Website" in HCP's lead_source, mislabeled as that is — the office's HCP
    // reports have read that way since the automation launched, and changing
    // the string mid-migration would split the voice channel across two labels.
    // Flagged in docs/automations-merge-plan.md as a post-cutover decision.
    const leadSource = source === "facebook" ? "Facebook" : "Website";
    const estimate = await createEstimate(customerId, data.serviceNeeded, leadSource);

    const leadId = await linkEstimateToLead(intakeId, data, customerId, estimate.id);

    await updateIntake(intakeId, {
      hcpEstimateId: estimate.id,
      leadId,
      status: "completed",
      processedAt: new Date(),
    });
    console.log(`[intake] ${source} intake ${intakeId} complete: customer=${customerId} estimate=${estimate.id} lead=${leadId ?? "(unlinked)"}`);

    // The office gets a heads-up for form-shaped leads (the voice path already
    // produces the call-summary email, so retell is deliberately excluded).
    if (source === "facebook" || source === "website") {
      const sourceName = source === "facebook" ? "Facebook" : "Website";
      const fullName = `${data.firstName} ${data.lastName}`.trim();
      const address = [data.street, data.city, data.state, data.zip].filter(Boolean).join(", ");
      const phoneFmt = data.phone.length === 10
        ? `(${data.phone.slice(0, 3)}) ${data.phone.slice(3, 6)}-${data.phone.slice(6)}`
        : data.phone;
      const subject = `New ${sourceName} Lead: ${fullName || "Unknown"}`;
      const html = `<div style="font-family:Arial,sans-serif;color:#000;font-size:14px;line-height:1.5;">
<p>A new lead came in from ${sourceName === "Facebook" ? "a Facebook ad" : "the website"} and was added to HouseCall Pro.</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Name</td><td style="padding:4px 0;">${escapeHtml(fullName) || "(none)"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Phone</td><td style="padding:4px 0;">${escapeHtml(phoneFmt) || "(none)"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Email</td><td style="padding:4px 0;">${escapeHtml(data.email) || "(none)"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Address</td><td style="padding:4px 0;">${escapeHtml(address) || "(none)"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;vertical-align:top;">Service Needed</td><td style="padding:4px 0;">${escapeHtml(data.serviceNeeded) || "(none)"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Customer</td><td style="padding:4px 0;">${existing ? "Existing in HCP" : "Newly created"} (ID: ${customerId})</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#555;font-weight:600;">Estimate ID</td><td style="padding:4px 0;">${estimate.id}</td></tr>
</table>
<p style="color:#888;font-size:12px;margin-top:24px;">Sent automatically by the Arbor automations hub.</p>
</div>`;
      try {
        await sendEmail("info@arbor-mgmt.com", subject, html);
      } catch (emailErr) {
        console.log(`[intake] ${sourceName} success email failed for ${intakeId}: ${emailErr instanceof Error ? emailErr.message : emailErr}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[intake] processing failed for ${intakeId}: ${message}`);
    await updateIntake(intakeId, { status: "failed", errorMessage: message });
    await sendFailureAlert(SOURCE_LABELS[source], "HouseCall Pro customer/estimate creation failed", {
      intakeId,
      source,
      name: `${data.firstName} ${data.lastName}`.trim(),
      phone: data.phone,
      email: data.email,
      address: [data.street, data.city, data.state, data.zip].filter(Boolean).join(", "),
      serviceNeeded: data.serviceNeeded,
      error: message,
    });
  }
}
