import { backfillNumberWebhooks } from "@/lib/twilio/numbers";
import { withSyncRun } from "./run";

/**
 * twilio.webhooks.backfill — the SCHEDULED door onto `backfillNumberWebhooks`,
 * which re-asserts every active number's voice fallback and inbound SMS webhook
 * in Twilio once an hour so a number's config cannot drift.
 *
 * This job had no health signal at all. It writes nothing to the database, so
 * `sync_runs` never saw it and /api/diagnostics could not list it — the one job
 * responsible for "a text reaches the app" and "a call still connects while the
 * app is redeploying" was the one job nobody could tell had stopped. Its
 * per-number failures were already computed and then thrown away into the cron
 * worker's stdout.
 *
 * The wrapper lives here rather than inside `backfillNumberWebhooks` because
 * Settings → Routing calls that function directly when the forward destination
 * changes. Wrapping the function itself would put that call under this job's
 * one-run-at-a-time claim, so saving a routing change while the hourly tick
 * happened to be running would return `{skipped:true}` and never reach Twilio —
 * the settings page would report success having changed nothing. A scheduled run
 * is what needs serializing and recording; a user-initiated write is not.
 */
export async function syncNumberWebhooks() {
  return withSyncRun("twilio.webhooks.backfill", async () => backfillNumberWebhooks());
}
