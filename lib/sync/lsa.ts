import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, sources } from "@/lib/db/schema";
import { googleAds } from "@/lib/integrations";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { env } from "@/lib/env";
import { withSyncRun } from "./run";

/**
 * lsa.sync.leads — pull Google Local Services Ads leads and store them as `lsa`
 * leads attributed to google/lsa. Deduped on (type, phone, occurred_at) since the
 * leads table has no external-id column for LSA. Best-effort: no-ops without creds.
 */
export async function syncLsaLeads({ sinceDays = 30 }: { sinceDays?: number } = {}) {
  return withSyncRun("lsa.sync.leads", async () => {
    if (!env.GOOGLE_ADS_REFRESH_TOKEN || !env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      return { skipped: "Google Ads creds not set", inserted: 0 };
    }

    const sourceId = await getOrCreateSource("google/lsa");
    const lsaLeads = await googleAds.getLsaLeads({ sinceDays });
    let inserted = 0;

    for (const l of lsaLeads) {
      const phoneE164 = normalizePhone(l.phone);
      const occurredAt = l.createdTime ?? new Date();

      // Dedup: same lsa lead (phone + creation time) already captured?
      const existing = phoneE164
        ? await db
            .select({ id: leads.id })
            .from(leads)
            .where(and(eq(leads.type, "lsa"), eq(leads.phoneE164, phoneE164), eq(leads.occurredAt, occurredAt)))
            .limit(1)
        : [];
      if (existing.length) continue;

      await db.insert(leads).values({
        type: "lsa",
        status: "new",
        name: l.name,
        phoneE164,
        emailLc: normalizeEmail(l.email),
        sourceId,
        medium: "lsa",
        occurredAt,
      });
      inserted++;
    }

    return { fetched: lsaLeads.length, inserted };
  });
}

async function getOrCreateSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: key, platform: "google_lsa" }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}
