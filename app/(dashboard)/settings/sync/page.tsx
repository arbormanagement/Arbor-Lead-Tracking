import { and, desc, eq, gte, sql } from "drizzle-orm";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { adSpend, manualSpend, roiDaily, sources, syncRuns } from "@/lib/db/schema";
import { dateTime, dollars, wholeDollars } from "@/lib/format";
import { ManualSpend } from "./manual-spend";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

function summarizeStats(stats: unknown): string {
  if (!stats || typeof stats !== "object") return "";
  return Object.entries(stats as Record<string, unknown>)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ")
    .slice(0, 240);
}

function runClass(status: string): string {
  if (status === "success" || status === "ok" || status === "completed") return "badge win";
  if (status === "error" || status === "failed") return "badge bad";
  if (status === "running") return "badge warn";
  return "badge";
}

export default async function SpendPage() {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(20);

  const sourceRows = await db
    .select({ id: sources.id, name: sources.displayName, key: sources.key })
    .from(sources)
    .orderBy(sources.key);
  const manualRows = await db
    .select({
      sourceId: manualSpend.sourceId,
      sourceName: sources.displayName,
      month: manualSpend.month,
      amountCents: manualSpend.amountCents,
    })
    .from(manualSpend)
    .leftJoin(sources, eq(manualSpend.sourceId, sources.id))
    .orderBy(desc(manualSpend.month))
    .limit(24);

  // 30-day spend by platform (from ad_spend) + total revenue (from roi_daily).
  // Recruiting/brand campaigns are excluded here for the same reason they are
  // excluded from roi_daily: the ROAS below is computed from roi_daily (which
  // filters them), so counting them in this table would put two spend figures
  // that disagree on one page. Their rows stay in ad_spend as history — the
  // exclusion is applied when reading, never by refusing to record.
  const excludedIds = await excludedCampaignIds();
  const byPlatform = await db
    .select({
      platform: adSpend.platform,
      spend: sql<number>`coalesce(sum(${adSpend.spendCents}),0)::int`,
    })
    .from(adSpend)
    .where(and(gte(adSpend.date, since), campaignNotExcluded(adSpend.campaignId, excludedIds)))
    .groupBy(adSpend.platform)
    .orderBy(desc(sql`coalesce(sum(${adSpend.spendCents}),0)`));

  const [tot] = await db
    .select({
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .where(gte(roiDaily.date, since));

  const spend = tot?.spend ?? 0;
  const revenue = tot?.revenue ?? 0;
  const roas = spend > 0 ? (revenue / spend).toFixed(1) + "×" : "—";

  return (
    <>
      <a href="/settings" className="backlink">← Settings</a>
      <div className="page-head">
        <div>
          <h1 className="page-title">Data &amp; sync</h1>
          <p className="page-sub">Run and monitor the data sync (HousecallPro revenue + Google/Facebook spend → ROI). Spend performance lives on Sources.</p>
        </div>
        <div className="controls">
          <SyncButton />
        </div>
      </div>

      <div className="cards">
        <div className="card kpi"><div className="label">◐ Ad spend (30d)</div><div className="value mono">{wholeDollars(spend)}</div></div>
        <div className="card kpi"><div className="label">◈ Revenue (won est.)</div><div className="value mono">{wholeDollars(revenue)}</div></div>
        <div className="card kpi accent"><div className="label">✦ ROAS</div><div className="value mono pos">{roas}</div></div>
      </div>

      <ManualSpend
        sources={sourceRows.map((s) => ({ id: s.id, name: s.name ?? s.key }))}
        rows={manualRows.map((r) => ({ ...r, sourceName: r.sourceName ?? "—" }))}
      />

      {byPlatform.length > 0 && (
        <>
          <h2 className="page-title" style={{ fontSize: 15, marginTop: 8 }}>Spend by platform</h2>
          <table style={{ marginBottom: 24 }}>
            <thead>
              <tr>
                <th>Platform</th>
                <th style={{ textAlign: "right" }}>Spend (30d)</th>
              </tr>
            </thead>
            <tbody>
              {byPlatform.map((p) => (
                <tr key={p.platform}>
                  <td style={{ fontWeight: 600, textTransform: "capitalize" }}>{p.platform}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{dollars(p.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {byPlatform.length === 0 && (
        <div className="empty" style={{ marginBottom: 24 }}>
          No spend recorded yet. Runs HCP → spend → attribution directly against each platform
          API (only providers with configured credentials run). Add credentials in{" "}
          <code>Settings → Integrations</code>: HousecallPro to light up revenue, then
          Google/Facebook tokens for spend &amp; ROI. Cron is wired at deploy.
        </div>
      )}

      <h2 className="page-title" style={{ fontSize: 15 }}>Recent sync runs</h2>
      {runs.length === 0 ? (
        <div className="empty">No sync runs recorded yet.</div>
      ) : (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Started</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={{ fontWeight: 600 }}>{r.job}</td>
                <td><span className={runClass(r.status)}>{r.status}</span></td>
                <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{dateTime(r.startedAt)}</td>
                <td style={{ maxWidth: 480 }}>
                  {r.error ? (
                    <span style={{ color: "var(--danger)", fontSize: 12 }}>{r.error}</span>
                  ) : r.stats ? (
                    <span className="muted mono" style={{ fontSize: 11.5 }}>{summarizeStats(r.stats)}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}
