import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { manualSpend, sources } from "@/lib/db/schema";

/**
 * Monthly spend typed in by hand, for the channels no API sync reaches — Local
 * Services, Google Business Profile, print, yard signs.
 *
 * The operations behind both `/api/admin/manual-spend` and the MCP tools.
 * `runAttribution` spreads each month's amount evenly across its days so these
 * channels get CPL and ROAS rows beside the synced ones; nothing here writes
 * `ad_spend`, so a manual figure can never collide with a platform pull.
 */

/** `YYYY-MM` (or a full date) → the first of that month, which is how it is stored. */
export function normalizeMonth(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-01` : null;
}

export interface ManualSpendRow {
  sourceId: string;
  sourceKey: string | null;
  month: string;
  amountCents: number;
  note: string | null;
}

export async function listManualSpend(): Promise<ManualSpendRow[]> {
  return db
    .select({
      sourceId: manualSpend.sourceId,
      sourceKey: sources.key,
      month: manualSpend.month,
      amountCents: manualSpend.amountCents,
      note: manualSpend.note,
    })
    .from(manualSpend)
    .leftJoin(sources, eq(manualSpend.sourceId, sources.id))
    .orderBy(asc(manualSpend.month));
}

export type ManualSpendResult = { ok: true } | { ok: false; reason: "bad_month" | "unknown_source" };

/**
 * Upsert one (source, month) figure. Checked against `sources` up front because an
 * unknown id would otherwise surface as a raw foreign-key 500 rather than an
 * answerable error.
 */
export async function setManualSpend(p: {
  sourceId: string;
  month: string;
  amountCents: number;
  note?: string | null;
}): Promise<ManualSpendResult> {
  const month = normalizeMonth(p.month);
  if (!month) return { ok: false, reason: "bad_month" };

  const [source] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, p.sourceId)).limit(1);
  if (!source) return { ok: false, reason: "unknown_source" };

  await db
    .insert(manualSpend)
    .values({ sourceId: p.sourceId, month, amountCents: p.amountCents, note: p.note ?? null })
    .onConflictDoUpdate({
      target: [manualSpend.sourceId, manualSpend.month],
      set: { amountCents: sql`excluded.amount_cents`, note: sql`excluded.note`, updatedAt: sql`now()` },
    });
  return { ok: true };
}

export async function deleteManualSpend(sourceId: string, month: string): Promise<ManualSpendResult> {
  const m = normalizeMonth(month);
  if (!m) return { ok: false, reason: "bad_month" };
  await db.delete(manualSpend).where(and(eq(manualSpend.sourceId, sourceId), eq(manualSpend.month, m)));
  return { ok: true };
}
