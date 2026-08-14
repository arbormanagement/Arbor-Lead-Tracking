import { and, desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { campaigns, hcpCustomers, hcpEstimates, leads, sources } from "@/lib/db/schema";
import { isCountableEstimate } from "@/lib/estimates/countable";
import { dateTime, dollars } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { pickDays, timeframeLabel } from "@/lib/timeframes";
import { businessDate } from "@/lib/tz";
import { ViewControls } from "./view-controls";
import { DIMS, parseGroups, type Dim } from "./view";
import { stageClass, TYPE_META } from "../stage";

export const dynamic = "force-dynamic";

/**
 * Estimates — the opportunity list, and the last surface to move off the
 * lead-anchored model.
 *
 * This page used to be /leads: it listed `leads` rows passing `isQualifiedLead`
 * and called them "confirmed estimate requests". Two problems with that, both
 * fixed by changing the unit rather than the filter.
 *
 * It could only ever show opportunities that came through a TRACKED CONTACT.
 * Roughly 41% of estimate customers have no lead on any channel — repeat business,
 * referrals, canvassing, estimates written in the field — so those opportunities
 * were not merely unattributed here, they were absent. Counting estimates makes
 * them visible, with `Unattributed` as an honest answer to "which channel", and
 * brings the page in line with `roi_daily`, which moved to this unit in P2.
 *
 * And "a lead" had drifted into three rival definitions across the app. There is
 * now one: `isCountableEstimate` — scheduled, and not cancelled. It is the rule the
 * team's own reporting already ran on, and it is the difference between a 25% and a
 * 48% close rate on the same wins.
 *
 * **Dates here are the APPOINTMENT, not the contact.** That is deliberate and it
 * differs from /sources and /roi, which bucket on the contact date so outcomes land
 * beside the spend that produced them. This page answers "of the visits we ran that
 * month, what closed?", which is a cohort on `scheduled_start`. The two never
 * reconcile row-for-row and are not supposed to — see lib/estimates/countable.ts.
 */

// Estimate outcomes, in pipeline order rather than alphabetical.
const STAGE_ORDER = ["open", "won", "lost"];
const DATE_DIMS: Dim[] = ["day", "week", "month"];

interface Row {
  id: string;
  outcome: string;
  scheduledStart: Date;
  name: string | null;
  phone: string | null;
  email: string | null;
  approved: number | null;
  total: number | null;
  /** Null when no tracked contact could be matched — rendered as Unattributed. */
  leadId: string | null;
  leadType: string | null;
  sourceKey: string | null;
  sourceName: string | null;
  campaignName: string | null;
  selfReportedSource: string | null;
  location: string | null;
}

interface Agg {
  count: number;
  wonCount: number;
  lostCount: number;
  wonCents: number;
  quotedCents: number;
}

function aggregate(rows: Row[]): Agg {
  const a: Agg = { count: 0, wonCount: 0, lostCount: 0, wonCents: 0, quotedCents: 0 };
  for (const r of rows) {
    a.count++;
    if (r.outcome === "won") {
      a.wonCount++;
      a.wonCents += r.approved || r.total || 0;
    } else {
      if (r.outcome === "lost") a.lostCount++;
      a.quotedCents += r.total ?? 0;
    }
  }
  return a;
}

/** Won ÷ countable, as a whole percent. The headline number the team runs on. */
function closeRate(a: Agg): string {
  return a.count ? `${Math.round((a.wonCount / a.count) * 100)}%` : "—";
}

/** Monday of the appointment's week in BUSINESS time — a stable key that also
 *  sorts chronologically, derived from the business date so it cannot disagree
 *  with the day grouping at the CT/UTC boundary. */
function weekKey(d: Date): string {
  const anchor = new Date(`${businessDate(d)}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7));
  return anchor.toISOString().slice(0, 10);
}

function dimKey(r: Row, dim: Dim): string {
  switch (dim) {
    case "source": return r.sourceName ?? r.sourceKey ?? "Unattributed";
    case "campaign": return r.campaignName ?? "no campaign";
    case "stage": return r.outcome;
    case "type": return r.leadType ?? "untracked";
    case "location": return r.location ?? "unknown";
    // Business-timezone buckets, so an evening appointment cannot land in
    // tomorrow's group while its own timestamp renders as today.
    case "day": return businessDate(r.scheduledStart);
    case "week": return weekKey(r.scheduledStart);
    case "month": return businessDate(r.scheduledStart).slice(0, 7);
  }
}

function dimLabel(key: string, dim: Dim): string {
  switch (dim) {
    case "type": return key === "untracked" ? "No tracked contact" : (TYPE_META[key]?.label ?? key);
    case "location":
      return key === "edwardsville" ? "Edwardsville" : key === "ofallon" ? "O'Fallon" : "Unknown";
    case "day":
      return new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    case "week":
      return "Week of " + new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    case "month":
      return new Date(key + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    case "campaign": return key === "no campaign" ? "No campaign" : key;
    default: return key;
  }
}

function groupRows(rows: Row[], dim: Dim): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = dimKey(r, dim);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function orderKeys(groups: Map<string, Row[]>, dim: Dim): string[] {
  const keys = [...groups.keys()];
  if (dim === "stage") return keys.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
  if (DATE_DIMS.includes(dim)) return keys.sort().reverse(); // recent first
  return keys.sort((a, b) => groups.get(b)!.length - groups.get(a)!.length || a.localeCompare(b));
}

function GroupValueSummary({ a }: { a: Agg }) {
  if (!a.quotedCents && !a.wonCents) return <span className="muted">—</span>;
  return (
    <>
      {a.quotedCents > 0 && <span className="muted">{dollars(a.quotedCents)} open</span>}
      {a.quotedCents > 0 && a.wonCents > 0 && <span className="muted"> · </span>}
      {a.wonCents > 0 && <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(a.wonCents)} won</span>}
    </>
  );
}

function GroupHeadLabel({ k, dim, a }: { k: string; dim: Dim; a: Agg }) {
  return (
    <>
      {dim === "stage" ? (
        <span className={stageClass(k)}>{k}</span>
      ) : (
        <span style={{ fontWeight: 700 }}>{dimLabel(k, dim)}</span>
      )}
      <span className="muted" style={{ fontSize: 12, marginLeft: 9 }}>
        {a.count} {a.count === 1 ? "estimate" : "estimates"}
        {a.wonCount > 0 && ` · ${a.wonCount} won · ${closeRate(a)}`}
      </span>
    </>
  );
}

export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<{ g?: string; days?: string }>;
}) {
  const { g, days: daysParam } = await searchParams;
  const groups = parseGroups(g);
  const days = pickDays(daysParam, 90);
  const since = new Date(Date.now() - days * 86_400_000);

  // Recruiting/brand campaigns are not customer acquisition, so their estimates
  // stay out of this list and its totals — the same exclusion roi_daily applies,
  // or grouped-by-source figures here would not reconcile with /sources.
  const excludedIds = await excludedCampaignIds();

  // At most one lead per estimate: matchLeadsToEstimates claims each lead exactly
  // once, so this join cannot fan out and double-count an estimate or its revenue.
  const scope = and(
    isCountableEstimate,
    gte(hcpEstimates.scheduledStartHcp, since),
    campaignNotExcluded(leads.campaignId, excludedIds),
  );
  const withLead = db
    .select({
      id: hcpEstimates.id,
      outcome: hcpEstimates.outcome,
      scheduledStart: hcpEstimates.scheduledStartHcp,
      approved: hcpEstimates.approvedAmountCents,
      total: hcpEstimates.totalAmountCents,
      // Name comes through the customer JOIN first: this app links to HousecallPro
      // rather than storing customer data, so a name corrected in HCP shows up here
      // immediately. The copy on the estimate is the fallback for a customer the
      // sync has not reached yet.
      custFirst: hcpCustomers.firstName,
      custLast: hcpCustomers.lastName,
      estName: hcpEstimates.customerName,
      phone: hcpEstimates.customerPhoneE164,
      email: hcpEstimates.customerEmailLc,
      estLocation: hcpEstimates.location,
      leadId: leads.id,
      leadType: leads.type,
      leadLocation: leads.location,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      campaignName: campaigns.name,
      selfReportedSource: leads.selfReportedSource,
    })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .leftJoin(hcpCustomers, eq(hcpEstimates.hcpCustomerId, hcpCustomers.id));

  const fetched = await withLead
    .where(scope)
    .orderBy(desc(hcpEstimates.scheduledStartHcp))
    // Grouped views aggregate, so they get the full window; the flat list stays short.
    .limit(groups.length ? 1000 : 200);

  const rows: Row[] = fetched.map((r) => ({
    id: r.id,
    outcome: r.outcome,
    scheduledStart: r.scheduledStart!,
    name: [r.custFirst, r.custLast].filter(Boolean).join(" ") || r.estName,
    phone: r.phone,
    email: r.email,
    approved: r.approved,
    total: r.total,
    leadId: r.leadId,
    leadType: r.leadType,
    sourceKey: r.sourceKey,
    sourceName: r.sourceName,
    campaignName: r.campaignName,
    selfReportedSource: r.selfReportedSource,
    // The attributed contact's location when there is one, the estimate's own
    // otherwise — the same precedence the rollup uses, so the two agree.
    location: r.leadLocation ?? r.estLocation,
  }));

  // Counted over EXACTLY the population the table renders, so the subtitle can
  // never disagree with the sum of the visible group counts.
  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      won: sql<number>`count(*) filter (where ${hcpEstimates.outcome} = 'won')::int`,
      attributed: sql<number>`count(*) filter (where ${leads.id} is not null)::int`,
      wonCents: sql<number>`coalesce(sum(coalesce(nullif(${hcpEstimates.approvedAmountCents},0), ${hcpEstimates.totalAmountCents})) filter (where ${hcpEstimates.outcome} = 'won'), 0)::int`,
    })
    .from(hcpEstimates)
    .leftJoin(leads, and(eq(leads.hcpEstimateId, hcpEstimates.id), eq(leads.isSpam, false)))
    .where(scope);

  const total = agg?.total ?? 0;
  const won = agg?.won ?? 0;
  const rate = total ? `${Math.round((won / total) * 100)}%` : "—";

  const estimateRow = (r: Row) => {
    const t = r.leadType ? (TYPE_META[r.leadType] ?? { ic: "•", label: r.leadType }) : null;
    const who = (
      <>
        <div style={{ fontWeight: 600 }}>{r.name || formatPhoneDisplay(r.phone) || r.email || "—"}</div>
        {(r.name && (r.phone || r.email)) && (
          <div className="muted nowrap" style={{ fontSize: 12 }}>{formatPhoneDisplay(r.phone) || r.email}</div>
        )}
      </>
    );
    return (
      <tr key={r.id}>
        <td className="muted mono nowrap">{dateTime(r.scheduledStart)}</td>
        <td className="col-hide-sm">
          {t ? (
            <span className="src"><span style={{ opacity: 0.85 }}>{t.ic}</span>{t.label}</span>
          ) : (
            <span className="muted" title="No tracked contact matched this estimate — repeat business, a referral, or written in the field">—</span>
          )}
        </td>
        {/* Links to the CONTACT that produced this estimate. An estimate with no
            tracked contact has nothing to open, so it renders plain rather than as
            a dead link. */}
        <td>{r.leadId ? <Link href={`/leads/${r.leadId}`} className="rowlink">{who}</Link> : who}</td>
        <td className="muted col-hide-sm">
          {r.sourceName ?? r.sourceKey ?? <span className="muted">Unattributed</span>}
          {r.selfReportedSource && (
            <div style={{ fontSize: 11, marginTop: 2 }} title="Caller's own answer to 'how did you hear about us'">
              says: {r.selfReportedSource}
            </div>
          )}
        </td>
        <td><span className={stageClass(r.outcome)}>{r.outcome}</span></td>
        <td className="mono" style={{ textAlign: "right" }}>
          {r.outcome === "won" ? (
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(r.approved || r.total || 0)}</span>
          ) : r.total ? (
            <span className="muted">{dollars(r.total)}</span>
          ) : "—"}
        </td>
      </tr>
    );
  };

  // Nested group sections: a header row per group at each level, estimates at the leaves.
  const renderLevel = (subset: Row[], dims: Dim[], depth: number, keyPrefix: string): ReactNode[] => {
    if (!dims.length) return subset.map(estimateRow);
    const [dim, ...rest] = dims;
    const m = groupRows(subset, dim);
    return orderKeys(m, dim).flatMap((k) => {
      const sub = m.get(k)!;
      const a = aggregate(sub);
      const rowKey = `${keyPrefix}/${dim}:${k}`;
      return [
        <tr key={rowKey} style={{ background: "var(--panel-2)" }}>
          <td colSpan={5} style={depth > 0 ? { paddingLeft: 16 + depth * 18, fontSize: 12.5 } : undefined}>
            {depth > 0 && <span style={{ color: "var(--faint)", marginRight: 7 }}>↳</span>}
            <GroupHeadLabel k={k} dim={dim} a={a} />
          </td>
          <td className="mono" style={{ textAlign: "right", ...(depth > 0 ? { fontSize: 12.5 } : {}) }}>
            <GroupValueSummary a={a} />
          </td>
        </tr>,
        ...renderLevel(sub, rest, depth + 1, rowKey),
      ];
    });
  };

  const tableHead = (
    <thead>
      {/* Channel and Source hide on phones so Stage/Value stay in view. */}
      <tr>
        <th title="The estimate appointment, not when the customer got in touch">Appointment</th>
        <th className="col-hide-sm">Channel</th>
        <th>Customer</th>
        <th className="col-hide-sm">Source</th>
        <th>Outcome</th>
        <th style={{ textAlign: "right" }}>Value</th>
      </tr>
    </thead>
  );

  // Pivot matrix over the first two groupings.
  const pivot = () => {
    const [rowDim, colDim] = groups as [Dim, Dim];
    const primary = groupRows(rows, rowDim);
    const primaryKeys = orderKeys(primary, rowDim);
    const colKeys = orderKeys(groupRows(rows, colDim), colDim);
    return (
      <div className="table-scroll" style={{ marginBottom: 18 }}>
        <table>
          <thead>
            <tr>
              <th>{DIMS.find((d) => d.key === rowDim)!.label} ↓ · {DIMS.find((d) => d.key === colDim)!.label} →</th>
              {colKeys.map((k) => <th key={k}>{dimLabel(k, colDim)}</th>)}
              <th style={{ textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {primaryKeys.map((pk) => {
              const sub = groupRows(primary.get(pk)!, colDim);
              const rowAgg = aggregate(primary.get(pk)!);
              return (
                <tr key={pk}>
                  <td>{rowDim === "stage" ? <span className={stageClass(pk)}>{pk}</span> : <span style={{ fontWeight: 600 }}>{dimLabel(pk, rowDim)}</span>}</td>
                  {colKeys.map((ck) => {
                    const cell = sub.get(ck);
                    if (!cell) return <td key={ck} className="mono" style={{ color: "var(--faint)" }}>—</td>;
                    const a = aggregate(cell);
                    const cents = a.wonCents || a.quotedCents;
                    return (
                      <td key={ck} className="mono">
                        {a.count}
                        {cents > 0 && (
                          <div style={{ fontSize: 11, color: a.wonCents ? "var(--accent)" : "var(--muted)" }}>{dollars(cents)}</div>
                        )}
                      </td>
                    );
                  })}
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>
                    {rowAgg.count}
                    {(rowAgg.wonCents || rowAgg.quotedCents) > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 500, color: rowAgg.wonCents ? "var(--accent)" : "var(--muted)" }}>
                        {dollars(rowAgg.wonCents || rowAgg.quotedCents)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr style={{ fontWeight: 700 }}>
              <td>Total</td>
              {colKeys.map((ck) => {
                const a = aggregate(rows.filter((r) => dimKey(r, colDim) === ck));
                return <td key={ck} className="mono">{a.count}</td>;
              })}
              <td className="mono" style={{ textAlign: "right" }}>{rows.length}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Estimates</h1>
          <p className="page-sub">
            Scheduled and not cancelled · {total} estimates · {won} won · {rate} close rate ·{" "}
            {dollars(agg?.wonCents ?? 0)} · {timeframeLabel(days)}
          </p>
          {total > 0 && (
            <p className="page-sub" style={{ marginTop: 2 }}>
              <span className="muted">
                {agg?.attributed ?? 0} of {total} traced to a tracked contact — the rest are repeat business, referrals
                and estimates written in the field, counted here and shown as Unattributed.
              </span>
            </p>
          )}
        </div>
        <div className="controls">
          <ViewControls groups={groups} days={days} />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          No scheduled estimates in this window.{" "}
          <Link href="/inbox" className="link">Check the inbox</Link> for calls and texts that have not become estimates yet.
        </div>
      ) : (
        <>
          {groups.length >= 2 && pivot()}
          <div className="table-scroll">
            <table>
              {tableHead}
              <tbody>{renderLevel(rows, groups, 0, "g")}</tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
