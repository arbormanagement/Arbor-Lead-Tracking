import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import {
  calls,
  contacts,
  conversations,
  facebookLeads,
  formSubmissions,
  leads,
  messages,
  sources,
  trackingNumbers,
} from "@/lib/db/schema";
import { dateTime, dollars, durationLabel } from "@/lib/format";
import { markThreadRead } from "@/lib/messaging/thread";
import { formatPhoneDisplay } from "@/lib/phone";
import { LeadToggle } from "../../lead-toggle";
import { stageClass } from "../../leads/stage";
import { ReplyBox } from "./reply-box";
import { ThreadStateButton } from "./thread-state";

export const dynamic = "force-dynamic";

/** One entry in the timeline, normalized across the four activity tables. */
type Entry =
  | { kind: "call"; at: Date; row: typeof calls.$inferSelect }
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

  const [row] = await db
    .select({
      thread: conversations,
      contact: contacts,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      numberLabel: trackingNumbers.friendlyName,
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(sources, eq(conversations.sourceId, sources.id))
    .leftJoin(trackingNumbers, eq(conversations.trackingNumberId, trackingNumbers.id))
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row) notFound();

  const { thread, contact } = row;

  const [callRows, messageRows, formRows, fbRows, leadRows] = await Promise.all([
    db.select().from(calls).where(eq(calls.conversationId, thread.id)).orderBy(asc(calls.createdAt)),
    db.select().from(messages).where(eq(messages.conversationId, thread.id)).orderBy(asc(messages.occurredAt)),
    db.select().from(formSubmissions).where(eq(formSubmissions.conversationId, thread.id)),
    db.select().from(facebookLeads).where(eq(facebookLeads.conversationId, thread.id)),
    db.select().from(leads).where(eq(leads.conversationId, thread.id)).orderBy(desc(leads.occurredAt)),
  ]);

  // Opening the thread is what "read" means here.
  await markThreadRead(thread.id);

  const entries: Entry[] = [
    ...callRows.map((r) => ({ kind: "call" as const, at: r.createdAt, row: r })),
    ...messageRows.map((r) => ({ kind: "message" as const, at: r.occurredAt, row: r })),
    ...formRows.map((r) => ({ kind: "form" as const, at: r.submittedAt, row: r })),
    ...fbRows.map((r) => ({ kind: "facebook" as const, at: r.createdTime ?? r.createdAt, row: r })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const who = contact.displayName || displayContact(contact.primaryPhone) || contact.primaryEmail || "Unknown";
  const current = leadRows[0] ?? null;
  const canText = Boolean(contact.primaryPhone && thread.lastEndpointKey?.startsWith("+"));

  return (
    <>
      <Link href="/inbox" className="backlink">← Inbox</Link>

      <div className="page-head">
        <div>
          <h1 className="page-title">{who}</h1>
          <p className="page-sub">
            {entries.length} {entries.length === 1 ? "interaction" : "interactions"}
            {contact.primaryPhone ? <> · {displayContact(contact.primaryPhone)}</> : null}
            {contact.primaryEmail ? <> · {contact.primaryEmail}</> : null}
            {row.sourceKey ? <> · first came via {row.sourceName ?? row.sourceKey}</> : <> · unattributed</>}
          </p>
        </div>
        <div className="controls">
          {current && <span className={stageClass(current.status)}>{current.status}</span>}
          {current && <LeadToggle leadId={current.id} isLead={current.isLead} manual={current.isLeadManual} />}
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
            if (e.kind === "call") return <CallEntry key={`c${e.row.id}`} call={e.row} />;
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
