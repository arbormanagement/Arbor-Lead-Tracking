import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, conversations, leads, sources } from "@/lib/db/schema";

/**
 * Correct ONE lead's source and/or campaign by hand — the enquiry, not the person.
 * Shared by PATCH /api/leads/[id]/attribution and the MCP `arbor_set_lead_attribution`
 * tool, per the Phase 3 rule that a write tool mirrors a route and both wrap one
 * function.
 *
 * Why this exists: attribution is DERIVED — classified once at ingest and repaired only
 * by narrow, self-limiting passes — and until 2026-09-05 there was no way to correct a
 * single row at all. A $7,705 estimate filed under "Other / Unmapped" by a transposed
 * GBP tag needed a classifier change and a deploy to move, and its listing needed a
 * second deploy. The app's premise is that this kind of correction goes through the
 * tool layer, so here it is.
 *
 * Rules, all enforced here rather than trusted to the caller:
 *   • Never mints. `sourceKey` must be an existing `sources.key` and `campaignId` an
 *     existing `campaigns.id` — the same rule `resolveCampaignId` lives by.
 *   • A campaign belongs to a source. If the RESULTING source and campaign disagree
 *     (an O'Fallon listing on a google/cpc lead) the write is refused.
 *   • The row is stamped `attribution_set_manually_at`, and every automated writer of
 *     these columns skips stamped rows. Without that, the seed's campaign-repair pass —
 *     which rewrites any campaign disagreeing with a numeric `gad_campaignid` in the URL
 *     — would undo a correction on the next deploy with nothing on screen saying which
 *     value was live. `manual: false` releases the lock and changes nothing else.
 *   • `medium` is left alone: nothing but the raw lead list reads it, and inventing
 *     one per source key would be a second classifier.
 *
 * Does NOT rebuild `roi_daily`. That is `runAttribution`'s job, on its hourly tick or
 * via the `attribution` sync — the caller is told so in the result.
 */
export interface AttributionPatch {
  /** `sources.key` — google/cpc, gbp, direct, … Must already exist. */
  sourceKey?: string;
  /** `campaigns.id`. `null` clears the campaign. Must already exist. */
  campaignId?: string | null;
  /** Why. Stored on the lead, so the next reader knows a human decided this. */
  note?: string | null;
  /** Default true. `false` releases the manual lock without touching the values. */
  manual?: boolean;
}

export type SetLeadAttributionResult =
  | {
      ok: true;
      lead: {
        id: string;
        sourceKey: string | null;
        campaignId: string | null;
        campaignName: string | null;
        attributionSetManuallyAt: Date | null;
        attributionManualNote: string | null;
      };
      /** What has to happen before /sources reflects this. */
      nextStep: string;
    }
  | {
      ok: false;
      reason: "not_found" | "nothing_to_set" | "unknown_source" | "unknown_campaign" | "campaign_source_mismatch";
      error: string;
      nextStep: string;
    };

const REBUILD_NOTE =
  "roi_daily is rebuilt from leads by the `attribution` sync (hourly, or now via arbor_trigger_sync / POST /api/sync/attribution); /sources and /estimates do not move until it runs.";

