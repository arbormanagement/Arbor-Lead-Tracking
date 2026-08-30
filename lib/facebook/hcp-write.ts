/**
 * Facebook lead → HCP customer + estimate (the merge's slice 5). Ported from
 * Arbor-Automations' `processFacebookLead`, with the guard that app never had:
 * this only ever runs for a lead the ingest CREATED — a submission from an
 * excluded (recruiting) campaign, a deferred campaign lookup, or a duplicate
 * never reaches HCP, so applicants stop becoming HCP customers.
 *
 * ⚠️ Gated by FB_HCP_WRITE_ENABLED (default off): the old app also writes HCP
 * from the same Meta events, and LT's poller sees every lead regardless of
 * where Meta's webhook points — two writers double-create. Flip on only at the
 * slice 5 cutover, when the old app is retired from this job.
 *
 * Field extraction uses the old app's exact-key aliases against the raw
 * field_data (the ingest's own `mapFbFields` extracts contact identity only —
 * HCP needs the address block too).
 */
import { sendFailureAlert } from "@/lib/email/sendgrid";
import { env } from "@/lib/env";
import { createIntake, processIntake, updateIntakeFailed } from "@/lib/intake/process";
import type { FbLeadDetail } from "@/lib/integrations/facebook";

const FIELD_ALIASES: Record<string, string[]> = {
  fullName: ["full_name", "fullname", "name"],
  firstName: ["first_name", "firstname", "given_name"],
  lastName: ["last_name", "lastname", "family_name", "surname"],
  email: ["email", "email_address"],
  phone: ["phone_number", "phone", "mobile_number"],
  street: ["street_address", "street", "address", "address_line_1", "address1"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  zip: ["zip_code", "zip", "postal_code", "postcode"],
  serviceNeeded: [
    "tree_work_needed",
    "service_needed",
    "services_needed",
    "what_tree_service_do_you_need?",
    "what_tree_service_do_you_need",
    "what_service_do_you_need?",
    "what_service_do_you_need",
    "message",
    "notes",
  ],
};

function pick(fields: Record<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    if (fields[alias]) return fields[alias];
  }
  return "";
}

export function fbHcpWriteEnabled(): boolean {
  return env.FB_HCP_WRITE_ENABLED === "true";
}

/**
 * Fire the HCP write for a freshly-created FB lead. Idempotent on leadgen id
 * via `automation_intakes`' unique index, so the webhook and the poller racing
 * over the same lead produce exactly one estimate. Never throws — a failure
 * lands on the intake row + alert email, and must not fail the ingest that
 * already succeeded.
 */
export async function createHcpEstimateForFbLead(detail: FbLeadDetail): Promise<void> {
  try {
    const fields: Record<string, string> = {};
    for (const f of detail.fieldData ?? []) {
      const key = (f.name || "").toLowerCase().trim();
      const value = f.values?.[0] || "";
      if (key) fields[key] = value;
    }

    let firstName = pick(fields, FIELD_ALIASES.firstName).trim();
    let lastName = pick(fields, FIELD_ALIASES.lastName).trim();
    if (!firstName && !lastName) {
      const fullName = pick(fields, FIELD_ALIASES.fullName).trim();
      if (fullName) {
        const parts = fullName.split(/\s+/);
        firstName = parts[0] || "";
        lastName = parts.slice(1).join(" ") || "";
      }
    }

    const rawPhone = pick(fields, FIELD_ALIASES.phone);
    const digits = rawPhone.replace(/\D/g, "");
    const phone = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);

    const data = {
      firstName: firstName || "Unknown",
      lastName: lastName || "Lead",
      email: pick(fields, FIELD_ALIASES.email).trim(),
      phone,
      street: pick(fields, FIELD_ALIASES.street).trim(),
      city: pick(fields, FIELD_ALIASES.city).trim(),
      state: pick(fields, FIELD_ALIASES.state).trim(),
      zip: pick(fields, FIELD_ALIASES.zip).trim(),
      serviceNeeded: pick(fields, FIELD_ALIASES.serviceNeeded).trim() || "Facebook Lead — no service detail provided",
    };

    const intake = await createIntake("facebook", data, { fbLeadgenId: detail.leadgenId });
    if (!intake) {
      console.log(`[fb hcp-write] leadgen ${detail.leadgenId} already claimed, skipping`);
      return;
    }

    if (phone.length !== 10) {
      await updateIntakeFailed(intake.id, `Invalid phone number (${phone.length} digits). Need 10-digit US number.`);
      await sendFailureAlert("Facebook Lead Ads", "Lead had an invalid phone number", {
        leadgenId: detail.leadgenId,
        name: `${data.firstName} ${data.lastName}`.trim(),
        email: data.email,
        rawPhone: rawPhone || "(none)",
        serviceNeeded: data.serviceNeeded,
      });
      return;
    }

    await processIntake(intake.id, data, "facebook");
  } catch (err) {
    console.log(`[fb hcp-write] failed for ${detail.leadgenId}: ${err instanceof Error ? err.message : err}`);
  }
}
