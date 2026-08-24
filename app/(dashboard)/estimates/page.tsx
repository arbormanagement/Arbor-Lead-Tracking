import Link from "next/link";
import type { ReactNode } from "react";
import { dateTime, dollars } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { listEstimates, type EstimateListRow } from "@/lib/queries/estimates";
import { pickDays, timeframeLabel } from "@/lib/timeframes";
import { businessDate } from "@/lib/tz";
import { TRACKING_STARTED_LABEL } from "@/lib/tracking-coverage";
import { ViewControls } from "./view-controls";
import { estimatesHref, FILTER_KEYS, filterLabel, filterSql, hasAnyFilter, parseFilters } from "./filters";
import { DEFAULT_DAYS, DIMS, parseGroups, type Dim } from "./view";
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
 * **This page windows on CREATED, not the appointment or the contact, and defaults
 * to the last 7 days** (Justin, 2026-08-15). It answers "what came in this week",
 * which is the question actually asked of it, and it is the only one of the three
 * dates that makes the list a clean cohort of new work.
 *
 * It also removes an artefact rather than hiding one. Windowing on the appointment
 * pulled in estimates written weeks earlier — 43 of 95 in the 8-15 August window
 * were created before tracking existed, so they could never be attributed and
 * filled Unattributed with records nothing could have matched.
 *
 * Two consequences worth stating rather than discovering:
 *  · This will NOT reconcile row-for-row with /sources, which buckets on the
 *    CONTACT date so outcomes land beside the spend that produced them. Both are
 *    right for their own question; see lib/estimates/countable.ts.
 *  · A close rate over recently-CREATED estimates is immature by construction —
 *    work written this week has not been decided yet. Over a short window it reads
 *    low, and that is the cohort, not a decline.
 */

// Estimate outcomes, in pipeline order rather than alphabetical.
const STAGE_ORDER = ["unscheduled", "open", "won", "lost"];
const DATE_DIMS: Dim[] = ["day", "week", "month"];

/** The list row shape now lives with the query — see lib/queries/estimates.ts. */
type Row = EstimateListRow;

interface Agg {
  count: number;
  /** Denominator for every rate: SCHEDULED, not cancelled. Never `count`. */
  countableCount: number;
  wonCount: number;
  lostCount: number;
  wonCents: number;
  quotedCents: number;
}