export async function setLeadAttribution(id: string, patch: AttributionPatch): Promise<SetLeadAttributionResult> {
  const manual = patch.manual ?? true;
  const touchesValues = patch.sourceKey !== undefined || patch.campaignId !== undefined;
  if (!touchesValues && manual) {
    return {
      ok: false,
      reason: "nothing_to_set",
      error: "Nothing to set: pass sourceKey and/or campaignId, or manual:false to release the lock.",
      nextStep: "Source keys come from arbor_roi_summary rows; campaign ids from arbor_list_campaigns.",
    };
  }

  const [lead] = await db
    .select({ id: leads.id, sourceId: leads.sourceId, campaignId: leads.campaignId, conversationId: leads.conversationId })
    .from(leads)
    .where(eq(leads.id, id))
    .limit(1);
  if (!lead) {
    return {
      ok: false,
      reason: "not_found",
      error: `No lead with id '${id}'.`,
      nextStep: "Lead ids come from arbor_list_leads, or from arbor_get_thread's `enquiries` array. A lead id is not an estimate id.",
    };
  }

  // Resolve the RESULTING source and campaign, then check they agree.
  let sourceId = lead.sourceId;
  if (patch.sourceKey !== undefined) {
    const [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, patch.sourceKey)).limit(1);
    if (!src) {
      return {
        ok: false,
        reason: "unknown_source",
        error: `No source with key '${patch.sourceKey}'. This never mints a source.`,
        nextStep: "Use a key from arbor_roi_summary (e.g. google/cpc, gbp, google/lsa, facebook/paid, organic/seo, direct, email/newsletter).",
      };
    }
    sourceId = src.id;
  }

  let campaignId = lead.campaignId;
  if (patch.campaignId !== undefined) campaignId = patch.campaignId;
  let campaignName: string | null = null;
  if (campaignId) {
    const [c] = await db
      .select({ id: campaigns.id, name: campaigns.name, sourceId: campaigns.sourceId })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    if (!c) {
      return {
        ok: false,
        reason: "unknown_campaign",
        error: `No campaign with id '${campaignId}'. This never mints a campaign.`,
        nextStep: "Campaign ids come from arbor_list_campaigns (the `id` field, not external_campaign_id).",
      };
    }
    if (sourceId && c.sourceId && c.sourceId !== sourceId) {
      const [srcRow] = await db.select({ key: sources.key }).from(sources).where(eq(sources.id, sourceId)).limit(1);
      const [campSrc] = await db.select({ key: sources.key }).from(sources).where(eq(sources.id, c.sourceId)).limit(1);
      return {
        ok: false,
        reason: "campaign_source_mismatch",
        error: `Campaign '${c.name ?? c.id}' belongs to source '${campSrc?.key ?? c.sourceId}', but the lead's source would be '${srcRow?.key ?? sourceId}'.`,
        nextStep: "Set sourceKey to the campaign's source in the same call, pick a campaign under the lead's source, or pass campaignId:null.",
      };
    }
    campaignName = c.name;
  }

  const [row] = await db
    .update(leads)
    .set({
      ...(patch.sourceKey !== undefined ? { sourceId } : {}),
      ...(patch.campaignId !== undefined ? { campaignId } : {}),
      attributionSetManuallyAt: manual ? new Date() : null,
      ...(patch.note !== undefined ? { attributionManualNote: patch.note } : manual ? {} : { attributionManualNote: null }),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id))
    .returning({
      id: leads.id,
      sourceId: leads.sourceId,
      campaignId: leads.campaignId,
      attributionSetManuallyAt: leads.attributionSetManuallyAt,
      attributionManualNote: leads.attributionManualNote,
    });

  // The thread's `source_id` is a first-touch SNAPSHOT taken from its first lead and
  // filled only when NULL, so a correction to that lead leaves the inbox saying the
  // old channel forever (the Garber thread read "Other / Unmapped" for a day after
  // its lead was moved to gbp). Follow the correction exactly where the snapshot came
  // from this lead — matched on the OLD source, so a thread whose snapshot was taken
  // from a different, earlier enquiry is left alone.
  if (patch.sourceKey !== undefined && lead.conversationId && sourceId !== lead.sourceId) {
    await db
      .update(conversations)
      .set({ sourceId })
      .where(and(eq(conversations.id, lead.conversationId), sql`${conversations.sourceId} IS NOT DISTINCT FROM ${lead.sourceId}`));
  }

  const [srcOut] = row.sourceId
    ? await db.select({ key: sources.key }).from(sources).where(eq(sources.id, row.sourceId)).limit(1)
    : [null];
  if (row.campaignId && campaignName === null) {
    const [c] = await db.select({ name: campaigns.name }).from(campaigns).where(and(eq(campaigns.id, row.campaignId))).limit(1);
    campaignName = c?.name ?? null;
  }

  return {
    ok: true,
    lead: {
      id: row.id,
      sourceKey: srcOut?.key ?? null,
      campaignId: row.campaignId,
      campaignName: row.campaignId ? campaignName : null,
      attributionSetManuallyAt: row.attributionSetManuallyAt,
      attributionManualNote: row.attributionManualNote,
    },
    nextStep: REBUILD_NOTE,
  };
}
