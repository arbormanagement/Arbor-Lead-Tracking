import Link from "next/link";
import { notFound } from "next/navigation";
import type { calls, facebookLeads, formSubmissions, messages } from "@/lib/db/schema";
import { dateTime, dollars, durationLabel } from "@/lib/format";
import { markThreadRead } from "@/lib/messaging/thread";
import { getThreadDetail } from "@/lib/queries/inbox";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../../lead-toggle";
import { stageClass } from "../../stage";
import { contactName } from "../contact-name";
import { ReplyBox } from "./reply-box";
import { ThreadStateButton } from "./thread-state";

export const dynamic = "force-dynamic";

/** One entry in the timeline, normalized across the four activity tables. */
type Entry =
  | {
      kind: "call";
      at: Date;
      row: typeof calls.$inferSelect;
      dialedNumber: string | null;
      dialedName: string | null;
      leadReason: string | null;
    }
  | { kind: "message"; at: Date; row: typeof messages.$inferSelect }
  | { kind: "form"; at: Date; row: typeof formSubmissions.$inferSelect }
  | { kind: "facebook"; at: Date; row: typeof facebookLeads.$inferSelect };

/**
 * One person's whole history with us, oldest first. This is what makes the inbox
 * an inbox rather than a log: the call, the form they filled in first, and the
 * texts afterwards read as one story.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The reads live in lib/queries/inbox.ts, shared with the MCP `get_thread` tool.
  // Marking read stays HERE: opening the page is what "read" means; a tool reading
  // the thread is not the owner looking at it.
  const detail = await getThreadDetail(id);
  if (!detail) notFound();

  const { thread, contact, calls: callRows, messages: messageRows, forms: formRows, facebookLeads: fbRows, leads: leadRows } = detail;
  const row = detail;

  // Opening the thread is what "read" means here.
  await markThreadRead(thread.id);

  // "Why is this a lead (or not)?" lives on the lead, but it's the call it was
  // judged from — so surface it on the call card where the transcript is.
  const reasonByLead = new Map(leadRows.map((l) => [l.id, l.leadReason]));

  const entries: Entry[] = [
    ...callRows.map((r) => ({
      kind: "call" as const,
      at: r.call.createdAt,
      row: r.call,
      dialedNumber: r.dialedNumber,
      dialedName: r.dialedName,
      leadReason: r.call.leadId ? reasonByLead.get(r.call.leadId) ?? null : null,
    })),
    ...messageRows.map((r) => ({ kind: "message" as const, at: r.occurredAt, row: r })),
    ...formRows.map((r) => ({ kind: "form" as const, at: r.submittedAt, row: r })),
    ...fbRows.map((r) => ({ kind: "facebook" as const, at: r.createdTime ?? r.createdAt, row: r })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const who =
    contactName({ name: contact.displayName, hcpFirst: row.hcpFirst, hcpLast: row.hcpLast }) ||
    displayContact(contact.primaryPhone) ||
    contact.primaryEmail ||
    "Unknown";
  const current = leadRows[0] ?? null;
  const canText = Boolean(contact.primaryPhone && thread.lastEndpointKey?.startsWith("+"));

  return (
    <>
      <Link href="/inbox" className="backlink">← Inbox</Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">
            {who}
            {row.hcpExternalId && (
              <span
                className="badge"
                title={`HousecallPro customer ${row.hcpExternalId}`}
                style={{ marginLeft: 10, fontSize: 11, verticalAlign: "middle" }}
              >
                HCP customer
              </span>
            )}
          </h1>
          <p className="page-sub">
            {entries.length} {entries.length === 1 ? "interaction" : "interactions"}
            {contact.primaryPhone ? <> · {displayContact(contact.primaryPhone)}</> : null}
            {contact.primaryEmail ? <> · {contact.primaryEmail}</> : null}
            {row.sourceKey ? <> · first came via {row.sourceName ?? row.sourceKey}</> : <> · unattributed</>}
          </p>
        </div>
        <div className="controls">
          {current && <span className={stageClass(current.status)}>{current.status}</span>}
          {current && <LeadToggle leadId={current.id} disposition={current.disposition} manual={current.dispositionManual} />}
          {current && <Link href={`/leads/${current.id}`} className="btn">Lead detail</Link>}
          <ThreadStateButton conversationId={thread.id} state={thread.state} />
        </div>
      </div>

      {leadRows.length > 1 && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          {leadRows.length} separate enquiries from this person over time —{" "}
          {leadRows.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ", "}
              <Link href={`/leads/${l.id}`} className="link">{dateTime(l.occurredAt)}</Link>
            </span>
          ))}
        </p>
      )}

      {current && (current.quoteValueCents || current.salesValueCents) ? (
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 13 }}>
          {current.quoteValueCents ? <>{dollars(current.quoteValueCents)} quoted</> : null}
          {current.quoteValueCents && current.salesValueCents ? " · " : null}
          {current.salesValueCents ? (
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(current.salesValueCents)} won</span>
          ) : null}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <div className="empty">Nothing recorded on this thread yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map((e) => {
            if (e.kind === "call") return <CallEntry key={`c${e.row.id}`} entry={e} />;
            if (e.kind === "message") return <MessageEntry key={`m${e.row.id}`} message={e.row} />;
            if (e.kind === "form") return <FormEntry key={`f${e.row.id}`} form={e.row} />;
            return <FacebookEntry key={`fb${e.row.id}`} fb={e.row} />;
          })}
        </div>
      )}

      <ReplyBox
        conversationId={thread.id}
        canText={canText}
        optedOut={Boolean(contact.smsOptedOutAt)}
        fromNumber={thread.lastEndpointKey}
        fromLabel={row.numberLabel}
      />
    </>
  );
}

/** One definition row, skipped entirely when there's nothing to say. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  if (children == null || children === "" || children === false) return null;
  return (
    <div className="def">
      <span className="def-k">{label}</span>
      <span className="def-v">{children}</span>
    </div>
  );
}

function CallEntry({
  entry,
}: {
  entry: { row: typeof calls.$inferSelect; dialedNumber: string | null; dialedName: string | null; leadReason: string | null };
}) {
  const { row: call, dialedNumber, dialedName, leadReason } = entry;
  const voicemail = call.voicemail && !call.answered;
  const status = voicemail ? "voicemail" : call.status ?? "—";
  const spamScore = call.spamScore != null ? Number(call.spamScore) : null;
  const confidence = call.transcriptConfidence != null ? Number(call.transcriptConfidence) : null;

  return (
    <div className="card">
      <div className="card-head">
        <h3>☎ Call</h3>
        <span className="muted">{dateTime(call.createdAt)}</span>
      </div>
      <div className="card-body">
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <span className={call.answered ? "badge win" : voicemail ? "badge warn" : "badge"}>{status}</span>
          {call.durationSec ? <span className="mono muted">{durationLabel(call.durationSec)}</span> : null}
          {call.intentLabel && <span className="badge">{call.intentLabel}</span>}
          {spamScore != null && spamScore >= 0.5 && <span className="badge bad">spam {spamScore.toFixed(2)}</span>}
        </div>

        {call.summary && <p style={{ margin: "0 0 12px" }}>{call.summary}</p>}

        <div className="def-list" style={{ marginBottom: call.recordingUrl || call.transcript ? 12 : 0 }}>
          <Row label="They dialed">
            {dialedNumber ? formatPhoneDisplay(dialedNumber) : null}
            {dialedName ? <span className="muted"> · {dialedName}</span> : null}
          </Row>
          <Row label="Rang">{call.toDestination ? formatPhoneDisplay(call.toDestination) : null}</Row>
          <Row label="Heard via">
            {call.selfReportedSource ? <span className="badge info">{call.selfReportedSource}</span> : null}
          </Row>
          <Row label="Lead reason">{leadReason}</Row>
        </div>

        {call.recordingUrl ? (
          <audio controls preload="none" style={{ width: "100%", height: 34 }} src={`/api/calls/${call.id}/recording`} />
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            {call.answered ? "No recording saved for this call." : "Not answered — nothing recorded."}
          </p>
        )}

        {call.transcript ? (
          // Collapsed by default: a five-minute call is a wall of text, and the
          // summary above is usually the answer. Open it when you want the words.
          <details style={{ marginTop: 12 }}>
            <summary
              style={{ cursor: "pointer", fontSize: 12.5, color: "var(--muted)", userSelect: "none" }}
            >
              Transcript
              {confidence != null ? ` · ${Math.round(confidence * 100)}% confidence` : ""}
              {call.transcriptProvider ? ` · ${call.transcriptProvider}` : ""}
            </summary>
            <div className="transcript" aria-label="Call transcript">{call.transcript}</div>
          </details>
        ) : call.recordingUrl ? (
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>
            {call.transcribeError
              ? `Transcription failed: ${call.transcribeError}`
              : "Transcript pending — transcription runs every 10 minutes."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MessageEntry({ message }: { message: typeof messages.$inferSelect }) {
  const inbound = message.direction === "inbound";
  const media = Array.isArray(message.media) ? (message.media as Array<{ url?: string; contentType?: string }>) : [];
  const failed = message.status === "failed";
  return (
    <div
      className="card"
      // Outbound sits inset and lighter, so the customer's side reads down the left.
      style={inbound ? undefined : { marginLeft: "12%", background: "var(--panel-2)" }}
    >
      <div className="card-head">
        <h3>
          {message.channel === "email" ? "✉" : "💬"} {inbound ? "Received" : "Sent"}
          {message.subject ? <span className="muted" style={{ fontWeight: 400 }}> · {message.subject}</span> : null}
        </h3>
        <span className="muted">{dateTime(message.occurredAt)}</span>
      </div>
      <div className="card-body">
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {message.body?.trim() || <span className="muted">(no text)</span>}
        </p>
        {media.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            {media.map((m, i) => (
              <div key={i}>📎 {m.contentType ?? "attachment"}</div>
            ))}
          </div>
        )}
        {message.status && message.status !== "received" && (
          <div style={{ fontSize: 11, marginTop: 6, color: failed ? "var(--danger)" : "var(--muted)" }}>
            {failed ? "failed to send" : message.status}
            {message.errorCode ? ` (Twilio ${message.errorCode})` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function FormEntry({ form }: { form: typeof formSubmissions.$inferSelect }) {
  const fields = form.fields && typeof form.fields === "object" ? (form.fields as Record<string, unknown>) : {};
  const entries = Object.entries(fields).filter(([, v]) => typeof v === "string" || typeof v === "number");
  return (
    <div className="card">
      <div className="card-head">
        <h3>▤ Website form</h3>
        <span className="muted">{dateTime(form.submittedAt)}</span>
      </div>
      <div className="card-body">
        <div className="def-list">
          {form.pageUrl && (
            <div className="def"><span className="def-k">Page</span><span className="def-v">{form.pageUrl}</span></div>
          )}
          {entries.map(([k, v]) => (
            <div className="def" key={k}>
              <span className="def-k">{k.replace(/_/g, " ")}</span>
              <span className="def-v">{String(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FacebookEntry({ fb }: { fb: typeof facebookLeads.$inferSelect }) {
  const fields = fb.fields && typeof fb.fields === "object" ? (fb.fields as Record<string, unknown>) : {};
  const entries = Object.entries(fields).filter(([, v]) => typeof v === "string" || typeof v === "number");
  return (
    <div className="card">
      <div className="card-head">
        <h3>ⓕ Facebook lead form</h3>
        <span className="muted">{dateTime(fb.createdTime ?? fb.createdAt)}</span>
      </div>
      <div className="card-body">
        <div className="def-list">
          {entries.map(([k, v]) => (
            <div className="def" key={k}>
              <span className="def-k">{k.replace(/_/g, " ")}</span>
              <span className="def-v">{String(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function displayContact(value: string | null): string {
  if (!value) return "";
  return value.includes("@") ? value : formatPhoneDisplay(value) || value;
}
