import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import Link from "next/link";
import type { ReactNode } from "react";
import { db } from "@/lib/db/client";
import { campaigns, leads, roiDaily, sources } from "@/lib/db/schema";
import { dateTime, dollars } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { pickDays, timeframeLabel } from "@/lib/timeframes";
import { LeadToggle } from "../lead-toggle";
import { ViewControls } from "./view-controls";
import { DIMS, parseGroups, type Dim } from "./view";
import { stageClass, TYPE_META } from "./stage";

export const dynamic = "force-dynamic";

// ── Grouping / pivot ──────────────────────────────────────────────────────────
const STAGE_ORDER = ["new", "qualified", "quoted", "won", "lost", "cancelled", "spam"];
const DATE_DIMS: Dim[] = ["day", "week", "month"];

interface Row {
  id: string;
  type: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  sourceId: string | null;
  sourceKey: string | null;
  campaignName: string | null;
  selfReportedSource: string | null;
  location: string | null;
  sales: number | null;
  quote: number | null;
  /** Allocated acquisition cost: the source's spend for the lead's calendar month
   *  divided by that source's lead count that month (null when unknowable). */
  costCents: number | null;
  occurredAt: Date;
  isSpam: boolean | null;
  isLead: boolean | null;
  isLeadManual: boolean | null;
}

interface Agg {
  count: number;
  quotedCount: number;
  wonCount: number;
  quoteCents: number;
  salesCents: number;
  costCents: number;
}

function aggregate(rows: Row[]): Agg {
  const a: Agg = { count: 0, quotedCount: 0, wonCount: 0, quoteCents: 0, salesCents: 0, costCents: 0 };
  for (const r of rows) {
    a.count++;
    if ((r.quote ?? 0) > 0) a.quotedCount++;
    if (r.status === "won") a.wonCount++;
    a.quoteCents += r.quote ?? 0;
    a.salesCents += r.sales ?? 0;
    a.costCents += r.costCents ?? 0;
  }
  return a;
}

