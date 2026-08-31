import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { pools, trackingNumbers } from "@/lib/db/schema";

/**
 * Number pools — the operations behind both `/api/pools*` and the MCP pool tools.
 *
 * `key` is the stable identifier stored on `tracking_numbers.pool`, so it is
 * immutable once created: renaming it would orphan every number pointing at it.
 * Editing changes display metadata and the DNI flag only.
 *
 * `isDni` is the load-bearing field, not a label. DNI leasing draws only from pools
 * flagged with it, so moving a pool in or out of that set silently changes which
 * numbers the website can hand to visitors.
 */
export interface PoolRow {
  key: string;
  displayName: string;
  description: string | null;
  isDni: boolean;
}

export async function listPools(): Promise<PoolRow[]> {
  return db
    .select({
      key: pools.key,
      displayName: pools.displayName,
      description: pools.description,
      isDni: pools.isDni,
    })
    .from(pools)
    .orderBy(asc(pools.key));
}

/** Returns null when the key is already taken — the caller reports the conflict. */
export async function createPool(p: {
  key: string;
  displayName: string;
  description?: string | null;
  isDni?: boolean;
}): Promise<PoolRow | null> {
  const [row] = await db
    .insert(pools)
    .values({
      key: p.key,
      displayName: p.displayName,
      description: p.description ?? null,
      isDni: p.isDni ?? false,
    })
    .onConflictDoNothing({ target: pools.key })
    .returning();
  return row ?? null;
}

/** Returns null when no pool has that key. */
export async function updatePool(
  key: string,
  patch: { displayName?: string; description?: string | null; isDni?: boolean },
): Promise<PoolRow | null> {
  const [row] = await db
    .update(pools)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pools.key, key))
    .returning();
  return row ?? null;
}

export type DeletePoolResult =
  | { ok: true }
  | { ok: false; reason: "reserved" }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "in_use"; numbers: number };

/**
 * Delete a pool, refusing while anything still points at it.
 *
 * Both guards are about not stranding numbers rather than about tidiness: `reserved`
 * is where `provisionNumber` puts a number by default, so deleting it would leave
 * new numbers referencing a pool that does not exist, and a pool still in use would
 * do the same to the numbers already in it.
 */
export async function deletePool(key: string): Promise<DeletePoolResult> {
  if (key === "reserved") return { ok: false, reason: "reserved" };

  const [{ inUse }] = await db
    .select({ inUse: sql<number>`count(*)::int` })
    .from(trackingNumbers)
    .where(eq(trackingNumbers.pool, key));
  if (inUse > 0) return { ok: false, reason: "in_use", numbers: inUse };

  const deleted = await db.delete(pools).where(eq(pools.key, key)).returning();
  return deleted.length ? { ok: true } : { ok: false, reason: "not_found" };
}
