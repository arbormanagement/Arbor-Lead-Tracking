import { facebook } from "@/lib/integrations/facebook";
import { getPlatformCreds } from "@/lib/credentials";
import { ingestFacebookLead } from "@/lib/facebook/ingest";
import { getSetting } from "@/lib/settings";
import { incrementalWindowDays, withSyncRun } from "./run";

/** Settings key: form IDs to poll. Empty ⇒ all ACTIVE forms (default). */
export const FB_INCLUDED_FORMS_KEY = "facebook.lead_form_ids";

/**
 * facebook.leads.poll — pull lead-form submissions via the Graph API instead of a
 * webhook, so we ingest FB leads WITHOUT touching the page's existing (Replit)
 * webhook subscription. Lists active lead forms, pulls leads created since the last
 * successful run (incremental, with a generous overlap since Meta backfills), and
 * ingests them deduped on fb_leadgen_id. Needs a token with leads_retrieval.
 */
export async function syncFacebookLeads({ sinceDays }: { sinceDays?: number } = {}) {
  return withSyncRun("facebook.leads.poll", async () => {
    const c = await getPlatformCreds("facebook");
    if (!c.access_token) return { skipped: "Facebook access token not set", created: 0, seen: 0 };

    const windowDays =
      sinceDays ?? (await incrementalWindowDays("facebook.leads.poll", { overlapHours: 6, maxDays: 30 }));
    const sinceUnix = Math.floor((Date.now() - windowDays * 86_400_000) / 1000);

    const forms = await facebook.listLeadForms();
    // If specific forms are selected in Settings, poll exactly those (so recruiting /
    // non-customer forms are excluded). Otherwise default to all ACTIVE forms.
    const includedIds = await getSetting<string[]>(FB_INCLUDED_FORMS_KEY, []);
    const active = includedIds.length
      ? forms.filter((f) => includedIds.includes(f.id))
      : forms.filter((f) => f.status === "ACTIVE");

    let seen = 0;
    let created = 0;
    for (const form of active) {
      const leads = await facebook.listFormLeads(form.id, sinceUnix);
      for (const detail of leads) {
        seen++;
        try {
          if (await ingestFacebookLead(detail)) created++;
        } catch (err) {
          console.error("[fb leads] ingest failed", detail.leadgenId, err);
        }
      }
    }

    return {
      forms: active.length,
      totalForms: forms.length,
      seen,
      created,
      windowDays: Number(windowDays.toFixed(3)),
    };
  });
}
