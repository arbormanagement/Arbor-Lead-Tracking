import { env } from "@/lib/env";
import { syncSpend } from "@/lib/sync/spend";
import { syncHcp } from "@/lib/sync/hcp";
import { runAttribution } from "@/lib/sync/attribution";
import { syncTranscriptions } from "@/lib/sync/transcribe";
import { syncLsaLeads } from "@/lib/sync/lsa";
import { syncConversions } from "@/lib/sync/conversions";
import { syncFacebookLeads } from "@/lib/sync/facebook-leads";
import { releaseExpired } from "@/lib/dni/assign";
import { backfillVoiceFallback } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Scheduled job entrypoint for Vercel Cron (see vercel.json). GET so the platform
 * scheduler can hit it; secured by CRON_SECRET, which Vercel sends as
 * `Authorization: Bearer <CRON_SECRET>`. Dispatches to the same `lib/sync/*`
 * functions the admin "Run sync now" button uses — this is purely a scheduled door.
 */
export async function GET(req: Request, { params }: { params: Promise<{ job: string }> }) {
  const auth = req.headers.get("authorization");
  if (!env.CRON_SECRET || auth !== `Bearer ${env.CRON_SECRET}`) {
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
      case "hcp":
        return Response.json({ ok: true, job, result: await syncHcp() });
      case "spend":
        return Response.json({ ok: true, job, result: await syncSpend({ sinceDays: 7 }) });
      case "lsa":
        return Response.json({ ok: true, job, result: await syncLsaLeads({ sinceDays: 30 }) });
      case "attribution":
        return Response.json({ ok: true, job, result: await runAttribution({ windowDays: 90 }) });
      case "conversions":
        return Response.json({ ok: true, job, result: await syncConversions({ sinceDays: 60 }) });
      case "fbleads":
        return Response.json({ ok: true, job, result: await syncFacebookLeads() });
      case "twilio-fallback":
        // Self-healing: re-assert every tracking number's Twilio voice fallback
        // (outage protection) so no number can drift or be missed by a manual path.
        return Response.json({ ok: true, job, result: await backfillVoiceFallback() });
      // Convenience aggregates so a single daily cron can do the revenue→ROI chain.
      case "revenue": {
        const hcp = await syncHcp();
        const spend = await syncSpend({ sinceDays: 7 });
        const lsa = await syncLsaLeads({ sinceDays: 30 });
        const attribution = await runAttribution({ windowDays: 90 });
        const conversions = await syncConversions({ sinceDays: 60 });
        return Response.json({ ok: true, job, result: { hcp, spend, lsa, attribution, conversions } });
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
