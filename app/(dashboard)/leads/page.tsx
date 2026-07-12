import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { leads, sources } from "@/lib/db/schema";
import { dateTime, dollars } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../lead-toggle";

export const dynamic = "force-dynamic";

const TYPE_META: Record<string, { ic: string; label: string }> = {
  call: { ic: "☎", label: "Call" },
  web_form: { ic: "✉", label: "Form" },
  facebook_leadgen: { ic: "ⓕ", label: "Facebook" },
  lsa: { ic: "◎", label: "LSA" },
  manual: { ic: "✎", label: "Manual" },
};
const FILTERS = [
  { key: "", label: "All" },
  { key: "call", label: "Calls" },
  { key: "web_form", label: "Forms" },
  { key: "facebook_leadgen", label: "Facebook" },
];

function stageClass(status: string): string {
  if (status === "won") return "badge win";
  if (status === "quoted") return "badge info";
  if (status === "qualified") return "badge warn";
  if (status === "spam" || status === "lost") return "badge bad";
  if (status === "cancelled") return "badge muted-strike"; // neutral, distinct from lost
  return "badge";
}

// ── Grouping / pivot ──────────────────────────────────────────────────────────
type Dim = "source" | "stage" | "type" | "location" | "week";
const DIMS: Array<{ key: Dim; label: string }> = [
  { key: "source", label: "Source" },
  { key: "stage", label: "Stage" },
  { key: "type", label: "Type" },
  { key: "location", label: "Location" },
  { key: "week", label: "Week" },
];
const STAGE_ORDER = ["new", "qualified", "quoted", "won", "lost", "cancelled", "spam"];

interface Row {
  id: string;
  type: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  sourceKey: string | null;
  location: string | null;
  sales: number | null;
  quote: number | null;
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
}

function aggregate(rows: Row[]): Agg {
  const a: Agg = { count: 0, quotedCount: 0, wonCount: 0, quoteCents: 0, salesCents: 0 };
  for (const r of rows) {
    a.count++;
    if ((r.quote ?? 0) > 0) a.quotedCount++;
    if (r.status === "won") a.wonCount++;
    a.quoteCents += r.quote ?? 0;
    a.salesCents += r.sales ?? 0;
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
    case "stage": return r.isSpam ? "spam" : r.status;
    case "type": return r.type;
    case "location": return r.location ?? "unknown";
    case "week": return weekKey(r.occurredAt);
  }
}

