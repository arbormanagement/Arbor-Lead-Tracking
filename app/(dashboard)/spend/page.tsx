import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { adSpend, adSpendAds, campaigns, facebookLeads, leads, manualSpend, roiDaily, sources, syncRuns } from "@/lib/db/schema";
import { dateTime, dollars } from "@/lib/format";
import { TIMEFRAMES, pickDays, timeframeLabel } from "@/lib/timeframes";
import { ManualSpend } from "./manual-spend";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";

const PLATFORM_LABEL: Record<string, string> = {
  google: "Google Ads",
  google_lsa: "Google Local Services",
  facebook: "Facebook / Instagram",
  other: "Other",
};

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

interface AdRow {
  platform: string;
  externalCampaignId: string | null;
  campaignName: string | null;
  externalAdId: string;
  adName: string | null;
  groupName: string | null;
  adStatus: string | null;
  thumb: string | null;
  title: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}

export default async function SpendPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams;
  const days = pickDays(daysParam, 30);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const sinceDate = new Date(Date.now() - days * 86_400_000);
  const label = timeframeLabel(days);

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

  // Spend by platform (from ad_spend) + total revenue (from roi_daily).
  const byPlatform = await db
    .select({
      platform: adSpend.platform,
      spend: sql<number>`coalesce(sum(${adSpend.spendCents}),0)::int`,
    })
    .from(adSpend)
    .where(gte(adSpend.date, since))
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

  // Individual ads (drill-down): aggregate per ad over the window; display
  // fields (name/status/creative) take the value from the most recent day.
  const latest = (col: unknown) => sql<string | null>`(array_agg(${col} order by ${adSpendAds.date} desc))[1]`;
  const adRows: AdRow[] = await db
    .select({
      platform: adSpendAds.platform,
      externalCampaignId: adSpendAds.externalCampaignId,
      campaignName: sql<string | null>`max(${campaigns.name})`,
      externalAdId: adSpendAds.externalAdId,
      adName: latest(adSpendAds.adName),
      groupName: latest(adSpendAds.groupName),
      adStatus: latest(adSpendAds.adStatus),
      thumb: latest(adSpendAds.creativeThumbUrl),
      title: latest(adSpendAds.creativeTitle),
      impressions: sql<number>`coalesce(sum(${adSpendAds.impressions}),0)::int`,
      clicks: sql<number>`coalesce(sum(${adSpendAds.clicks}),0)::int`,
      spend: sql<number>`coalesce(sum(${adSpendAds.spendCents}),0)::int`,
      conversions: sql<number>`coalesce(sum(${adSpendAds.conversions}),0)::float`,
    })
    .from(adSpendAds)
    .leftJoin(campaigns, eq(adSpendAds.campaignId, campaigns.id))
    .where(gte(adSpendAds.date, since))
    .groupBy(adSpendAds.platform, adSpendAds.externalCampaignId, adSpendAds.externalAdId)
    .orderBy(desc(sql`coalesce(sum(${adSpendAds.spendCents}),0)`));

  // Captured leads per Facebook ad — lead-gen submissions carry the ad id, so
  // the FB drill-down can show real leads/won/revenue per individual ad.
  const fbAdLeads = await db
    .select({
      adId: facebookLeads.fbAdId,
      leads: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
      revenue: sql<number>`coalesce(sum(${leads.salesValueCents}) filter (where ${leads.status} = 'won'),0)::int`,
    })
    .from(facebookLeads)
    .leftJoin(leads, eq(facebookLeads.leadId, leads.id))
    .where(and(isNotNull(facebookLeads.fbAdId), gte(facebookLeads.createdTime, sinceDate)))
    .groupBy(facebookLeads.fbAdId);
  const fbLeadsByAd = new Map(fbAdLeads.map((r) => [r.adId, r]));

  // Group platform → campaign for the drill-down (already spend-sorted).
  const platforms = new Map<string, Map<string, { name: string; ads: AdRow[] }>>();
  for (const r of adRows) {
    const byCampaign = platforms.get(r.platform) ?? new Map<string, { name: string; ads: AdRow[] }>();
    const key = r.externalCampaignId ?? "—";
    const c = byCampaign.get(key) ?? { name: r.campaignName ?? `Campaign ${key}`, ads: [] };
    c.ads.push(r);
    byCampaign.set(key, c);
    platforms.set(r.platform, byCampaign);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Data &amp; sync</h1>
          <p className="page-sub">Run and monitor the data sync (HousecallPro revenue + Google/Facebook spend → ROI). Spend performance lives on Sources.</p>
        </div>
        <div className="controls">
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>◷</span>
          {TIMEFRAMES.map((t) => (
            <Link
              key={t.days}
              href={t.days === 30 ? "/spend" : `/spend?days=${t.days}`}
              className="pill"
              style={days === t.days ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" } : undefined}
            >
              {t.label}
            </Link>
          ))}
          <SyncButton />
        </div>
      </div>

      <div className="cards">
        <div className="card kpi"><div className="label">◐ Ad spend · {label}</div><div className="value mono">{dollars(spend)}</div></div>
        <div className="card kpi"><div className="label">◈ Revenue (won est.)</div><div className="value mono">{dollars(revenue)}</div></div>
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
                <th style={{ textAlign: "right" }}>Spend ({label})</th>
              </tr>
            </thead>
            <tbody>
              {byPlatform.map((p) => (
                <tr key={p.platform}>
                  <td style={{ fontWeight: 600 }}>{PLATFORM_LABEL[p.platform] ?? p.platform}</td>
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

      <h2 className="page-title" style={{ fontSize: 15 }}>Individual ads</h2>
      <p className="page-sub" style={{ marginBottom: 14 }}>
        Per-ad performance ({label}) — expand a campaign to see its ads. Facebook rows include captured
        leads per ad; Google LSA and Performance Max report at campaign level only.
      </p>
      {adRows.length === 0 ? (
        <div className="empty" style={{ marginBottom: 24 }}>
          No ad-level data yet — populates on the next spend sync (Google search ads + Facebook ads with creative previews).
        </div>
      ) : (
        [...platforms.entries()].map(([platform, byCampaign]) => (
          <div key={platform} style={{ marginBottom: 20 }}>
            <h3 style={{ fontSize: 13.5, margin: "0 0 8px", opacity: 0.85 }}>{PLATFORM_LABEL[platform] ?? platform}</h3>
            {[...byCampaign.entries()].map(([campaignKey, c]) => {
              const ctot = c.ads.reduce(
                (a, r) => ({ spend: a.spend + r.spend, clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions }),
                { spend: 0, clicks: 0, impressions: 0 },
              );
              const isFb = platform === "facebook";
              return (
                <details key={campaignKey} className="card" style={{ marginBottom: 8, padding: 0 }}>
                  <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", listStyle: "none" }}>
                    <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{c.ads.length} {c.ads.length === 1 ? "ad" : "ads"}</span>
                    <span className="mono muted" style={{ fontSize: 12 }}>{ctot.clicks.toLocaleString()} clicks</span>
                    <span className="mono" style={{ fontWeight: 700 }}>{dollars(ctot.spend)}</span>
                  </summary>
                  <div className="table-scroll">
                    <table style={{ border: "none", borderRadius: 0 }}>
                      <thead>
                        <tr>
                          <th>Ad</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Impr.</th>
                          <th style={{ textAlign: "right" }}>Clicks</th>
                          <th style={{ textAlign: "right" }} title="Cost per click">CPC</th>
                          <th style={{ textAlign: "right" }} title="Platform-reported conversions">Conv.</th>
                          {isFb && <th style={{ textAlign: "right" }} title="Lead-gen submissions captured from this ad">Leads</th>}
                          {isFb && <th style={{ textAlign: "right" }} title="Won-estimate revenue from this ad's leads">Revenue</th>}
                          <th style={{ textAlign: "right" }}>Spend</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.ads.map((ad) => {
                          const fb = isFb ? fbLeadsByAd.get(ad.externalAdId) : undefined;
                          const cpc = ad.clicks > 0 ? dollars(Math.round(ad.spend / ad.clicks)) : "—";
                          const paused = ad.adStatus && !["ENABLED", "ACTIVE"].includes(ad.adStatus);
                          return (
                            <tr key={ad.externalAdId}>
                              <td style={{ maxWidth: 340 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                                  {ad.thumb && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={ad.thumb} alt="" width={32} height={32} style={{ borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
                                  )}
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ad.title ?? ad.adName ?? undefined}>
                                      {ad.adName ?? `Ad ${ad.externalAdId}`}
                                    </div>
                                    {ad.groupName && (
                                      <div className="muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ad.groupName}</div>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td>{ad.adStatus ? <span className={paused ? "badge" : "badge win"} style={{ fontSize: 10.5 }}>{ad.adStatus.toLowerCase()}</span> : <span className="muted">—</span>}</td>
                              <td className="mono muted" style={{ textAlign: "right" }}>{ad.impressions.toLocaleString()}</td>
                              <td className="mono" style={{ textAlign: "right" }}>{ad.clicks.toLocaleString()}</td>
                              <td className="mono muted" style={{ textAlign: "right" }}>{cpc}</td>
                              <td className="mono muted" style={{ textAlign: "right" }}>{ad.conversions ? ad.conversions.toFixed(1) : "—"}</td>
                              {isFb && <td className="mono" style={{ textAlign: "right" }}>{fb?.leads ?? 0}</td>}
                              {isFb && (
                                <td className="mono" style={{ textAlign: "right" }}>
                                  {fb && fb.revenue > 0 ? dollars(fb.revenue) : <span className="muted">—</span>}
                                </td>
                              )}
                              <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{dollars(ad.spend)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
          </div>
        ))
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
