import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { hcpEstimates, hcpJobs } from "@/lib/db/schema";
import {
  discountCentsSql,
  estimateLineItemsSql,
  grossCentsSql,
  lineItemsResolvedSql,
  netCentsSql,
  quotedHoursSql,
} from "@/lib/hcp/line-items";

/**
 * The individual priced lines of ONE estimate or job.
 *
 * Every other line-item surface in this app is a rollup — a count, a sum, a joined
 * list of names. This is the only one that answers "what is actually ON it", which
 * on a tree job is the list of trees and what each was priced at.
 *
 * ── Why this is per-record and not part of the list tools ───────────────────
 * A job carries 2-7 lines and an estimate more, so folding the raw array into
 * `arbor_list_jobs` would add roughly a kilobyte to every row — several megabytes
 * across a full-history window, on every load, to serve a panel that is open on one
 * record at a time. Read on demand instead. It costs nothing to do so: the items are
 * already in our own database, so there is no HousecallPro round trip and no rate
 * limit to respect.
 *
 * ── The scoping rule is NOT re-implemented here ─────────────────────────────
 * A won estimate's lines are narrowed to the approved options, exactly as its
 * totals are, by the same `estimateLineItemsSql` the columns use. Showing all three
 * alternative bids as though they were one sold job is the error that rule exists to
 * prevent, and it would be a worse error here than in a column — these are the lines
 * someone would read out to a customer.
 */
export interface LineItemLine {
  name: string;
  /** materials | labor | fixed gratuity | fixed discount | percent discount. */
  kind: string;
  quantity: number | null;
  unitOfMeasure: string | null;
  /** As STORED. On a percent discount this is basis points, not cents — which is
   *  why `amountCents` beside it is the number to show, and this one is for
   *  reconciling against HousecallPro's own screen. */
  unitPriceRaw: number | null;
  /** What the line really did to the price: signed, in cents, both discount kinds
   *  converted onto the one scale. Negative on a discount. */
  amountCents: number;
  /** The percentage itself on a percent discount (1000 bp -> 10), else null. */
  discountRate: number | null;
  /** Which option of the estimate this belongs to; absent on jobs. */
  optionId: string | null;
}

export interface LineItemDetail {
  kind: "estimate" | "job";
  id: string;
  /** Null means the lines have NOT been read from HousecallPro yet — which is not
   *  the same as an unpriced record, whose `lines` is legitimately empty. */
  syncedAt: string | null;
  lines: LineItemLine[];
  grossCents: number;
  discountCents: number;
  netCents: number;
  quotedHours: number | null;
  /** What the record itself says it totals, for comparison. */
  recordTotalCents: number;
  /** Whether `netCents` matches that, within a cent. A false here on a record with
   *  lines is the same signal /api/diagnostics counts as `mismatched`. */
  reconciles: boolean;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const nullableNum = (v: unknown): number | null => (v == null ? null : Number(v));

/** Shape a stored line, post-resolution, into the documented contract. */
function toLine(raw: Record<string, unknown>): LineItemLine {
  return {
    name: String(raw.name ?? "").trim() || "(unnamed line)",
    kind: String(raw.kind ?? "labor"),
    quantity: nullableNum(raw.quantity),
    unitOfMeasure: raw.unit_of_measure == null ? null : String(raw.unit_of_measure),
    unitPriceRaw: nullableNum(raw.unit_price),
    amountCents: Math.round(num(raw.resolvedCents)),
    discountRate: nullableNum(raw.discountRate),
    optionId: raw.optionId == null ? null : String(raw.optionId),
  };
}

export async function getLineItems(
  kind: "estimate" | "job",
  id: string,
): Promise<LineItemDetail | null> {
  // The scoped item array — the ONE place the won-estimate option rule is applied.
  const items =
    kind === "estimate"
      ? estimateLineItemsSql(hcpEstimates.lineItems, hcpEstimates.options, hcpEstimates.won)
      : sql`${hcpJobs.lineItems}`;

  const table = kind === "estimate" ? hcpEstimates : hcpJobs;
  const idCol = kind === "estimate" ? hcpEstimates.id : hcpJobs.id;
  const totalCol = kind === "estimate" ? hcpEstimates.totalAmountCents : hcpJobs.totalAmountCents;
  const syncedCol =
    kind === "estimate" ? hcpEstimates.lineItemsSyncedAt : hcpJobs.lineItemsSyncedAt;

  const [row] = await db
    .select({
      lines: lineItemsResolvedSql(items),
      grossCents: grossCentsSql(items),
      discountCents: discountCentsSql(items),
      netCents: netCentsSql(items),
      quotedHours: quotedHoursSql(items),
      recordTotalCents: totalCol,
      syncedAt: syncedCol,
    })
    .from(table)
    .where(eq(idCol, id))
    .limit(1);

  if (!row) return null;

  const lines = (Array.isArray(row.lines) ? row.lines : []).map((r) =>
    toLine(r as Record<string, unknown>),
  );
  const netCents = num(row.netCents);
  const recordTotalCents = num(row.recordTotalCents);

  return {
    kind,
    id,
    syncedAt: row.syncedAt ? new Date(row.syncedAt).toISOString() : null,
    lines,
    grossCents: num(row.grossCents),
    discountCents: num(row.discountCents),
    netCents,
    quotedHours: nullableNum(row.quotedHours),
    recordTotalCents,
    // An unpriced record reconciles trivially; only a record WITH lines is a claim.
    reconciles: lines.length === 0 || Math.abs(netCents - recordTotalCents) <= 1,
  };
}
