import Link from "next/link";
import { dateTime } from "@/lib/format";
import { CHANNEL_META, type ThreadChannel } from "@/lib/messaging/channels";
import { formatPhoneDisplay } from "@/lib/phone";
import { listThreads } from "@/lib/queries/inbox";
import { pickDays, timeframeLabel } from "@/lib/timeframes";
import { ChannelTabs } from "./channel-tabs";
import { contactName } from "./contact-name";
import { parseChannel, parseState, type Channel } from "./channels";
import { InboxControls } from "./inbox-controls";

export const dynamic = "force-dynamic";

const ROW_LIMIT = 200;

/**
 * The inbox: one row per person, newest activity first — every way they've
 * reached us folded into a single thread. `/estimates` is the opportunity view of the
 * same underlying activity, showing only what turned out to be an estimate request.
 *
 * The query lives in lib/queries/inbox.ts, shared with the MCP `list_threads`
 * tool so the two surfaces cannot disagree.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; days?: string; state?: string }>;
}) {
  const { channel: channelParam, days: daysParam, state: stateParam } = await searchParams;
  const channel = parseChannel(channelParam);
  const state = parseState(stateParam);
  const days = pickDays(daysParam, 30);

  const { threads, counts } = await listThreads({ days, channel, state, limit: ROW_LIMIT });

  const unread = threads.reduce((n, t) => n + (t.unreadCount > 0 ? 1 : 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Inbox</h1>
          <p className="page-sub">
            Every way customers reach us, one thread per person · {threads.length} conversation
            {threads.length === 1 ? "" : "s"} in {timeframeLabel(days)}
            {unread > 0 ? ` · ${unread} unread` : ""} ·{" "}
            <Link href="/estimates" className="link">Estimates</Link> is the opportunity view
          </p>
        </div>
        <div className="controls">
          <InboxControls channel={channel} days={days} state={state} />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <ChannelTabs active={channel} counts={counts} state={state} days={days} />
      </div>

      {threads.length === 0 ? (
        <div className="empty">{emptyMessage(channel, state)}</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}></th>
                <th>Contact</th>
                <th>Channels</th>
                <th>Latest</th>
                <th className="nowrap" style={{ textAlign: "right" }}>When</th>
              </tr>
            </thead>
            <tbody>
              {threads.map((t) => {
                const unreadRow = t.unreadCount > 0;
                return (
                  <tr key={t.id} style={t.state === "closed" ? { opacity: 0.55 } : undefined}>
                    <td style={{ textAlign: "center" }}>
                      {unreadRow ? (
                        <span
                          title={`${t.unreadCount} unread`}
                          style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            background: "var(--accent)",
                          }}
                        />
                      ) : t.state === "closed" ? (
                        <span className="muted" title="Closed">✓</span>
                      ) : null}
                    </td>
                    <td>
                      <Link href={`/inbox/${t.id}`} className="rowlink">
                        <div style={{ fontWeight: unreadRow ? 700 : 600 }}>
                          {contactName(t) || displayContact(t.phone) || t.email || "Unknown"}
                          {t.hcpFirst || t.hcpLast ? (
                            <span
                              className="badge"
                              title="Existing HousecallPro customer"
                              style={{ marginLeft: 7, fontSize: 10, fontWeight: 600 }}
                            >
                              customer
                            </span>
                          ) : null}
                        </div>
                        {(contactName(t) || t.email) && t.phone && (
                          <div className="muted nowrap" style={{ fontSize: 12 }}>{displayContact(t.phone)}</div>
                        )}
                      </Link>
                    </td>
                    <td className="nowrap">
                      {(t.channels as ThreadChannel[]).map((c) => (
                        <span key={c} title={CHANNEL_META[c]?.label ?? c} style={{ marginRight: 5, opacity: 0.85 }}>
                          {CHANNEL_META[c]?.ic ?? "•"}
                        </span>
                      ))}
                      {t.optedOut && (
                        <span className="badge bad" style={{ fontSize: 10.5, marginLeft: 4 }} title="Replied STOP — texting blocked">
                          opted out
                        </span>
                      )}
                    </td>
                    <td style={{ maxWidth: 460, fontSize: 12.5 }}>
                      {t.lastDirection === "outbound" && <span className="muted">You: </span>}
                      {t.lastPreview ?? <span className="muted">—</span>}
                    </td>
                    <td className="muted mono nowrap" style={{ textAlign: "right" }}>
                      {dateTime(t.lastActivityAt)}
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

function displayContact(contact: string | null): string {
  if (!contact) return "";
  return contact.includes("@") ? contact : formatPhoneDisplay(contact) || contact;
}

function emptyMessage(channel: Channel | null, state: "open" | "all"): string {
  if (channel === "email") {
    return "Email isn't connected yet. The inbox is built for it — calls, texts, forms and Facebook leads land here today.";
  }
  if (state === "open") return "Nothing open in this window. Switch to All to see closed threads.";
  return "Nothing captured in this window.";
}
