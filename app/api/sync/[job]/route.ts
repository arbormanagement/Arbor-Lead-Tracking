import { getSession } from "@/lib/auth";
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
 * Admin-triggered sync: POST /api/sync/spend or /api/sync/hcp. Lets us run a
 * sync on demand from the dashboard before the Inngest cron schedule is wired up
 * at deploy time. Gated to an authenticated admin session.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ job: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { job } = await params;
  // Optional full-backfill override: ?days=N forces an explicit window on the jobs
  // that support it (spend, hcp, fbleads — and the whole `all` chain). Omit for the
  // default incremental pull. Spend defaults to a rolling 7-day re-pull (platforms
  // restate); a backfill only heals history, day-to-day gaps self-heal.
  const daysParam = Number(new URL(_req.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : undefined;
  try {
    switch (job) {
      case "spend":
        return Response.json({ ok: true, result: await syncSpend(days ? { sinceDays: days } : {}) });
      case "hcp":
        return Response.json({ ok: true, result: await syncHcp(days ? { sinceDays: days } : {}) });
      case "attribution":
        return Response.json({ ok: true, result: await runAttribution({ windowDays: 90 }) });
      case "reaper":
        await releaseExpired();
        return Response.json({ ok: true, result: "released expired leases" });
      case "twilio-fallback":
        // Point every tracking number's Twilio voice fallback at its forward
        // destination, so calls still connect if the app is ever unreachable.
        return Response.json({ ok: true, result: await backfillVoiceFallback() });
      case "transcribe":
        return Response.json({ ok: true, result: await syncTranscriptions({ limit: 25 }) });
      case "lsa":
        return Response.json({ ok: true, result: await syncLsaLeads({ sinceDays: 30 }) });
      case "conversions":
        return Response.json({ ok: true, result: await syncConversions({ sinceDays: 60 }) });
      case "fbleads":
        return Response.json({ ok: true, result: await syncFacebookLeads(days ? { sinceDays: days } : {}) });
      case "all": {
        // Ingest leads (fbleads) + revenue (hcp) BEFORE attribution so newly-pulled
        // leads/estimates get matched in the same run. `?days=N` widens hcp, fbleads
        // AND spend for a historical backfill; attribution + conversions follow.
        const transcribe = await syncTranscriptions({ limit: 25 });
        const lsa = await syncLsaLeads({ sinceDays: 30 });
        const fbleads = await syncFacebookLeads(days ? { sinceDays: days } : {});
        const hcp = await syncHcp(days ? { sinceDays: days } : {});
        const spend = await syncSpend(days ? { sinceDays: days } : {});
        const attribution = await runAttribution({ windowDays: 90 });
        const conversions = await syncConversions({ sinceDays: 60 });
        return Response.json({ ok: true, result: { transcribe, lsa, fbleads, hcp, spend, attribution, conversions } });
      }
      default:
        return Response.json({ error: `unknown job '${job}'` }, { status: 400 });
    }
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
