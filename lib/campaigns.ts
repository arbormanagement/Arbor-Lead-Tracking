import { eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/client";
import { campaigns } from "@/lib/db/schema";

/**
 * Campaigns flagged as non-customer-acquisition — arborist recruiting, brand
 * awareness, anything whose leads are not prospective customers.
 *
 * Their spend and any already-captured leads stay in the database as history, but
 * they are kept out of every ROI number: recruiting dollars otherwise land in the
 * denominator of the channel's ROAS while producing no customer revenue, which
 * quietly understates the channel that paid for them.
 */
export async function excludedCampaignIds(): Promise<string[]> {
  const rows = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.excluded, true));
  return rows.map((r) => r.id);
}

/**
 * Predicate for a campaign-id column: keep only rows whose campaign isn't excluded.
 * Rows with no campaign are kept — `NOT IN` alone would silently drop them, since
 * `null NOT IN (…)` evaluates to null rather than true. Returns undefined when
 * nothing is excluded, so `and(...)` drops the clause entirely.
 */
export function campaignNotExcluded(col: AnyPgColumn, excludedIds: string[]): SQL | undefined {
  if (excludedIds.length === 0) return undefined;
  return or(isNull(col), notInArray(col, excludedIds));
}
