import { sql } from "drizzle-orm";
import { env } from "@/lib/env";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * Secret-gated debug: return the raw HCP payload for a few synced estimates so we
 * can see exactly how HCP represents approval ("won") on the real account and fix
 * the mapping. `q` filters by any text in the raw JSON (e.g. a phone or last name).
 * Also reports how many estimates we currently flag won. Temporary — remove after.
 *
 *   GET /api/admin/hcp-sample?secret=<CRON_SECRET>&q=741-3530
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const q = url.searchParams.get("q");

  try {
    const totals = await db.execute(
      sql`select count(*)::int as total, count(*) filter (where won)::int as won,
                 coalesce(sum(approved_amount_cents) filter (where won),0)::int as won_value_cents
          from hcp_estimates`,
    );
    const totalsRow = (totals as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0] ?? {};

    const sampleRes = q
      ? await db.execute(
          sql`select status, won, approved_amount_cents, total_amount_cents, created_at_hcp, approved_at_hcp, raw
              from hcp_estimates where raw::text ilike ${"%" + q + "%"} limit 3`,
        )
      : await db.execute(
          sql`select status, won, approved_amount_cents, total_amount_cents, created_at_hcp, approved_at_hcp, raw
              from hcp_estimates order by created_at_hcp desc nulls last limit 3`,
        );
    const samples = (sampleRes as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];

    return Response.json({ ok: true, totals: totalsRow, samples });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
