import { facebook } from "@/lib/integrations/facebook";
import { getPlatformCreds } from "@/lib/credentials";
import { ingestFacebookLead } from "@/lib/facebook/ingest";
import { getSetting, setSetting } from "@/lib/settings";
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

    // maxDays 365: the cap bounds outage recovery — a longer-than-cap gap would
    // silently lose leads. Deep windows are cheap (server-side time_created filter).
    const windowDays =
      sinceDays ?? (await incrementalWindowDays("facebook.leads.poll", { overlapHours: 6, maxDays: 365 }));
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
    let excluded = 0;
    let deferred = 0;
    let failed = 0;
    for (const form of active) {
      const leads = await facebook.listFormLeads(form.id, sinceUnix);
      for (const detail of leads) {
        seen++;
        try {
          const result = await ingestFacebookLead(detail);
          if (result === "created") created++;
          else if (result === "excluded") excluded++;
          else if (result === "deferred") deferred++;
        } catch (err) {
          failed++;
          console.error("[fb leads] ingest failed", detail.leadgenId, err);
        }
      }
    }

    // A dropped lead must hold the watermark: fail the run so the next tick
    // re-pulls the same window. Everything already ingested is deduped on
    // fb_leadgen_id, so the retry is safe.
    //
    // Deferrals count the same way. A deferred submission has not been ingested,
    // so letting the watermark advance past it would lose it outright — the whole
    // point of deferring is that a later run gets to decide with a working
    // campaign lookup.
    if (failed > 0 || deferred > 0) {
      throw new Error(
        `${failed} failed + ${deferred} deferred of ${seen} leads (${created} created) — watermark held`,
      );
    }

    return {
      forms: active.length,
      totalForms: forms.length,
      seen,
      created,
      // Submissions dropped because their campaign is flagged non-customer-acquisition.
      excluded,
      windowDays: Number(windowDays.toFixed(3)),
    };
  });
}

/** The lead forms currently polled. Empty = every ACTIVE form is allowed, which is
 *  NOT the same as none — see planLeadCleanup, where confusing the two would delete
 *  every Facebook lead on file. */
export async function getIncludedFormIds(): Promise<string[]> {
  return getSetting<string[]>(FB_INCLUDED_FORMS_KEY, []);
}

/** Replace the polled-form selection. An empty list restores "all active forms". */
export async function setIncludedFormIds(formIds: string[]): Promise<void> {
  await setSetting(FB_INCLUDED_FORMS_KEY, formIds.length ? formIds : null);
}
