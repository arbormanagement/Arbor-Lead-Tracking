/** Inbox channel filter — shared by the page (server) and the tab strip (client). */
export type Channel = "call" | "sms" | "email";

export const CHANNELS: Array<{ key: Channel; label: string; ic: string; ready: boolean }> = [
  { key: "call", label: "Calls", ic: "☎", ready: true },
  { key: "sms", label: "Texts", ic: "💬", ready: true },
  // Not wired to a mailbox yet. The tab ships visible-but-empty on purpose: the
  // data model already stores email (channel on `messages`), so turning it on is
  // an ingest route, not a schema change.
  { key: "email", label: "Email", ic: "✉", ready: false },
];

export function isChannel(v: string): v is Channel {
  return CHANNELS.some((c) => c.key === v);
}

/** Parse `?channel=` — anything unrecognized means "all channels". */
export function parseChannel(param: string | undefined): Channel | null {
  return param && isChannel(param) ? param : null;
}
