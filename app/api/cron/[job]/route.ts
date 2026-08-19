import { env } from "@/lib/env";
import { secretEquals } from "@/lib/secret-compare";
import { syncSpend } from "@/lib/sync/spend";
import { syncHcp } from "@/lib/sync/hcp";
import { runAttribution } from "@/lib/sync/attribution";
import { syncTranscriptions } from "@/lib/sync/transcribe";
import { syncMessageClassification } from "@/lib/sync/classify-messages";
import { backfillCallThreads } from "@/lib/sync/thread-backfill";
import { syncConversions } from "@/lib/sync/conversions";
import { syncFacebookLeads } from "@/lib/sync/facebook-leads";
import { releaseExpired } from "@/lib/dni/assign";
import { syncNumberWebhooks } from "@/lib/sync/twilio-webhooks";
import { runDniCanary } from "@/lib/sync/dni-canary";

export const runtime = "nodejs";

/**
 * Scheduled job entrypoint for the `cron` Railway service (see scripts/cron.ts).
 * GET so the scheduler can hit it; secured by CRON_SECRET, sent as
 * `Authorization: Bearer <CRON_SECRET>`. Dispatches to the same `lib/sync/*`
 * functions the admin "Run sync now" button uses — this is purely a scheduled door.
 *
 * Jobs are called WITHOUT window overrides on purpose. Each sync owns its own
 * window policy (spend: 35d rolling + cold-start backfill; conversions: 90d to
 * match Google's click lookback), and passing an explicit `sinceDays` here
 * short-circuits that self-healing. Only pass one to deliberately narrow a run.
 */
export async function GET(req: Request, { params }: { params: Promise<{ job: string }> }) {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || !secretEquals(auth, `Bearer ${env.CRON_SECRET}`)) {
    return new Response("unauthorized", { status: 401 });
  }

  const { job } = await params;
  try {
    switch (job) {
      case "reaper":
        await releaseExpired();
        return Response.json({ ok: true, job, result: "released expired leases" });
      case "transcribe":
        return Response.json({ ok: true, job, result: await syncTranscriptions({ limit: 25 }) });
      case "classify-messages":
        return Response.json({ ok: true, job, result: await syncMessageClassification({ limit: 25 }) });
      case "thread-backfill":
        // Both the history backfill and the ongoing repair path: threading in the
        // /voice hot path is best-effort (it must never cost a forward), so any
        // call that missed its thread is picked up here on the next tick.
        return Response.json({ ok: true, job, result: await backfillCallThreads() });
      case "hcp":
        return Response.json({ ok: true, job, result: await syncHcp() });
      case "spend":
        return Response.json({ ok: true, job, result: await syncSpend() });
      case "attribution":
        return Response.json({ ok: true, job, result: await runAttribution({ windowDays: 90 }) });
      case "conversions":
        return Response.json({ ok: true, job, result: await syncConversions() });
      case "fbleads":
        return Response.json({ ok: true, job, result: await syncFacebookLeads() });
      case "dni-canary":
        // Synthetic check that the number swap still works end to end. Deliberately
        // NOT folded into `reaper` or any other DNI job: a canary that shares a run
        // with real work reports that work's failures as its own.
        return Response.json({ ok: true, job, result: await runDniCanary() });
      case "twilio-fallback":
        // Self-healing: re-assert every tracking number's Twilio webhooks — voice
        // fallback (outage protection) and inbound SMS — so no number can drift or
        // be missed by a manual path.
        return Response.json({ ok: true, job, result: await syncNumberWebhooks() });
      // Convenience aggregates so a single daily cron can do the revenue→ROI chain.
      case "revenue": {
        const hcp = await syncHcp();
        const spend = await syncSpend();
        const attribution = await runAttribution({ windowDays: 90 });
        const conversions = await syncConversions();
        return Response.json({ ok: true, job, result: { hcp, spend, attribution, conversions } });
      }
      default:
        return Response.json({ error: `unknown job '${job}'` }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { ok: false, job, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