function aggregate(rows: Row[]): Agg {
  const a: Agg = { count: 0, countableCount: 0, wonCount: 0, lostCount: 0, wonCents: 0, quotedCents: 0 };
  for (const r of rows) {
    a.count++;
    // Mirrors `isCountableEstimate`: an appointment, OR a win settled without one.
    if (r.scheduled || r.outcome === "won") a.countableCount++;
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

/**
 * Won ÷ COUNTABLE, as a whole percent — the headline number the team runs on.
 *
 * Never `a.count`. The list includes estimates with no appointment and dividing by
 * those would drag the rate down with records that were never opportunities — the
 * 25%-vs-48% error this app was built to stop making.
 *
 * The denominator is `isCountableEstimate`, not "has an appointment", and the two
 * differ for a job settled over the phone. Dividing by scheduled-only put those wins
 * in the NUMERATOR (they are `outcome = 'won'`) while leaving them out of the
 * denominator, so the rate was computed across two different populations and read
 * slightly high.
 */
function closeRate(a: Agg): string {
  return a.countableCount ? `${Math.round((a.wonCount / a.countableCount) * 100)}%` : "—";
}

/** Monday of the creation week in BUSINESS time — a stable key that also
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
    // Outcome first. `unscheduled` is a fact about the CALENDAR, not a stage, and
    // letting it override the outcome filed a won job under "unscheduled" — which is
    // what made a $2,100 priced estimate read as though nothing had happened to it.
    case "stage": return r.outcome === "won" || r.outcome === "lost" ? r.outcome : r.scheduled ? "open" : "unscheduled";
    case "type": return r.leadType ?? "untracked";
    case "location": return r.location ?? "unknown";
    // Business-timezone buckets, so an estimate written in the evening cannot land
    // in tomorrow's group while its own timestamp renders as today.
    case "day": return businessDate(r.createdAt);
    case "week": return weekKey(r.createdAt);
    case "month": return businessDate(r.createdAt).slice(0, 7);
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
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { g, days: daysParam } = sp;
  const groups = parseGroups(g);
  const days = pickDays(daysParam, DEFAULT_DAYS);
  // Attribution filters, so a row on /sources can link straight to the estimates
  // behind it. See lib/estimates/filters.ts — `none` is a real value on every one.
  const filters = parseFilters(sp);
  const hrefBase = { days, g, defaultDays: DEFAULT_DAYS };

  // The list and its aggregate live in lib/queries/estimates.ts, shared with the
  // MCP `list_estimates` tool so the two surfaces cannot disagree. Grouped views
  // aggregate, so they get the full window; the flat list stays short.
  const { rows, agg } = await listEstimates({ days, filters, limit: groups.length ? 1000 : 200 });

  const total = agg?.total ?? 0;
  const preTracking = agg?.createdBeforeTracking ?? 0;
  const scheduled = agg?.scheduled ?? 0;
  const countable = agg?.countable ?? 0;
  const won = agg?.won ?? 0;
  // Off COUNTABLE, never off the listed total — see closeRate().
  const rate = countable ? `${Math.round((won / countable) * 100)}%` : "—";

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
        {/* Created is the primary date because it is what the window and the groups
            run on; the visit sits under it so the two are never confused for each
            other, which is exactly what a single coalesced column invited. */}
        <td className="muted mono nowrap" title="When the estimate was written in HousecallPro">
          {dateTime(r.createdAt)}
          {r.scheduledStart && (
            <div style={{ fontSize: 11, marginTop: 2 }} title="Booked estimate appointment">
              visit {dateTime(r.scheduledStart)}
            </div>
          )}
        </td>
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
        {/* The whole attribution chain for this estimate, in one cell: source →
            campaign → landing page → keyword, plus what the caller said. It all
            reaches the estimate through ONE join (leads.hcp_estimate_id), so
            showing it together is showing that join, and an estimate with no lead
            renders as Unattributed rather than as blanks. Each value links to the
            same list filtered by it, which is the reverse of clicking through from
            /sources. */}
        <td className="muted col-hide-sm">
          {r.sourceKey ? (
            <Link href={estimatesHref(hrefBase, filters, { source: r.sourceKey })} className="link">
              {r.sourceName ?? r.sourceKey}
            </Link>
          ) : (
            <Link
              href={estimatesHref(hrefBase, filters, { source: "none" })}
              className="link muted"
              title="No tracked contact matched this estimate — show all of them"
            >
              Unattributed
            </Link>
          )}
          {r.campaignName && (
            <div style={{ fontSize: 11, marginTop: 2 }}>
              <Link href={estimatesHref(hrefBase, filters, { campaign: r.campaignName })} className="link muted">
                ◉ {r.campaignName}
              </Link>
            </div>
          )}
          {r.landingPage && (
            <div className="mono" style={{ fontSize: 11, marginTop: 2, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.landingPage}>
              <Link href={estimatesHref(hrefBase, filters, { page: r.landingPage })} className="link muted">
                ▤ {r.landingPage}
              </Link>
            </div>
          )}
          {r.keyword && (
            <div style={{ fontSize: 11, marginTop: 2 }} title="Search keyword that produced the click">
              ⌕ {r.keyword}
            </div>
          )}
          {r.selfReportedSource && (
            <div style={{ fontSize: 11, marginTop: 2 }} title="Caller's own answer to 'how did you hear about us'">
              says: {r.selfReportedSource}
            </div>
          )}
        </td>
        <td>
          {/* The outcome is the stage; `unscheduled` sits BESIDE it rather than
              replacing it. Showing only the calendar state hid what had actually
              happened to the estimate — a won job, or a priced quote awaiting a
              decision, both rendered as a bare "unscheduled". */}
          <span className={stageClass(r.outcome)}>{r.outcome}</span>
          {!r.scheduled && (
            <span
              className="badge warn"
              style={{ marginLeft: 4 }}
              title={
                r.outcome === "won"
                  ? "Won without a booked visit — settled over the phone. Counted in the close rate."
                  : "No visit booked. An `open` estimate here may still be a live quote — check the amount."
              }
            >
              unscheduled
            </span>
          )}
        </td>
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
        <th title="When the estimate was written — what this page windows and groups on. The booked visit is shown underneath.">Created</th>
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
            {total} estimates · {scheduled} scheduled · {won} won · {rate} close rate ·{" "}
            {dollars(agg?.wonCents ?? 0)} · {timeframeLabel(days)}
          </p>
          {total > 0 && (
            <p className="page-sub" style={{ marginTop: 2 }}>
              <span className="muted">
                Close rate is won ÷ <strong>scheduled or won</strong>
                {total > countable && (
                  <> — the {total - countable} still open with no appointment booked are listed but not counted</>
                )}.
                {" "}{agg?.attributed ?? 0} of {total} traced to a tracked contact; the rest are repeat business,
                referrals and estimates written in the field, shown as Unattributed.
              </span>
            </p>
          )}
          {/* Active filters, each removable. Rendered as chips rather than a
              filter bar because they arrive by LINK — from a /sources row, or from
              clicking a value in the table — so the job is to say what you are
              looking at and let you undo it, not to offer every option up front. */}
          {hasAnyFilter(filters) && (
            <p className="page-sub" style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {FILTER_KEYS.filter((k) => filters[k]).map((k) => (
                <Link
                  key={k}
                  href={estimatesHref(hrefBase, filters, { [k]: null })}
                  className="pill"
                  style={{ color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" }}
                  title="Remove this filter"
                >
                  {filterLabel(k, filters[k]!)} ×
                </Link>
              ))}
              <Link href={estimatesHref(hrefBase, {})} className="link muted" style={{ fontSize: 12 }}>
                clear all
              </Link>
            </p>
          )}
          {preTracking > 0 && (
            <p className="page-sub" style={{ marginTop: 2 }}>
              <span className="muted">
                <strong>{preTracking} of {total} were created before {TRACKING_STARTED_LABEL}</strong>, when call and web
                tracking did not exist — so they cannot be attributed and count as Unattributed whatever the matching
                does. Shorten the timeframe to see only estimates the app could actually have traced.
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
          No estimates in this window.{" "}
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