/** Monday (UTC) of the lead's week — stable key that also sorts chronologically. */
function weekKey(d: Date): string {
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function dimKey(r: Row, dim: Dim): string {
  switch (dim) {
    case "source": return r.sourceKey ?? "unattributed";
    case "campaign": return r.campaignName ?? "no campaign";
    case "stage": return r.isSpam ? "spam" : r.status;
    case "type": return r.type;
    case "location": return r.location ?? "unknown";
    case "day": return r.occurredAt.toISOString().slice(0, 10);
    case "week": return weekKey(r.occurredAt);
    case "month": return r.occurredAt.toISOString().slice(0, 7);
  }
}

function dimLabel(key: string, dim: Dim): string {
  switch (dim) {
    case "type": return TYPE_META[key]?.label ?? key;
    case "location":
      return key === "edwardsville" ? "Edwardsville" : key === "ofallon" ? "O'Fallon" : "Unknown";
    case "day":
      return new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    case "week":
      return "Week of " + new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    case "month":
      return new Date(key + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    case "source": return key === "unattributed" ? "Unattributed" : key;
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
  if (!a.quoteCents && !a.salesCents) return <span className="muted">—</span>;
  return (
    <>
      {a.quoteCents > 0 && <span className="muted">{dollars(a.quoteCents)} quoted</span>}
      {a.quoteCents > 0 && a.salesCents > 0 && <span className="muted"> · </span>}
      {a.salesCents > 0 && <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(a.salesCents)} won</span>}
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
        {a.count} {a.count === 1 ? "lead" : "leads"}
        {a.quotedCount > 0 && ` · ${a.quotedCount} quoted`}
        {a.wonCount > 0 && ` · ${a.wonCount} won`}
        {a.costCents > 0 && ` · ${dollars(a.costCents)} ad cost`}
      </span>
    </>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ g?: string; days?: string }>;
}) {
  const { g, days: daysParam } = await searchParams;
  const groups = parseGroups(g);
  const days = pickDays(daysParam, 90);
  const since = new Date(Date.now() - days * 86_400_000);

  // A call only counts as a lead once classified (caller requested an estimate);
  // forms/FB/etc. are inherently leads. So the inbox = non-call types OR lead-calls.
  const leadOnly = or(ne(leads.type, "call"), eq(leads.isLead, true));

  const fetched = await db
    .select({
      id: leads.id,
      type: leads.type,
      status: leads.status,
      name: leads.name,
      phone: leads.phoneE164,
      email: leads.emailLc,
      sourceId: leads.sourceId,
      sourceKey: sources.key,
      campaignName: campaigns.name,
      selfReportedSource: leads.selfReportedSource,
      location: leads.location,
      sales: leads.salesValueCents,
      quote: leads.quoteValueCents,
      occurredAt: leads.occurredAt,
      isSpam: leads.isSpam,
      isLead: leads.isLead,
      isLeadManual: leads.isLeadManual,
    })
    .from(leads)
    .leftJoin(sources, eq(leads.sourceId, sources.id))
    .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
    .where(and(gte(leads.occurredAt, since), leadOnly))
    .orderBy(desc(leads.occurredAt))
    // Grouped views aggregate, so they get the full window; the flat list stays short.
    .limit(groups.length ? 1000 : 200);

  // Allocated cost per lead: (source's spend that calendar month) ÷ (that source's
  // leads that month), both from roi_daily — which already folds in synced ad spend
  // AND manual monthly spend. Ad platforms bill per click/impression, not per lead,
  // so a per-lead price can only ever be an allocation; month × source is the
  // stable, WhatConverts-style cut.
  const monthExpr = sql<string>`left(${roiDaily.date}::text, 7)`;
  const sinceMonth = since.toISOString().slice(0, 7) + "-01";
  const costRows = await db
    .select({
      sourceId: roiDaily.sourceId,
      month: monthExpr,
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      leadsCount: sql<number>`coalesce(sum(${roiDaily.leadsCount}),0)::int`,
    })
    .from(roiDaily)
    .where(gte(roiDaily.date, sinceMonth))
    .groupBy(roiDaily.sourceId, monthExpr);

  const cplBySourceMonth = new Map<string, number>();
  for (const c of costRows) {
    if (c.sourceId && c.spend > 0 && c.leadsCount > 0) {
      cplBySourceMonth.set(`${c.sourceId}|${c.month}`, Math.round(c.spend / c.leadsCount));
    }
  }
  const rows: Row[] = fetched.map((r) => ({
    ...r,
    costCents:
      !r.isSpam && r.sourceId
        ? cplBySourceMonth.get(`${r.sourceId}|${r.occurredAt.toISOString().slice(0, 7)}`) ?? null
        : null,
  }));

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      quoted: sql<number>`count(*) filter (where ${leads.quoteValueCents} > 0)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(and(gte(leads.occurredAt, since), eq(leads.isSpam, false), leadOnly));

  const leadRow = (r: Row) => {
    const t = TYPE_META[r.type] ?? { ic: "•", label: r.type };
    return (
      <tr key={r.id}>
        <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{dateTime(r.occurredAt)}</td>
        <td><span className="src"><span style={{ opacity: 0.85 }}>{t.ic}</span>{t.label}</span></td>
        <td>
          <Link href={`/leads/${r.id}`} className="rowlink">
            <div style={{ fontWeight: 600 }}>{r.name || formatPhoneDisplay(r.phone) || r.email || "—"}</div>
            {(r.name && (r.phone || r.email)) && (
              <div className="muted" style={{ fontSize: 12 }}>{formatPhoneDisplay(r.phone) || r.email}</div>
            )}
          </Link>
        </td>
        <td className="muted">
          {r.sourceKey ?? "—"}
          {r.selfReportedSource && (
            <div style={{ fontSize: 11, marginTop: 2 }} title="Caller's own answer to 'how did you hear about us'">
              says: {r.selfReportedSource}
            </div>
          )}
        </td>
        <td><span className={r.isSpam ? "badge bad" : stageClass(r.status)}>{r.isSpam ? "spam" : r.status}</span></td>
        <td>{r.type === "call" ? <LeadToggle leadId={r.id} isLead={r.isLead} manual={r.isLeadManual ?? false} /> : <span className="muted" style={{ fontSize: 12 }}>✓</span>}</td>
        <td className="mono muted" style={{ textAlign: "right" }} title="Allocated: source's spend that month ÷ its leads that month">
          {r.costCents != null ? dollars(r.costCents) : "—"}
        </td>
        <td className="mono" style={{ textAlign: "right" }}>
          {r.sales ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(r.sales)}</span>
            : r.quote ? <span className="muted">{dollars(r.quote)} quoted</span> : "—"}
        </td>
      </tr>
    );
  };

  // Nested group sections: a header row per group at each level, lead rows at the leaves.
  const renderLevel = (subset: Row[], dims: Dim[], depth: number, keyPrefix: string): ReactNode[] => {
    if (!dims.length) return subset.map(leadRow);
    const [dim, ...rest] = dims;
    const m = groupRows(subset, dim);
    return orderKeys(m, dim).flatMap((k) => {
      const sub = m.get(k)!;
      const a = aggregate(sub);
      const rowKey = `${keyPrefix}/${dim}:${k}`;
      return [
        <tr key={rowKey} style={{ background: "var(--panel-2)" }}>
          <td colSpan={7} style={depth > 0 ? { paddingLeft: 16 + depth * 18, fontSize: 12.5 } : undefined}>
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
      <tr>
        <th>When</th>
        <th>Type</th>
        <th>Contact</th>
        <th>Source</th>
        <th>Stage</th>
        <th>Lead?</th>
        <th style={{ textAlign: "right" }} title="Allocated: source's spend that month ÷ its leads that month">Cost</th>
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
                    const cents = a.salesCents || a.quoteCents;
                    return (
                      <td key={ck} className="mono">
                        {a.count}
                        {cents > 0 && (
                          <div style={{ fontSize: 11, color: a.salesCents ? "var(--accent)" : "var(--muted)" }}>{dollars(cents)}</div>
                        )}
                      </td>
                    );
                  })}
                  <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>
                    {rowAgg.count}
                    {(rowAgg.salesCents || rowAgg.quoteCents) > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 500, color: rowAgg.salesCents ? "var(--accent)" : "var(--muted)" }}>
                        {dollars(rowAgg.salesCents || rowAgg.quoteCents)}
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
          <h1 className="page-title">Leads</h1>
          <p className="page-sub">
            Real leads only — a call appears when the caller requested an estimate · {agg?.total ?? 0} leads · {agg?.quoted ?? 0} quoted · {agg?.won ?? 0} won · {timeframeLabel(days)}
          </p>
        </div>
        <div className="controls">
          <ViewControls groups={groups} days={days} />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No leads captured yet.</div>
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
