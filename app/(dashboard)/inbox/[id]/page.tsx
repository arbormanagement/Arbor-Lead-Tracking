import { asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { calls, conversations, leads, messages, sources, trackingNumbers } from "@/lib/db/schema";
import { dateTime, dollars, durationLabel } from "@/lib/format";
import { markThreadRead } from "@/lib/messaging/thread";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../../lead-toggle";
import { stageClass } from "../../leads/stage";

export const dynamic = "force-dynamic";

/** A thread entry, normalized across calls and messages so it renders as one timeline. */
type Entry =
  | { kind: "call"; at: Date; row: typeof calls.$inferSelect }
  | { kind: "message"; at: Date; row: typeof messages.$inferSelect };

/**
 * One conversation: every call and text with a contact on a given number, oldest
 * first. This is what makes the inbox an inbox rather than a log — a customer who
 * called on Tuesday and texted on Thursday reads as one story, with the
 * attribution the thread was opened with.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [row] = await db
    .select({
      thread: conversations,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      numberLabel: trackingNumbers.friendlyName,
      lead: leads,
    })
    .from(conversations)
    .leftJoin(sources, eq(conversations.sourceId, sources.id))
    .leftJoin(trackingNumbers, eq(conversations.trackingNumberId, trackingNumbers.id))
    .leftJoin(leads, eq(conversations.leadId, leads.id))
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row) notFound();

  const thread = row.thread;
  const [callRows, messageRows] = await Promise.all([
    db.select().from(calls).where(eq(calls.conversationId, thread.id)).orderBy(asc(calls.createdAt)),
    db.select().from(messages).where(eq(messages.conversationId, thread.id)).orderBy(asc(messages.occurredAt)),
  ]);

  // Opening the thread is what "read" means here.
  await markThreadRead(thread.id);

  const entries: Entry[] = [
    ...callRows.map((c) => ({ kind: "call" as const, at: c.createdAt, row: c })),
    ...messageRows.map((m) => ({ kind: "message" as const, at: m.occurredAt, row: m })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const who = thread.contactName || displayContact(thread.contactKey);
  const lead = row.lead;

  return (
    <>
      <Link href="/inbox" className="backlink">← Inbox</Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{who}</h1>
          <p className="page-sub">
            {entries.length} {entries.length === 1 ? "interaction" : "interactions"} ·{" "}
            reached {row.numberLabel ? `${row.numberLabel} ` : ""}
            {displayContact(thread.endpointKey)}
            {row.sourceKey ? <> · via {row.sourceName ?? row.sourceKey}</> : <> · unattributed</>}
          </p>
        </div>
        <div className="controls">
          {lead && <span className={stageClass(lead.status)}>{lead.status}</span>}
          {lead && <LeadToggle leadId={lead.id} isLead={lead.isLead} manual={lead.isLeadManual} />}
          {lead && <Link href={`/leads/${lead.id}`} className="btn">Lead detail</Link>}
        </div>
      </div>

      {lead && (lead.quoteValueCents || lead.salesValueCents) ? (
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 13 }}>
          {lead.quoteValueCents ? <>{dollars(lead.quoteValueCents)} quoted</> : null}
          {lead.quoteValueCents && lead.salesValueCents ? " · " : null}
          {lead.salesValueCents ? (
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(lead.salesValueCents)} won</span>
          ) : null}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <div className="empty">Nothing recorded on this thread yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {entries.map((e) =>
            e.kind === "call" ? <CallEntry key={`c${e.row.id}`} call={e.row} /> : <MessageEntry key={`m${e.row.id}`} message={e.row} />,
          )}
        </div>
      )}

      {messageRows.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          Replies are sent from your own phone — texts are relayed there as they arrive. Sending from
          this app needs an A2P 10DLC campaign registered for the Arbor numbers first.
        </p>
      )}
    </>
  );
}

function CallEntry({ call }: { call: typeof calls.$inferSelect }) {
  const voicemail = call.voicemail && !call.answered;
  const status = voicemail ? "voicemail" : call.status ?? "—";
  return (
    <div className="card">
      <div className="card-head">
        <h3>☎ Call</h3>
        <span className="muted">{dateTime(call.createdAt)}</span>
      </div>
      <div className="card-body">
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span className={call.answered ? "badge win" : voicemail ? "badge warn" : "badge"}>{status}</span>
          {call.durationSec ? <span className="mono muted">{durationLabel(call.durationSec)}</span> : null}
          {call.intentLabel && <span className="badge">{call.intentLabel}</span>}
        </div>
        {call.summary && <p style={{ margin: "0 0 8px" }}>{call.summary}</p>}
        {call.recordingUrl && (
          <audio controls preload="none" style={{ width: "100%", height: 34 }} src={`/api/calls/${call.id}/recording`} />
        )}
        {call.transcript && <div className="transcript" aria-label="Call transcript">{call.transcript}</div>}
      </div>
    </div>
  );
}

function MessageEntry({ message }: { message: typeof messages.$inferSelect }) {
  const inbound = message.direction === "inbound";
  const media = Array.isArray(message.media) ? (message.media as Array<{ url?: string; contentType?: string }>) : [];
  return (
    <div
      className="card"
      // Outbound sits inset and lighter, so the customer's side of the thread reads
      // down the left edge at a glance.
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
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {message.status}
            {message.errorCode ? ` (${message.errorCode})` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function displayContact(value: string | null): string {
  if (!value) return "—";
  return value.includes("@") ? value : formatPhoneDisplay(value) || value;
}
