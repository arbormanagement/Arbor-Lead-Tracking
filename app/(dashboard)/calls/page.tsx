import { desc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { calls, leads } from "@/lib/db/schema";
import { dateTime, durationLabel } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../lead-toggle";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const rows = await db
    .select({
      id: calls.id,
      createdAt: calls.createdAt,
      fromNumber: calls.fromNumber,
      answered: calls.answered,
      voicemail: calls.voicemail,
      status: calls.status,
      durationSec: calls.durationSec,
      recordingUrl: calls.recordingUrl,
      intentLabel: calls.intentLabel,
      summary: calls.summary,
      selfReportedSource: calls.selfReportedSource,
      transcript: calls.transcript,
      spamScore: calls.spamScore,
      leadId: calls.leadId,
      isLead: leads.isLead,
      isLeadManual: leads.isLeadManual,
    })
    .from(calls)
    .leftJoin(leads, eq(calls.leadId, leads.id))
    .orderBy(desc(calls.createdAt))
    .limit(100);

  const [agg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      answered: sql<number>`count(*) filter (where ${calls.answered})::int`,
      voicemail: sql<number>`count(*) filter (where ${calls.voicemail} and not ${calls.answered})::int`,
    })
    .from(calls);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">
            Tracked inbound calls with recordings &amp; transcripts · {agg?.total ?? 0} total ·{" "}
            {agg?.answered ?? 0} answered · {agg?.voicemail ?? 0} voicemail
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">No calls yet. Once a tracking number is live, inbound calls land here.</div>
      ) : (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Recording</th>
              <th>Intent</th>
              <th>Lead?</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const spam = c.spamScore != null && Number(c.spamScore) >= 0.5;
              const voicemail = c.voicemail && !c.answered;
              const status = voicemail ? "voicemail" : c.status ?? "—";
              return (
                <tr key={c.id}>
                  <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{dateTime(c.createdAt)}</td>
                  <td style={{ fontWeight: 600 }}>
                    {c.leadId ? (
                      <Link href={`/leads/${c.leadId}`} className="rowlink">{formatPhoneDisplay(c.fromNumber)}</Link>
                    ) : (
                      formatPhoneDisplay(c.fromNumber)
                    )}
                  </td>
                  <td>
                    <span className={c.answered ? "badge win" : voicemail ? "badge warn" : "badge"}>{status}</span>
                    {spam && <span className="badge bad" style={{ marginLeft: 5 }}>spam</span>}
                  </td>
                  <td className="mono muted">{durationLabel(c.durationSec)}</td>
                  <td>
                    {c.recordingUrl ? (
                      <audio controls preload="none" style={{ height: 32, maxWidth: 220 }} src={`/api/calls/${c.id}/recording`} />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{c.intentLabel ? <span className="badge">{c.intentLabel}</span> : <span className="muted">—</span>}</td>
                  <td><LeadToggle leadId={c.leadId} isLead={c.isLead} manual={c.isLeadManual ?? false} /></td>
                  <td style={{ maxWidth: 300, fontSize: 12 }} title={c.transcript ?? ""}>
                    {c.summary ? (
                      <span>{c.summary}</span>
                    ) : c.transcript ? (
                      <span className="muted">{c.transcript.slice(0, 90) + (c.transcript.length > 90 ? "…" : "")}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {c.selfReportedSource && (
                      <div className="muted" style={{ marginTop: 3, fontSize: 11 }}>
                        heard via: <span className="badge info" style={{ fontSize: 10.5 }}>{c.selfReportedSource}</span>
                      </div>
                    )}
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
