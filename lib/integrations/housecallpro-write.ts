/**
 * HousecallPro WRITE half — create customers and estimates from inbound leads.
 * Ported from Arbor-Automations `server/housecallpro.ts` (the merge's slice 2).
 * The read half (sync) stays in `housecallpro.ts`; this module is deliberately
 * separate because writes carry a different discipline:
 *
 * **Sanitize-or-drop, never fail the lead.** HCP customer creation is strict
 * and all-or-nothing: a 400 on ANY malformed field aborts the whole
 * lead → customer → estimate flow. Voice/webhook capture routinely yields
 * spelled-out emails ("a b c at gmail dot com") and full state names
 * ("Illinois"), so each optional field is normalized and DROPPED if it cannot
 * be made valid. Losing an entire inbound lead over a cosmetic field is far
 * worse than a customer record missing one optional field — phone is the real
 * key. (From the old repo's `.agents/memory/hcp-field-validation.md`.)
 *
 * **Mirror first, live before create.** The local `hcp_customers` mirror
 * answers "does this caller exist?" with no network call — but it can be up to
 * an hour stale, and creating a duplicate customer off a stale miss is the one
 * place staleness would really cost. So a mirror MISS is always re-checked
 * against the live API before creating.
 *
 * Auth note: these endpoints are proven with the `Bearer` scheme (the old app
 * ran them for months); the read client uses `Token`. Both are accepted by HCP,
 * but each stays on the scheme it is proven with.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers } from "@/lib/db/schema";
import { getPlatformCreds } from "@/lib/credentials";
import { env } from "@/lib/env";
import { normalizePhone as toE164 } from "@/lib/phone";

/** HCP stores bare 10-digit numbers. */
export function formatPhoneNumber(phone: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

export interface HcpWriteCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  mobile_number?: string;
  home_number?: string;
  work_number?: string;
  tags?: string[];
  addresses?: Array<{ street?: string; city?: string; state?: string; zip?: string }>;
}

export interface HcpWriteEstimate {
  id: string;
}

async function config() {
  const c = await getPlatformCreds("housecallpro");
  if (!c.api_key) throw new Error("HousecallPro API key is not configured");
  return { apiKey: c.api_key, base: c.api_base || env.HCP_API_BASE };
}

async function hcpFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { apiKey, base } = await config();
  return fetch(new URL(path, base), {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function sanitizeEmail(rawEmail: unknown): string | null {
  if (!rawEmail || typeof rawEmail !== "string") return null;
  let email = rawEmail.trim();
  if (email.includes(",") || /\s/.test(email)) {
    email = email.split(/[,\s]+/)[0];
  }
  email = email.trim();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return valid ? email : null;
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};

const VALID_STATE_ABBRS = new Set(Object.values(US_STATES));

export function normalizeState(rawState: unknown): string | null {
  if (!rawState || typeof rawState !== "string") return null;
  const trimmed = rawState.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && VALID_STATE_ABBRS.has(upper)) return upper;
  const mapped = US_STATES[trimmed.toLowerCase()];
  return mapped || null;
}

/**
 * Find an existing customer by phone. Mirror first (indexed, no network, and it
 * checks all THREE phone fields via `phones_e164` where the old live search only
 * matched `mobile_number`); on a mirror miss, the live API confirms before the
 * caller creates anything. A mirror hit needs no live confirmation — HCP ids
 * are stable, and a merged-away record failing later on the estimate create is
 * caught by that call's own error handling.
 *
 * Returns `{ id, foundVia }` or null when the caller should create.
 */
export async function findCustomerByPhone(
  phone: string,
): Promise<{ id: string; foundVia: "mirror" | "live" } | null> {
  const tenDigits = formatPhoneNumber(phone);
  if (tenDigits.length !== 10) return null;
  const e164 = toE164(tenDigits);

  if (e164) {
    const rows = await db
      .select({ hcpCustomerId: hcpCustomers.hcpCustomerId })
      .from(hcpCustomers)
      .where(sql`${hcpCustomers.phonesE164} && ARRAY[${e164}]::text[]`)
      .limit(5);
    const distinct = [...new Set(rows.map((r) => r.hcpCustomerId))];
    // Several customers share the number (household/business): the FIRST is as
    // good a booking target as the old app's mobile-only match ever was, but
    // ambiguity is better resolved by the live search's freshest data below.
    if (distinct.length === 1) return { id: distinct[0], foundVia: "mirror" };
  }

  // Mirror miss (or ambiguous): the customer may have been created in HCP
  // within the sync window. HCP's `q` search is fuzzy across name/email/address,
  // so every candidate is re-checked against its actual phone fields — and
  // note HCP returns ZERO results for an E.164 query, hence tenDigits.
  const response = await hcpFetch(`/customers?q=${tenDigits}`);
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HouseCall Pro API error: ${response.status} ${errorText}`);
  }
  const data = (await response.json()) as { customers?: HcpWriteCustomer[] };
  const match = (data.customers ?? []).find((c) =>
    [c.mobile_number, c.home_number, c.work_number]
      .filter(Boolean)
      .some((n) => formatPhoneNumber(n as string) === tenDigits),
  );
  return match ? { id: match.id, foundVia: "live" } : null;
}

export async function createCustomer(customerData: {
  first_name: string;
  last_name: string;
  email: string;
  mobile_number: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}): Promise<HcpWriteCustomer> {
  const cleanEmail = sanitizeEmail(customerData.email);
  if (customerData.email && !cleanEmail) {
    console.log(`[hcp-write] dropping invalid email "${customerData.email}" for ${customerData.first_name} ${customerData.last_name}`);
  }

  const cleanState = normalizeState(customerData.state);
  if (customerData.state && !cleanState) {
    console.log(`[hcp-write] dropping unrecognized state "${customerData.state}" for ${customerData.first_name} ${customerData.last_name}`);
  }

  const address: Record<string, unknown> = {
    street: customerData.street,
    city: customerData.city,
    zip: customerData.zip,
  };
  if (cleanState) address.state = cleanState;

  const body: Record<string, unknown> = {
    first_name: customerData.first_name,
    last_name: customerData.last_name,
    mobile_number: formatPhoneNumber(customerData.mobile_number),
    addresses: [address],
  };
  if (cleanEmail) body.email = cleanEmail;

  const response = await hcpFetch("/customers", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HouseCall Pro API error: ${response.status} ${errorText}`);
  }
  const customer = (await response.json()) as HcpWriteCustomer;
  console.log(`[hcp-write] customer created: ${customer.id}`);
  return customer;
}

