/**
 * Caller identification for Chloe's inbound Retell webhook.
 *
 * Ported from Arbor-Automations `server/callerLookup.ts` (2026-08-30, the
 * merge's slice 1) with ONE structural change: the lookup reads this app's
 * synced HCP mirror (`hcp_customers.phones_e164`, GIN-indexed) instead of
 * calling HousecallPro live on the telephony hot path. Everything the model
 * reads — every sentence `describeCaller` emits — is byte-identical to what
 * production emitted from the old app, because Retell simulation test cases
 * are built by RUNNING this source. Treat wording changes as prompt changes
 * needing a graded simulation batch, not refactors.
 *
 * Two rules shape everything here:
 *
 *  1. A caller-ID match is a HINT, never an identity. The person holding the
 *     phone may be a spouse, a tenant, or the new owner of a sold house. The
 *     directive we hand the model says confirm, never assert.
 *
 *  2. This lookup must never delay or block the office-hours answer. It runs
 *     under its own hard timeout and every failure path returns "unknown" —
 *     which renders as an empty variable and leaves Chloe behaving exactly as
 *     she does with no caller context at all.
 *
 * The trade the local mirror makes: the sync is hourly, so a customer created
 * in HCP within the last hour reads as unknown. That is today's behavior for
 * any HCP timeout, and strictly better on average — no network call, no 2.5s
 * budget, no E.164/fuzzy-q traps. The path that CREATES records (the estimate
 * webhook) still double-checks HCP live, where staleness would actually cost.
 *
 * Hard-won sentence rules, each bought with a graded failure (2026-08-28):
 *  - Emit a DIRECTIVE, never a fact plus a gag order. "There are 2 addresses"
 *    leaked in 6 of 6 graded calls; deleting the count fixed it with no prompt
 *    change.
 *  - State an absence POSITIVELY. Given nothing about email, the model
 *    inferred the absence and invented an address in 5 of 5 calls.
 *  - Two distinct customers on one number resolve to UNKNOWN, never a pick.
 *  - do_not_service is read and logged but NEVER shown to the model (Justin
 *    2026-08-27): a flagged caller is described identically to any other.
 */
/** HousecallPro stores bare 10-digit numbers; Retell sends E.164.
 *  NOTE: this is the ported 10-digit normalizer, distinct from `lib/phone.ts`'s
 *  E.164 one — the pure helpers below and the Retell webhook's contract are
 *  written against ten bare digits. */
export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export interface LookupCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  /** Present on ~92% of the book (sampled 2026-08-28). Spelling an email out
   *  loud is the slowest part of an estimate call, so confirming one we already
   *  hold is the single biggest time saving available here. */
  email?: string;
  mobile_number?: string;
  home_number?: string;
  work_number?: string;
  do_not_service?: boolean;
  /** `type` distinguishes a service address from a billing one; `street_line_2`
   *  carries the unit/apartment. Both were previously discarded. */
  addresses?: Array<{
    type?: string;
    street?: string;
    street_line_2?: string;
    city?: string;
    state?: string;
    zip?: string;
  }>;
}

export interface CallerContext {
  known: boolean;
  doNotService: boolean;
  /** Injected as {{caller_context}}. Empty when the caller is unknown. */
  contextSentence: string;
  /** Diagnostics only — never sent to the model. */
  customerId: string;
  matchCount: number;
  /** Why a lookup produced nothing, for the caller to log. Empty when fine. */
  note: string;
}

export const UNKNOWN_CALLER: CallerContext = {
  known: false,
  doNotService: false,
  contextSentence: "",
  customerId: "",
  matchCount: 0,
  note: "",
};

/**
 * The dynamic-variable fragment for the caller, and the one place the
 * omitted-vs-empty distinction is encoded.
 *
 * Retell applies `default_dynamic_variables` only when a key is ABSENT. An
 * explicit "" renders as nothing and SKIPS the default, so sending the unknown
 * caller's empty string silently discards the graded fail-safe sentence and
 * hands the model nothing at all — which it fills in by inference rather than
 * by asking. Omitting the key is what lets the default speak.
 *
 * This is the whole-caller form of the "state an absence POSITIVELY" rule in
 * this file's header: the same failure that made the model invent an email
 * address made it invent a service address, one level up.
 */
export function callerContextVariables(contextSentence: string): { caller_context?: string } {
  return contextSentence ? { caller_context: contextSentence } : {};
}

/**
 * Every candidate is re-checked against all three of its phone fields. Under
 * the old live-HCP lookup this defended against HCP's fuzzy `q` search; here
 * the GIN overlap query already guarantees a phone match, but the re-check is
 * kept so the semantics (and the tests) are identical, and so a drifted
 * `phones_e164` projection can never admit a wrong record.
 *
 * More than one distinct customer on the same number is treated as UNKNOWN
 * rather than resolved by picking one. Shared household and business numbers
 * are common, and greeting the wrong person by name is worse than greeting
 * nobody by name.
 */
export function pickMatch(customers: LookupCustomer[], tenDigits: string): { match: LookupCustomer | null; count: number } {
  const matches = (customers || []).filter((c) =>
    [c.mobile_number, c.home_number, c.work_number]
      .filter(Boolean)
      .some((n) => normalizePhone(n as string) === tenDigits)
  );
  const distinctIds = new Set(matches.map((c) => c.id));
  if (distinctIds.size !== 1) return { match: null, count: distinctIds.size };
  return { match: matches[0], count: 1 };
}

