import { desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { dateTime, durationLabel } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  const rows = await db.select().from(calls).orderBy(desc(calls.createdAt)).limit(100);

  return (
    <>
      <h1 className="page-title">Calls</h1>
      <p className="page-sub">Tracked inbound calls with recordings &amp; transcripts</p>

      {rows.length === 0 ? (
        <div className="empty">No calls yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>From</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Recording</th>
              <th>Intent</th>
              <th>Transcript</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const spam = c.spamScore != null && Number(c.spamScore) >= 0.5;
              return (
                <tr key={c.id}>
                  <td>{dateTime(c.createdAt)}</td>
                  <td>{formatPhoneDisplay(c.fromNumber)}</td>
                  <td>
                    <span className="badge">{c.voicemail ? "voicemail" : c.status}</span>
                    {spam && <span className="badge" style={{ marginLeft: 4, color: "var(--danger)" }}>spam</span>}
                  </td>
                  <td>{durationLabel(c.durationSec)}</td>
                  <td>
                    {c.recordingUrl ? (
                      <a href={c.recordingUrl} target="_blank" rel="noreferrer">
                        ▶ play
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{c.intentLabel ?? "—"}</td>
                  <td style={{ maxWidth: 320, color: "var(--muted)" }} title={c.transcript ?? ""}>
                    {c.transcript ? c.transcript.slice(0, 90) + (c.transcript.length > 90 ? "…" : "") : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