export async function createEstimate(
  customerId: string,
  serviceNeeded: string,
  leadSource = "Website",
): Promise<HcpWriteEstimate> {
  const response = await hcpFetch("/estimates", {
    method: "POST",
    body: JSON.stringify({
      customer_id: customerId,
      options: [{ name: "Option #1" }],
      note: serviceNeeded || "",
      lead_source: leadSource,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HouseCall Pro API error: ${response.status} ${errorText}`);
  }
  const estimate = (await response.json()) as HcpWriteEstimate;
  console.log(`[hcp-write] estimate created: ${estimate.id} for customer ${customerId}`);
  return estimate;
}

/**
 * Live single-record reads for the review-request intake (invoice.paid hands us
 * ids, and the hourly mirror may not have a just-completed job yet). The
 * customer fetch sends `expand[]=do_not_service` — without it the key is absent
 * and reads exactly like false, the three-state trap that put 51 flagged
 * customers on a newsletter send.
 */
export async function getJobById(jobId: string): Promise<{
  id: string;
  customer_id?: string;
  job_type_name?: string;
  tags?: string[];
} | null> {
  const response = await hcpFetch(`/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    console.log(`[hcp-write] job fetch failed: ${response.status} for ${jobId}`);
    return null;
  }
  // ⚠️ NORMALIZE, don't cast. A real HCP job carries NEITHER `customer_id` NOR
  // `job_type_name` at the top level — the customer is nested at `customer.id`
  // and the type at `job_fields.job_type.name`, both null on the flat keys. The
  // previous `as {...}` asserted fields that never exist, which TypeScript
  // cannot check against a runtime payload, so it compiled clean and every
  // caller read undefined. That silently broke the review workflow for two days
  // (invoice.paid → "No customer_id on job, skipping") and would ALSO have
  // disabled the Tree-Service-only filter the moment the first bug was fixed.
  const data = (await response.json()) as {
    id: string;
    customer_id?: string;
    customer?: { id?: string };
    job_type_name?: string;
    job_fields?: { job_type?: { name?: string } };
    tags?: string[];
  };
  return {
    id: data.id,
    customer_id: data.customer_id || data.customer?.id || undefined,
    job_type_name: data.job_fields?.job_type?.name || data.job_type_name || undefined,
    tags: data.tags,
  };
}

export async function getCustomerById(customerId: string): Promise<
  (HcpWriteCustomer & { do_not_service?: boolean }) | null
> {
  const response = await hcpFetch(`/customers/${encodeURIComponent(customerId)}?expand[]=do_not_service`);
  if (!response.ok) {
    console.log(`[hcp-write] customer fetch failed: ${response.status} for ${customerId}`);
    return null;
  }
  return (await response.json()) as HcpWriteCustomer & { do_not_service?: boolean };
}
