import { getSession } from "@/lib/auth";
import { syncSpend } from "@/lib/sync/spend";
import { syncHcp } from "@/lib/sync/hcp";
import { runAttribution } from "@/lib/sync/attribution";
import { syncTranscriptions } from "@/lib/sync/transcribe";
import { syncLsaLeads } from "@/lib/sync/lsa";
import { syncConversions } from "@/lib/sync/conversions";
import { syncFacebookLeads } from "@/lib/sync/facebook-leads";
import { releaseExpired } from "@/lib/dni/assign";

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
  // Optional full-backfill override: POST /api/sync/hcp?days=30 forces an explicit
  // window (bypasses the incremental watermark). Omit for the default incremental pull.
  const daysParam = new URL(_req.url).searchParams.get("days");
  const hcpDays = daysParam ? Number(daysParam) : undefined;
  try {
    switch (job) {
      case "spend":
        return Response.json({ ok: true, result: await syncSpend({ sinceDays: 7 }) });
      case "hcp":
        return Response.json({ ok: true, result: await syncHcp(hcpDays ? { sinceDays: hcpDays } : {}) });
      case "attribution":
        return Response.json({ ok: true, result: await runAttribution({ windowDays: 90 }) });
      case "reaper":
        await releaseExpired();
        return Response.json({ ok: true, result: "released expired leases" });
      case "transcribe":
        return Response.json({ ok: true, result: await syncTranscriptions({ limit: 25 }) });
      case "lsa":
        return Response.json({ ok: true, result: await syncLsaLeads({ sinceDays: 30 }) });
      case "conversions":
        return Response.json({ ok: true, result: await syncConversions({ sinceDays: 60 }) });
      case "fbleads":
        return Response.json({ ok: true, result: await syncFacebookLeads(daysParam ? { sinceDays: Number(daysParam) } : {}) });
      case "all": {
        // Ingest leads (fbleads) + revenue (hcp) BEFORE attribution so newly-pulled
        // leads/estimates get matched in the same run. `?days=N` widens hcp + fbleads
        // for a historical backfill; attribution + conversions follow.
        const transcribe = await syncTranscriptions({ limit: 25 });
        const lsa = await syncLsaLeads({ sinceDays: 30 });
        const fbleads = await syncFacebookLeads(daysParam ? { sinceDays: Number(daysParam) } : {});
        const hcp = await syncHcp(hcpDays ? { sinceDays: hcpDays } : {});
        const spend = await syncSpend({ sinceDays: 7 });
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
