/**
 * The database half of caller identification: resolve a Retell `from_number`
 * against the synced HCP mirror and hand back the {{caller_context}} directive.
 * The pure sentence/matching logic lives in `caller-context.ts` (no DB import,
 * so the verify script runs with no environment). See that file's header for
 * the rules and their provenance.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpCustomers } from "@/lib/db/schema";
import { normalizePhone as toE164 } from "@/lib/phone";
import {
  UNKNOWN_CALLER,
  describeCaller,
  normalizePhone,
  pickMatch,
  type CallerContext,
  type LookupCustomer,
} from "@/lib/retell/caller-context";

/** Shape a synced `hcp_customers` row into the ported LookupCustomer contract.
 *  The three phone fields live only in `raw` (the projection keeps `mobile` and
 *  a collapsed `phone`), and `raw` is the full HCP payload by construction. */
function toLookupCustomer(row: typeof hcpCustomers.$inferSelect): LookupCustomer {
  const raw = (row.raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  return {
    id: row.hcpCustomerId,
    first_name: row.firstName ?? undefined,
    last_name: row.lastName ?? undefined,
    email: row.email ?? undefined,
    mobile_number: str(raw.mobile_number),
    home_number: str(raw.home_number),
    work_number: str(raw.work_number),
    do_not_service: row.doNotService ?? undefined,
    addresses: Array.isArray(row.addresses)
      ? (row.addresses as LookupCustomer["addresses"])
      : undefined,
  };
}

/**
 * Looks the caller up in the local HCP mirror, bounded by its own timeout.
 * Never throws.
 *
 * The overlap query against `phones_e164` (GIN) replaces the old live
 * `GET /customers?q=` round trip — same answer, no network, and the E.164 trap
 * (HCP matches nothing on a `+1…` query) ceases to exist because the array is
 * normalized at sync time. The timeout survives as a guard against a wedged
 * pool, not because the query is slow.
 */
export async function lookupCaller(fromNumber: string, timeoutMs = 2500): Promise<CallerContext> {
  const tenDigits = normalizePhone(fromNumber);
  if (tenDigits.length !== 10) return UNKNOWN_CALLER;
  const e164 = toE164(tenDigits);
  if (!e164) return UNKNOWN_CALLER;

  try {
    const query = db
      .select()
      .from(hcpCustomers)
      .where(sql`${hcpCustomers.phonesE164} && ARRAY[${e164}]::text[]`)
      // A number shared by a handful of records resolves to UNKNOWN anyway;
      // the cap just bounds a pathological row set.
      .limit(25);
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      // Don't let the guard keep the process alive after the query resolves.
      if (typeof t === "object" && "unref" in t) t.unref();
    });
    const rows = await Promise.race([query, timeout]);

    const { match, count } = pickMatch(rows.map(toLookupCustomer), tenDigits);
    if (!match) return { ...UNKNOWN_CALLER, matchCount: count };

    const { contextSentence } = describeCaller(match, tenDigits);
    return {
      known: true,
      doNotService: match.do_not_service === true,
      contextSentence,
      customerId: match.id,
      matchCount: count,
      note: "",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...UNKNOWN_CALLER, note: `lookup failed: ${reason}` };
  }
}
