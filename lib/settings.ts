import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

/**
 * Singleton key/value app settings (the `settings` table). For business config that
 * isn't a credential — call routing, attribution options, etc. Reads are fault
 * tolerant (fall back on any DB error) so a settings lookup never breaks a hot path.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return row ? (row.value as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Write a setting. `null` CLEARS it — the row is deleted, so `getSetting` falls
 * back to its default again.
 *
 * The delete is not a nicety. `settings.value` is `jsonb NOT NULL`, so passing null
 * used to raise a constraint violation, and every caller that clears a setting hit
 * it: clearing the default forward number, the text relay number, or the
 * tracking-origin allowlist each returned a 500 from Settings and changed nothing.
 * Found 2026-08-31 by verify:admin-ops; the routes had carried it since they were
 * written, because clearing one of these is rare and the failure looked like a
 * generic save error.
 *
 * Deleting is also the semantically right clear: storing a JSON null would make
 * `getSetting` return null rather than the caller's fallback, which is a different
 * thing from "unset" — the env default for forwarding, the built-in origin list.
 */
export async function setSetting(key: string, value: unknown): Promise<void> {
  if (value === null || value === undefined) {
    await db.delete(settings).where(eq(settings.key, key));
    return;
  }
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}