function dimLabel(key: string, dim: Dim): string {
  switch (dim) {
    case "type": return TYPE_META[key]?.label ?? key;
    case "location":
      return key === "edwardsville" ? "Edwardsville" : key === "ofallon" ? "O'Fallon" : "Unknown";
    case "week":
      return "Week of " + new Date(key + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    case "source": return key === "unattributed" ? "Unattributed" : key;
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
  if (dim === "week") return keys.sort().reverse(); // recent weeks first
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
      </span>
    </>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; by?: string; by2?: string }>;
}) {
  const { type, by: byParam, by2: by2Param } = await searchParams;
  const validType = FILTERS.some((f) => f.key === type) ? type : "";
  const isDim = (v?: string): v is Dim => DIMS.some((d) => d.key === v);
  const by = isDim(byParam) ? byParam : undefined;
  const by2 = isDim(by2Param) && by2Param !== by && by ? by2Param : undefined;
  const since = new Date(Date.now() - 90 * 86_400_000);

  const href = (t: string, b?: Dim, b2?: Dim) => {
    const q = new URLSearchParams();
    if (t) q.set("type", t);
    if (b) q.set("by", b);
    if (b && b2) q.set("by2", b2);
    const qs = q.toString();
    return qs ? `/leads?${qs}` : "/leads";
  };
  const activePill = { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" } as const;

  // A call only counts as a lead once classified (caller requested an estimate);
  // forms/FB/etc. are inherently leads. So the inbox = non-call types OR lead-calls.
  const leadOnly = or(ne(leads.type, "call"), eq(leads.isLead, true));
  const typeCond = validType
    ? and(gte(leads.occurredAt, since), eq(leads.type, validType as "call"), leadOnly)
    : and(gte(leads.occurredAt, since), leadOnly);

  const rows: Row[] = await db
    .select({
      id: leads.id,
      type: leads.type,
      status: leads.status,
      name: leads.name,
      phone: leads.phoneE164,
      email: leads.emailLc,
      sourceKey: sources.key,
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
    .where(typeCond)
    .orderBy(desc(leads.occurredAt))
    // Grouped views aggregate, so they get the full window; the flat list stays short.
    .limit(by ? 1000 : 200);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      quoted: sql<number>`count(*) filter (where ${leads.quoteValueCents} > 0)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(and(gte(leads.occurredAt, since), eq(leads.isSpam, false), leadOnly));

  const primary = by ? groupRows(rows, by) : null;
  const primaryKeys = primary && by ? orderKeys(primary, by) : [];
  // Secondary key order is computed across ALL rows so the pivot columns line up.
  const secondaryKeys = by2 ? orderKeys(groupRows(rows, by2), by2) : [];

  const leadRow = (r: Row) => {
    const t = TYPE_META[r.type] ?? { ic: "•", label: r.type };
    return (
      <tr key={r.id}>
        <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{dateTime(r.occurredAt)}</td>
        <td><span className="src"><span style={{ opacity: 0.85 }}>{t.ic}</span>{t.label}</span></td>
        <td>
          <div style={{ fontWeight: 600 }}>{r.name || formatPhoneDisplay(r.phone) || r.email || "—"}</div>
          {(r.name && (r.phone || r.email)) && (
            <div className="muted" style={{ fontSize: 12 }}>{formatPhoneDisplay(r.phone) || r.email}</div>
          )}
        </td>
        <td className="muted">{r.sourceKey ?? "—"}</td>
        <td><span className={r.isSpam ? "badge bad" : stageClass(r.status)}>{r.isSpam ? "spam" : r.status}</span></td>
        <td>{r.type === "call" ? <LeadToggle leadId={r.id} isLead={r.isLead} manual={r.isLeadManual ?? false} /> : <span className="muted" style={{ fontSize: 12 }}>✓</span>}</td>
        <td className="mono" style={{ textAlign: "right" }}>
          {r.sales ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(r.sales)}</span>
            : r.quote ? <span className="muted">{dollars(r.quote)} quoted</span> : "—"}
        </td>
      </tr>
    );
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
        <th style={{ textAlign: "right" }}>Value</th>
      </tr>
    </thead>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Inbox</h1>
          <p className="page-sub">
            Real leads only — a call appears when the caller requested an estimate · {agg?.total ?? 0} leads · {agg?.quoted ?? 0} quoted · {agg?.won ?? 0} won · last 90 days
          </p>
        </div>
        <div className="controls">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={href(f.key, by, by2)}
              className="pill"
              style={validType === f.key ? activePill : undefined}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="controls" style={{ marginBottom: by ? 8 : 16 }}>
        <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Group by</span>
        <Link href={href(validType ?? "")} className="pill" style={!by ? activePill : undefined}>None</Link>
        {DIMS.map((d) => (
          <Link
            key={d.key}
            href={href(validType ?? "", d.key, by2 === d.key ? undefined : by2)}
            className="pill"
            style={by === d.key ? activePill : undefined}
          >
            {d.label}
          </Link>
        ))}
      </div>
      {by && (
        <div className="controls" style={{ marginBottom: 16 }}>
          <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>then by</span>
          <Link href={href(validType ?? "", by)} className="pill" style={!by2 ? activePill : undefined}>None</Link>
          {DIMS.filter((d) => d.key !== by).map((d) => (
            <Link
              key={d.key}
              href={href(validType ?? "", by, d.key)}
              className="pill"
              style={by2 === d.key ? activePill : undefined}
            >
              {d.label}
            </Link>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">No leads captured yet{validType ? " for this filter" : ""}.</div>
      ) : !by || !primary ? (
        <table>
          {tableHead}
          <tbody>{rows.map(leadRow)}</tbody>
        </table>
      ) : (
        <>
          {/* Pivot summary — rows = primary dim, columns = secondary dim */}
          {by2 && (
            <div style={{ overflowX: "auto", marginBottom: 18 }}>
              <table>
                <thead>
                  <tr>
                    <th>{DIMS.find((d) => d.key === by)!.label} ↓ · {DIMS.find((d) => d.key === by2)!.label} →</th>
                    {secondaryKeys.map((k) => <th key={k}>{dimLabel(k, by2)}</th>)}
                    <th style={{ textAlign: "right" }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {primaryKeys.map((pk) => {
                    const sub = groupRows(primary.get(pk)!, by2);
                    const rowAgg = aggregate(primary.get(pk)!);
                    return (
                      <tr key={pk}>
                        <td>{by === "stage" ? <span className={stageClass(pk)}>{pk}</span> : <span style={{ fontWeight: 600 }}>{dimLabel(pk, by)}</span>}</td>
                        {secondaryKeys.map((sk) => {
                          const cell = sub.get(sk);
                          if (!cell) return <td key={sk} className="mono" style={{ color: "var(--faint)" }}>—</td>;
                          const a = aggregate(cell);
                          const cents = a.salesCents || a.quoteCents;
                          return (
                            <td key={sk} className="mono">
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
                    {secondaryKeys.map((sk) => {
                      const a = aggregate(rows.filter((r) => dimKey(r, by2) === sk));
                      return <td key={sk} className="mono">{a.count}</td>;
                    })}
                    <td className="mono" style={{ textAlign: "right" }}>{rows.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Grouped detail */}
          <table>
            {tableHead}
            <tbody>
              {primaryKeys.map((pk) => {
                const groupLeads = primary.get(pk)!;
                const a = aggregate(groupLeads);
                const head = (
                  <tr key={`g:${pk}`} style={{ background: "var(--panel-2)" }}>
                    <td colSpan={6}><GroupHeadLabel k={pk} dim={by} a={a} /></td>
                    <td className="mono" style={{ textAlign: "right" }}><GroupValueSummary a={a} /></td>
                  </tr>
                );
                if (!by2) return [head, ...groupLeads.map(leadRow)];
                const sub = groupRows(groupLeads, by2);
                return [
                  head,
                  ...secondaryKeys.filter((sk) => sub.has(sk)).flatMap((sk) => {
                    const subLeads = sub.get(sk)!;
                    const sa = aggregate(subLeads);
                    return [
                      <tr key={`g:${pk}:${sk}`} style={{ background: "var(--panel-2)" }}>
                        <td colSpan={6} style={{ paddingLeft: 34, fontSize: 12.5 }}>
                          <span style={{ color: "var(--faint)", marginRight: 7 }}>↳</span>
                          <GroupHeadLabel k={sk} dim={by2} a={sa} />
                        </td>
                        <td className="mono" style={{ textAlign: "right", fontSize: 12.5 }}><GroupValueSummary a={sa} /></td>
                      </tr>,
                      ...subLeads.map(leadRow),
                    ];
                  }),
                ];
              })}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
