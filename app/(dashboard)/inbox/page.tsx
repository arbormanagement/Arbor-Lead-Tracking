import { and, desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/lib/db/client";
import { calls, leads, messages } from "@/lib/db/schema";
import { dateTime, durationLabel } from "@/lib/format";
import { formatPhoneDisplay } from "@/lib/phone";
import { pickDays, timeframeLabel } from "@/lib/timeframes";
import { LeadToggle } from "../lead-toggle";
import { ChannelTabs } from "./channel-tabs";
import { parseChannel, type Channel } from "./channels";
import { TimeframeSelect } from "./timeframe-select";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 200;

/**
 * One inbound contact, whatever channel it arrived on — the unit the inbox lists.
 * Calls and messages are separate tables (a recording and a message body have
 * nothing in common) so they're normalized to this shape and merged in memory.
 */
interface Item {
  key: string;
  channel: Channel;
  at: Date;
  contact: string | null;
  leadId: string | null;
  conversationId: string | null;
  isLead: boolean | null;
  isLeadManual: boolean;
  // Call-shaped
  status?: string | null;
  answered?: boolean | null;
  voicemail?: boolean | null;
  durationSec?: number | null;
  callId?: string | null;
  hasRecording?: boolean;
  intentLabel?: string | null;
  summary?: string | null;
  transcript?: string | null;
  selfReportedSource?: string | null;
  spamScore?: string | null;
  // Message-shaped
  direction?: "inbound" | "outbound";
  body?: string | null;
  mediaCount?: number;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; days?: string }>;
}) {
  const { channel: channelParam, days: daysParam } = await searchParams;
  const channel = parseChannel(channelParam);
  const days = pickDays(daysParam, 30);
  const since = new Date(Date.now() - days * 86_400_000);

  // Fetch only what the active filter needs — "Texts" shouldn't pay for a scan of
  // the calls table. Each side is capped, then the merge is capped again.
  const [callRows, messageRows, counts] = await Promise.all([
    channel === "sms" || channel === "email"
      ? Promise.resolve([])
      : db
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
            conversationId: calls.conversationId,
            isLead: leads.isLead,
            isLeadManual: leads.isLeadManual,
          })
          .from(calls)
          .leftJoin(leads, eq(calls.leadId, leads.id))
          .where(gte(calls.createdAt, since))
          .orderBy(desc(calls.createdAt))
          .limit(ROW_LIMIT),
    channel === "call"
      ? Promise.resolve([])
      : db
          .select({
            id: messages.id,
            occurredAt: messages.occurredAt,
            channel: messages.channel,
            direction: messages.direction,
            fromAddress: messages.fromAddress,
            toAddress: messages.toAddress,
            body: messages.body,
            media: messages.media,
            leadId: messages.leadId,
            conversationId: messages.conversationId,
            isLead: leads.isLead,
            isLeadManual: leads.isLeadManual,
          })
          .from(messages)
          .leftJoin(leads, eq(messages.leadId, leads.id))
          .where(
            channel
              ? and(gte(messages.occurredAt, since), eq(messages.channel, channel))
              : gte(messages.occurredAt, since),
          )
          .orderBy(desc(messages.occurredAt))
          .limit(ROW_LIMIT),
    channelCounts(since),
  ]);

  const items: Item[] = [
    ...callRows.map((c) => ({
      key: `call:${c.id}`,
      channel: "call" as const,
      at: c.createdAt,
      contact: c.fromNumber,
      leadId: c.leadId,
      conversationId: c.conversationId,
      isLead: c.isLead,
      isLeadManual: c.isLeadManual ?? false,
      status: c.status,
      answered: c.answered,
      voicemail: c.voicemail,
      durationSec: c.durationSec,
      callId: c.id,
      hasRecording: Boolean(c.recordingUrl),
      intentLabel: c.intentLabel,
      summary: c.summary,
      transcript: c.transcript,
      selfReportedSource: c.selfReportedSource,
      spamScore: c.spamScore,
    })),
    ...messageRows.map((m) => ({
      key: `msg:${m.id}`,
      channel: m.channel as Channel,
      at: m.occurredAt,
      // Show the customer, not us: on an outbound message that's the recipient.
      contact: m.direction === "outbound" ? m.toAddress : m.fromAddress,
      leadId: m.leadId,
      conversationId: m.conversationId,
      isLead: m.isLead,
      isLeadManual: m.isLeadManual ?? false,
      direction: m.direction as "inbound" | "outbound",
      body: m.body,
      mediaCount: Array.isArray(m.media) ? m.media.length : 0,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, ROW_LIMIT);

  const total = counts.call + counts.sms + counts.email;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Inbox</h1>
          <p className="page-sub">
            Everything that came in — calls and texts in one place · {total} in {timeframeLabel(days)} ·{" "}
            <Link href="/leads" className="link">Leads</Link> holds the confirmed estimate requests
          </p>
        </div>
        <div className="controls">
          <TimeframeSelect channel={channel} days={days} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <ChannelTabs active={channel} counts={counts} />
      </div>

      {items.length === 0 ? (
        <div className="empty">{emptyMessage(channel)}</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Channel</th>
                <th>Contact</th>
                <th>What happened</th>
                <th>Lead?</th>
              </tr>
            </thead>
            <tbody>{items.map((item) => <InboxRow key={item.key} item={item} />)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}

function InboxRow({ item }: { item: Item }) {
  return (
    <tr>
      <td className="muted mono nowrap">{dateTime(item.at)}</td>
      <td className="nowrap">
        <span className="src">
          <span style={{ opacity: 0.85 }}>{item.channel === "call" ? "☎" : item.channel === "sms" ? "💬" : "✉"}</span>
          {item.channel === "call" ? "Call" : item.channel === "sms" ? "Text" : "Email"}
        </span>
        {item.direction === "outbound" && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>sent</div>
        )}
      </td>
      <td className="nowrap" style={{ fontWeight: 600 }}>
        {item.conversationId ? (
          <Link href={`/inbox/${item.conversationId}`} className="rowlink">{displayContact(item.contact)}</Link>
        ) : item.leadId ? (
          <Link href={`/leads/${item.leadId}`} className="rowlink">{displayContact(item.contact)}</Link>
        ) : (
          displayContact(item.contact)
        )}
      </td>
      <td style={{ maxWidth: 460, fontSize: 12.5 }}>
        {item.channel === "call" ? <CallCell item={item} /> : <MessageCell item={item} />}
      </td>
      <td>
        <LeadToggle leadId={item.leadId} isLead={item.isLead} manual={item.isLeadManual} />
      </td>
    </tr>
  );
}

function CallCell({ item }: { item: Item }) {
  const spam = item.spamScore != null && Number(item.spamScore) >= 0.5;
  const voicemail = item.voicemail && !item.answered;
  const status = voicemail ? "voicemail" : item.status ?? "—";
  return (
    <>
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
        <span className={item.answered ? "badge win" : voicemail ? "badge warn" : "badge"}>{status}</span>
        {spam && <span className="badge bad">spam</span>}
        {item.durationSec ? <span className="mono muted">{durationLabel(item.durationSec)}</span> : null}
        {item.intentLabel && <span className="badge">{item.intentLabel}</span>}
        {item.hasRecording && item.callId && (
          <audio controls preload="none" style={{ height: 30, maxWidth: 200 }} src={`/api/calls/${item.callId}/recording`} />
        )}
      </div>
      {(item.summary || item.transcript) && (
        <div style={{ marginTop: 4 }} title={item.transcript ?? ""}>
          {item.summary ?? (
            <span className="muted">
              {item.transcript!.slice(0, 110) + (item.transcript!.length > 110 ? "…" : "")}
            </span>
          )}
        </div>
      )}
      {item.selfReportedSource && (
        <div className="muted" style={{ marginTop: 3, fontSize: 11 }}>
          heard via: <span className="badge info" style={{ fontSize: 10.5 }}>{item.selfReportedSource}</span>
        </div>
      )}
    </>
  );
}

function MessageCell({ item }: { item: Item }) {
  return (
    <>
      <div style={{ whiteSpace: "pre-wrap" }}>
        {item.body?.trim() || <span className="muted">(no text)</span>}
      </div>
      {item.mediaCount ? (
        <div className="muted" style={{ marginTop: 3, fontSize: 11 }}>
          📎 {item.mediaCount} attachment{item.mediaCount === 1 ? "" : "s"}
        </div>
      ) : null}
    </>
  );
}

function displayContact(contact: string | null): string {
  if (!contact) return "—";
  // Emails pass through; phones get formatted.
  return contact.includes("@") ? contact : formatPhoneDisplay(contact) || contact;
}

function emptyMessage(channel: Channel | null): string {
  if (channel === "email") {
    return "Email isn't connected yet. The inbox is built for it — texts and calls land here today.";
  }
  if (channel === "sms") {
    return "No texts yet. Once a tracking number's SMS webhook is live, inbound texts land here.";
  }
  if (channel === "call") return "No calls in this window.";
  return "Nothing captured in this window.";
}

/** Per-channel totals for the tab badges — counted, not fetched. */
async function channelCounts(since: Date): Promise<Record<Channel, number>> {
  const [callAgg, msgAgg] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(calls)
      .where(gte(calls.createdAt, since)),
    db
      .select({ channel: messages.channel, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(gte(messages.occurredAt, since))
      .groupBy(messages.channel),
  ]);

  const counts: Record<Channel, number> = { call: callAgg[0]?.n ?? 0, sms: 0, email: 0 };
  for (const row of msgAgg) counts[row.channel as "sms" | "email"] = row.n;
  return counts;
}
