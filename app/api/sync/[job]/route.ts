import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { isSyncJob, runSyncJob } from "@/lib/sync/run-job";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Admin-triggered sync: POST /api/sync/spend or /api/sync/hcp. Lets us run a
 * sync on demand from the dashboard, independent of the cron worker's schedule.
 * Gated to an admin session cookie or the machine token (see authorizeAdmin).
 *
 * The dispatch lives in lib/sync/run-job.ts, shared with the MCP `trigger_sync`
 * tool. `?days=N` forces an explicit window on the jobs that support it — see
 * the note there for why omitting it is usually right.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ job: string }> }) {
  // Session cookie OR `Authorization: Bearer $ADMIN_API_TOKEN`, matching
  // /api/diagnostics and /api/numbers/pool. Session-only meant a deliberate
  // backfill (`?days=N`) could only be started from a browser, while the very
  // same work was already reachable headlessly through /api/cron with
  // CRON_SECRET — so this widens no capability that did not already exist, it
  // just makes the windowed variant reachable the same way.
  const auth = await authorizeAdmin(_req);
  if (!auth.ok) return unauthorized();

  const { job } = await params;
  if (!isSyncJob(job)) return Response.json({ error: `unknown job '${job}'` }, { status: 400 });

  const daysParam = Number(new URL(_req.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.floor(daysParam) : undefined;
  try {
    return Response.json({ ok: true, result: await runSyncJob(job, days) });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