/**
 * Which of the three phone fields the caller is dialling from. The prompt asks
 * every caller whether their number is "a good mobile contact"; when they are
 * calling from the mobile we already hold, that question has a known answer.
 * Reported as a fact only — whether to still ask is the prompt's decision.
 */
export function matchedPhoneField(customer: LookupCustomer, tenDigits: string): "mobile" | "home" | "work" | "" {
  if (normalizePhone(customer.mobile_number || "") === tenDigits) return "mobile";
  if (normalizePhone(customer.home_number || "") === tenDigits) return "home";
  if (normalizePhone(customer.work_number || "") === tenDigits) return "work";
  return "";
}

/**
 * The address to offer back, and how many are on file.
 *
 * Two corrections over taking `addresses[0]` blindly:
 *  - A billing address is not where the work happens, so a service address is
 *    preferred when both are present. This is defensive: in a 200-customer
 *    sample (2026-08-28) nobody held both, and the 13 with a billing-only
 *    address are unaffected because it is the only address they have.
 *  - `street_line_2` holds the unit or apartment. Dropping it sends a crew to
 *    a building with no unit number.
 *
 * `count` exists so the caller can refuse to propose anything when a customer
 * owns several properties — offering one and having them agree out of politeness
 * books the wrong address.
 */
export function chooseAddress(customer: LookupCustomer): {
  spoken: string;
  full: string;
  count: number;
} {
  const all = customer.addresses || [];
  // Count SERVICE locations, not array entries. A customer with one billing and
  // one service address has two entries but only one place work happens, and
  // hedging there would make Chloe ask "which property?" of someone who owns one.
  const services = all.filter((a) => a.type === "service");
  const candidates = services.length > 0 ? services : all;
  const addr = candidates[0];
  if (!addr) return { spoken: "", full: "", count: 0 };
  const street = [addr.street, addr.street_line_2].filter(Boolean).join(" ");
  return {
    // What Chloe says out loud — a state read aloud makes the question clumsy.
    spoken: [street, addr.city].filter(Boolean).join(", "),
    // What create_estimate needs, which includes the state it would otherwise assume.
    full: [street, addr.city, addr.state].filter(Boolean).join(", "),
    count: candidates.length,
  };
}

/**
 * Builds the sentence the model actually reads. Written as an instruction
 * rather than data: a bare name invites the agent to greet someone who may not
 * be on the line.
 *
 * do_not_service is deliberately NOT surfaced to the model (Justin,
 * 2026-08-27): Chloe does not make do-not-service decisions. The flag can be
 * stale, and a voice agent quietly refusing to book — with no human judgement
 * in the loop and no way for the caller to appeal — is a worse failure than
 * booking someone the office later declines. Flagged callers are handled
 * exactly like anyone else on the phone; the office decides. The flag is still
 * read and logged, because knowing it was a flagged caller is useful after the
 * fact, and because suppressing them from MARKETING is a separate control that
 * does still apply.
 */
export function describeCaller(
  customer: LookupCustomer,
  tenDigits = "",
): { contextSentence: string } {
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
  const { spoken, full, count } = chooseAddress(customer);
  // Several properties on file: state none of them. See chooseAddress.
  const multi = count > 1;
  const address = multi ? "" : full;
  const phoneField = tenDigits ? matchedPhoneField(customer, tenDigits) : "";

  const parts: string[] = [
    `This phone number belongs to an existing customer record${name ? `: ${name}` : ""}${address ? `, at ${address}` : ""}.`,
  ];

  if (multi) {
    parts.push(
      "Do NOT propose or name an address for this caller. Ask which property this call is about, exactly as you would ask any caller, and use their answer.",
    );
  }

  // The email is the point of this enrichment, but it is also the one field
  // that belongs to a PERSON rather than to the property. The caller may be a
  // new owner at the same number, so it stays sealed until they have confirmed
  // they are the person named above.
  if (!customer.email) {
    parts.push(
      "We do NOT hold an email address for this caller. Ask them for their email exactly as you would ask any caller, and never suggest that we already have one.",
    );
  }

  if (customer.email) {
    parts.push(
      `We also hold an email for them: ${customer.email}. Do NOT read that email out or use it until the caller has confirmed they are ${customer.first_name || "the person named above"}. Once they have, confirm it back rather than making them spell it out, for example "and I have your email as ${customer.email} — still the best one?". If they have NOT confirmed the name, ask for their email normally and never say the one above aloud.`,
    );
  }

  if (phoneField) {
    parts.push(
      `The number they are calling from is the ${phoneField} number on that record.`,
    );
  }

  parts.push(
    "Treat all of the above as a HINT from caller ID, not as confirmation of who is on the line — it may be a spouse, a tenant, or a new owner.",
    "Do NOT state the name, address or email as fact and do NOT skip any question because of them.",
    "You may CONFIRM instead of asking cold, for example \"am I speaking with " +
      (customer.first_name || "the homeowner") +
      "?\"" +
      (multi ? "" : " or \"is this for the " + (spoken || "same") + " address?\"") +
      ", and use whatever the caller actually tells you.",
  );

  return { contextSentence: parts.join(" ") };
}
