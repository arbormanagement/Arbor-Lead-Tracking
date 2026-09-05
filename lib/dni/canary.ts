/**
 * The fixed identities the DNI canary (`lib/sync/dni-canary.ts`) uses, so the
 * monitor's own rows can be told apart from a customer's everywhere they might
 * otherwise be mistaken for one.
 *
 * Kept in this tiny module rather than exported from the canary itself because
 * `lib/twilio/inbound.ts` needs them on the `/voice` hot path (sub-3s budget), and
 * that file must not pull the canary's fetch-and-parse machinery into its import
 * graph just to read three strings.
 */

/** One visitor row and one session row, owned by the canary forever. */
export const CANARY_VISITOR_ID = "arbor-dni-canary-visitor";
export const CANARY_SESSION_ID = "arbor-dni-canary-session";

/**
 * A keyword no real visitor carries, so `findShareableLease` can never match the
 * canary to a live visitor's lease. Without it the canary would usually be handed a
 * shared `direct` number: it would pass without ever exercising `leaseNumber`, which
 * is the half most likely to be broken.
 */
export const CANARY_TERM = "arbor-dni-canary";
