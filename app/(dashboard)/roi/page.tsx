import { and, desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { selectedTouchModel, touchModelLabel } from "@/lib/attribution/model";
import { db } from "@/lib/db/client";
import { campaigns, roiDaily, sources } from "@/lib/db/schema";
import { dollars } from "@/lib/format";
import { TIMEFRAMES, pickDays, timeframeLabel } from "@/lib/timeframes";
import { businessDate } from "@/lib/tz";

export const dynamic = "force-dynamic";

/**
 * Campaign-level ROI.
 *
 * `roi_daily` has been keyed on campaign since it was built — every figure on this
 * page was already stored and simply never read, because all three of its readers
 * grouped by source and summed the campaigns away. So this is a display over
 * existing data, not a new measurement.
 *
 * Campaign is deliberately the FLOOR of this app's money reporting. It is the unit
 * budget actually moves between, and it is the level every ad platform reports
 * spend at. Below it — ad group, keyword, ad, landing page — the sample collapses:
 * at roughly 60 won estimates a quarter across four channels, an ad-group ROAS is a
 * random number wearing a decimal point. Adding those splits would make the page
 * look more rigorous and tell you less.
 *
 * Recruiting campaigns need no filtering here. `rebuildRoiDaily` already applies
 * `campaignNotExcluded` to both the lead pass and the spend pass, so they never
 * reach these rows.
 */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysParam } = await searchParams;
  const days = pickDays(daysParam, 30);
  // `roi_daily.date` is a BUSINESS date (America/Chicago), so its window edge must
  // be one too — a UTC calendar date is a day ahead for most of the day and would
  // quietly include or drop a boundary day.
  const since = businessDate(new Date(Date.now() - days * 86_400_000));
  const touch = await selectedTouchModel();

  // Reading BOTH touch models would double every figure, spend included — spend is
  // written identically to both rows, since the money spent does not change with
  // who gets credit for it.
  const inWindow = and(gte(roiDaily.date, since), eq(roiDaily.touchType, touch));

  const agg = {
    contacts: sql<number>`coalesce(sum(${roiDaily.contactsCount}),0)::int`,
    estimates: sql<number>`coalesce(sum(${roiDaily.estimatesCount}),0)::int`,
    won: sql<number>`coalesce(sum(${roiDaily.wonCount}),0)::int`,
    spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
    revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
  };

  const [rows, byLocation] = await Promise.all([
    db
      .select({
        campaignId: roiDaily.campaignId,
        name: campaigns.name,
        platform: campaigns.platform,
        sourceName: sources.displayName,
        ...agg,
      })
      .from(roiDaily)
      .leftJoin(campaigns, eq(roiDaily.campaignId, campaigns.id))
      .leftJoin(sources, eq(roiDaily.sourceId, sources.id))
      .where(inWindow)
      .groupBy(roiDaily.campaignId, campaigns.name, campaigns.platform, sources.displayName)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.spendCents}),0)`)),
    db
      .select({ location: roiDaily.location, ...agg })
      .from(roiDaily)
      .where(inWindow)
      .groupBy(roiDaily.location)
      .orderBy(desc(sql`coalesce(sum(${roiDaily.revenueCents}),0)`)),
  ]);

  const totals = rows.reduce(
    (a, r) => ({
      contacts: a.contacts + r.contacts,
      estimates: a.estimates + r.estimates,
      won: a.won + r.won,
      spend: a.spend + r.spend,
      revenue: a.revenue + r.revenue,
    }),
    { contacts: 0, estimates: 0, won: 0, spend: 0, revenue: 0 },
  );
  const maxRoas = Math.max(1, ...rows.map((r) => (r.spend > 0 ? r.revenue / r.spend : 0)));
  const paidRows = rows.filter((r) => r.campaignId !== null);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">
            Spend and return per campaign · {timeframeLabel(days)} · {touchModelLabel(touch)}
          </p>
        </div>
        <div className="controls">
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>◷</span>
          {TIMEFRAMES.map((t) => (
            <Link
              key={t.days}
              href={t.days === 30 ? "/roi" : `/roi?days=${t.days}`}
              className="pill"
              style={
                days === t.days
                  ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" }
                  : undefined
              }
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {paidRows.length === 0 ? (
        <div className="empty" style={{ marginBottom: 26 }}>
          No campaign performance yet — populates once ad spend is syncing and leads carry a{" "}
          <code>utm_campaign</code> matching a campaign name.
        </div>
      ) : (
        <div className="table-scroll" style={{ marginBottom: 30 }}>
          <table>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Source</th>
                <th title="People who contacted us — any channel, spam excluded">Contacts</th>
                <th title="Estimate visits booked and not cancelled">Estimates</th>
                <th title="Estimate approved">Won</th>
                <th>Spend</th>
                <th title="Value of won estimates">Revenue</th>
                <th title="Cost per estimate: spend ÷ estimates attributed to this campaign">CPE</th>
                <th style={{ width: 150 }}>ROAS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cpe = r.estimates && r.spend ? dollars(Math.round(r.spend / r.estimates)) : "—";
                const roasNum = r.spend ? r.revenue / r.spend : 0;
                // Spend with no revenue yet is a wait-state, not a 0.0× verdict —
                // an estimate booked today may not be approved for weeks.
                const roas =
                  r.spend && r.revenue > 0
                    ? roasNum.toFixed(1) + "×"
                    : r.revenue > 0
                      ? "organic"
                      : r.spend
                        ? "no rev yet"
                        : "—";
                const winning = r.spend > 0 && r.revenue > 0;
                const unattributed = r.campaignId === null;
                return (
                  <tr key={r.campaignId ?? `u${i}`}>
                    <td>
                      {unattributed ? (
                        <span
                          className="muted"
                          title="Contacts with no campaign: organic search, Google Business Profile, Local Services, direct, and any paid click whose utm_campaign matched no campaign name."
                        >
                          Not campaign-attributed
                        </span>
                      ) : (
                        <span className="src">
                          {r.name ?? <span className="muted">Unnamed campaign</span>}
                          {r.platform && (
                            <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                              {r.platform}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{r.sourceName ?? "—"}</td>
                    <td className="mono">{r.contacts}</td>
                    <td className="mono">{r.estimates}</td>
                    <td>{r.won > 0 ? <span className="badge win">{r.won}</span> : <span className="muted mono">0</span>}</td>
                    <td className="mono muted">{dollars(r.spend)}</td>
                    <td className="mono">{r.revenue > 0 ? dollars(r.revenue) : <span className="muted">—</span>}</td>
                    <td className="mono muted">{cpe}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span
                          className={winning ? "mono" : ""}
                          style={{
                            color: winning ? "var(--accent)" : "var(--muted)",
                            fontWeight: winning ? 700 : 500,
                            fontSize: winning ? undefined : 12,
                            minWidth: 42,
                          }}
                        >
                          {roas}
                        </span>
                        {winning && (
                          <span className="bar">
                            <i style={{ width: Math.max(4, Math.min(100, (roasNum / maxRoas) * 100)) + "%" }} />
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 700 }}>
                <td>Total</td>
                <td />
                <td className="mono">{totals.contacts}</td>
                <td className="mono">{totals.estimates}</td>
                <td className="mono">{totals.won}</td>
                <td className="mono muted">{dollars(totals.spend)}</td>
                <td className="mono">{dollars(totals.revenue)}</td>
                <td className="mono muted">
                  {totals.estimates && totals.spend ? dollars(Math.round(totals.spend / totals.estimates)) : "—"}
                </td>
                <td className="mono" style={{ color: "var(--accent)" }}>
                  {totals.spend ? (totals.revenue / totals.spend).toFixed(1) + "×" : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Location is the one split worth carrying below campaign: it is two branches,
          not a long tail, and `roi_daily` already keys on it. */}
      <h2 className="page-title" style={{ fontSize: 16, marginBottom: 4 }}>By location</h2>
      <p className="page-sub" style={{ marginBottom: 16 }}>
        Edwardsville and O&apos;Fallon across every campaign. Each Google Business Profile tags its own link and has its
        own tracking number, so location is known for far more than just paid traffic.
      </p>
      <div className="table-scroll" style={{ marginBottom: 26 }}>
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Contacts</th>
              <th>Estimates</th>
              <th>Won</th>
              <th>Spend</th>
              <th>Revenue</th>
              <th>Close rate</th>
            </tr>
          </thead>
          <tbody>
            {byLocation.map((l) => (
              <tr key={l.location ?? "unknown"}>
                <td style={{ textTransform: "capitalize" }}>
                  {l.location === "ofallon" ? "O'Fallon" : (l.location ?? "unknown")}
                </td>
                <td className="mono">{l.contacts}</td>
                <td className="mono">{l.estimates}</td>
                <td>{l.won > 0 ? <span className="badge win">{l.won}</span> : <span className="muted mono">0</span>}</td>
                <td className="mono muted">{dollars(l.spend)}</td>
                <td className="mono">{l.revenue > 0 ? dollars(l.revenue) : <span className="muted">—</span>}</td>
                <td className="mono muted">
                  {l.estimates ? Math.round((l.won / l.estimates) * 100) + "%" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
