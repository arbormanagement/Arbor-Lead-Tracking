import { releaseExpired } from "@/lib/dni/assign";
import { runAttribution } from "@/lib/sync/attribution";
import { syncMessageClassification } from "@/lib/sync/classify-messages";
import { syncConversions } from "@/lib/sync/conversions";
import { syncFacebookLeads } from "@/lib/sync/facebook-leads";
import { syncHcp } from "@/lib/sync/hcp";
import { syncHcpLineItems } from "@/lib/sync/hcp-line-items";
import { syncSpend } from "@/lib/sync/spend";
import { backfillCallThreads } from "@/lib/sync/thread-backfill";
import { syncTranscriptions } from "@/lib/sync/transcribe";
import { syncNumberWebhooks } from "@/lib/sync/twilio-webhooks";

/**
 * On-demand sync dispatch — shared by POST /api/sync/[job] and the MCP
 * `trigger_sync` tool, so the two cannot drift on what a job name means.
 *
 * `days` is an OPTIONAL explicit window for the jobs that support one (spend,
 * hcp, fbleads, and the whole `all` chain). Omit it for the defaults: each job
 * owns its own window policy (rolling re-pulls, cold-start backfill), and
 * passing a window short-circuits that policy — which is exactly how a
 * hardcoded 7-day spend window once silently disabled the 35-day re-pull.
 * The cron worker never passes one; a human doing a deliberate backfill may.
 */
// The job vocabulary lives with the client-safe contracts; re-exported here so
// sync-side consumers keep one import.
export { SYNC_JOBS } from "@/lib/api-contracts/tools";
export type { SyncJob } from "@/lib/api-contracts/tools";
import { SYNC_JOBS, type SyncJob } from "@/lib/api-contracts/tools";

export function isSyncJob(v: string): v is SyncJob {
  return (SYNC_JOBS as readonly string[]).includes(v);
}

export async function runSyncJob(job: SyncJob, days?: number): Promise<unknown> {
  switch (job) {
    case "spend":
      return syncSpend(days ? { sinceDays: days } : {});
    case "hcp":
      return syncHcp(days ? { sinceDays: days } : {});
    case "hcp-lineitems":
      // Deliberately NOT part of `all` and not folded into `hcp`. Line items are
      // one HCP request per job and per estimate OPTION — ~30.6k for the account's
      // history — so a hydration pass that ran long inside the hourly sync would
      // delay the hot zone the ROI numbers depend on. It owns its own schedule and
      // its own wall-clock budget instead. `days` means nothing here: the queue is
      // "what has never been read, or has changed since it was", not a window.
      return syncHcpLineItems();
    case "attribution":
      return runAttribution({ windowDays: 90 });
    case "reaper":
      await releaseExpired();
      return "released expired leases";
    case "twilio-fallback":
      // Re-assert every tracking number's Twilio webhooks: the voice fallback
      // (so calls still connect if the app is unreachable) and the SMS webhook.
      return syncNumberWebhooks();
    case "transcribe":
      return syncTranscriptions({ limit: 25 });
    case "classify-messages":
      return syncMessageClassification({ limit: 25 });
    case "thread-backfill":
      // One-shot (repeatable): file pre-inbox calls into conversation threads.
      // `more: true` in the result means run it again for the next batch.
      return backfillCallThreads();
    case "conversions":
      return syncConversions();
    case "fbleads":
      return syncFacebookLeads(days ? { sinceDays: days } : {});
    case "all": {
      // Ingest leads (fbleads) + revenue (hcp) BEFORE attribution so newly-pulled
      // leads/estimates get matched in the same run. `days` widens hcp, fbleads
      // AND spend for a historical backfill; attribution + conversions follow.
      const transcribe = await syncTranscriptions({ limit: 25 });
      const texts = await syncMessageClassification({ limit: 25 });
      const fbleads = await syncFacebookLeads(days ? { sinceDays: days } : {});
      const hcp = await syncHcp(days ? { sinceDays: days } : {});
      const spend = await syncSpend(days ? { sinceDays: days } : {});
      const attribution = await runAttribution({ windowDays: 90 });
      // No window override — syncConversions defaults to 90 days to match
      // Google's click lookback; 60 silently dropped leads whose estimate was
      // approved 60-90 days after the lead came in.
      const conversions = await syncConversions();
      return { transcribe, texts, fbleads, hcp, spend, attribution, conversions };
    }
  }
}
