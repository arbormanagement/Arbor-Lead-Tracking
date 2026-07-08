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

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}
