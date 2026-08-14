import { displayNameFor } from "@/lib/sources/naming";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, sources } from "@/lib/db/schema";
import { googleAds } from "@/lib/integrations";
import { getPlatformCreds } from "@/lib/credentials";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { withSyncRun } from "./run";

/**
 * lsa.sync.leads — pull Google Local Services Ads leads and store them as `lsa`
 * leads attributed to google/lsa. Deduped on Google's own lead id via
 * leads.external_id (partial unique index on (type, external_id)).
 * Best-effort: no-ops without creds.
 */
export async function syncLsaLeads({ sinceDays = 30 }: { sinceDays?: number } = {}) {
  return withSyncRun("lsa.sync.leads", async () => {
    const g = await getPlatformCreds("google_ads");
    if (!g.refresh_token || !g.developer_token) {
      return { skipped: "Google Ads creds not set", inserted: 0 };
    }

    const sourceId = await getOrCreateSource("google/lsa");
    const lsaLeads = await googleAds.getLsaLeads({ sinceDays });
    let inserted = 0;
    let skipped = 0;

    for (const l of lsaLeads) {
      // No external id → no idempotency key; LSA always assigns one, so a row
      // without it is malformed — skip rather than re-insert it every run.
      if (!l.id) {
        skipped++;
        continue;
      }
      const existing = await db
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.type, "lsa"), eq(leads.externalId, l.id)))
        .limit(1);
      if (existing.length) continue;

      await db
        .insert(leads)
        .values({
          type: "lsa",
          status: "new",
          name: l.name,
          phoneE164: normalizePhone(l.phone),
          emailLc: normalizeEmail(l.email),
          sourceId,
          medium: "lsa",
          externalId: l.id,
          occurredAt: l.createdTime ?? new Date(),
        })
        // Race backstop for the check above — the partial unique index
        // leads_type_external_id_uq is the real guard.
        .onConflictDoNothing();
      inserted++;
    }

    return { fetched: lsaLeads.length, inserted, skipped };
  });
}

async function getOrCreateSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: displayNameFor(key), platform: "google_lsa" }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}
