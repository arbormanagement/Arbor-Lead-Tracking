import Link from "next/link";
import { dollars } from "@/lib/format";
import { campaignPerformance } from "@/lib/queries/sources";
import { estimateDrilldown } from "./drilldown";
import type { TouchModel } from "@/lib/attribution/model";

/**
 * Campaign-level ROI.
 *
 * `roi_daily` has been keyed on campaign since it was built — every figure here was
 * already stored and simply never read, because all three of its original readers
 * grouped by source and summed the campaigns away. So this is a display over
 * existing data, not a new measurement.
 *
 * Campaign is deliberately the FLOOR of this app's money reporting. It is the unit
 * budget actually moves between, and it is the level every ad platform reports spend
 * at. Below it — ad group, keyword, ad, landing page — the sample collapses: at
 * roughly 60 won estimates a quarter across four channels, an ad-group ROAS is a
 * random number wearing a decimal point. Adding those splits would make the view look
 * more rigorous and tell you less.
 *
 * Recruiting campaigns need no filtering here. `rebuildRoiDaily` already applies
 * `campaignNotExcluded` to both the lead pass and the spend pass, so they never reach
 * these rows.
 */
export async function CampaignView({ days, touch }: { days: number; touch: TouchModel }) {
  // The numbers live in lib/queries/sources.ts, shared with the MCP `roi_summary`
  // tool so the two surfaces cannot disagree.
  const { rows } = await campaignPerformance(days, touch);

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
                        <Link
                          href={estimateDrilldown({ campaign: "none" }, days)}
                          className="link muted"
                          title="Contacts with no campaign: organic search, Google Business Profile, Local Services, direct, and any paid click whose utm_campaign matched no campaign name."
                        >
                          Not campaign-attributed
                        </Link>
                      ) : (
                        <span className="src">
                          {r.name ? (
                            <Link href={estimateDrilldown({ campaign: r.name }, days)} className="link">
                              {r.name}
                            </Link>
                          ) : (
                            <span className="muted">Unnamed campaign</span>
                          )}
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

    </>
  );
}
