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

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const validType = FILTERS.some((f) => f.key === type) ? type : "";
  const since = new Date(Date.now() - 90 * 86_400_000);

  // A call only counts as a lead once classified (caller requested an estimate);
  // forms/FB/etc. are inherently leads. So the inbox = non-call types OR lead-calls.
  const leadOnly = or(ne(leads.type, "call"), eq(leads.isLead, true));
  const typeCond = validType
    ? and(gte(leads.occurredAt, since), eq(leads.type, validType as "call"), leadOnly)
    : and(gte(leads.occurredAt, since), leadOnly);

  const rows = await db
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
    .limit(200);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      quoted: sql<number>`count(*) filter (where ${leads.quoteValueCents} > 0)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(and(gte(leads.occurredAt, since), eq(leads.isSpam, false), leadOnly));

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
              href={f.key ? `/leads?type=${f.key}` : "/leads"}
              className="pill"
              style={validType === f.key ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" } : undefined}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No leads captured yet{validType ? " for this filter" : ""}.</div>
      ) : (
        <div className="table-scroll">
        <table>
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
          <tbody>
            {rows.map((r) => {
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
            })}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}
