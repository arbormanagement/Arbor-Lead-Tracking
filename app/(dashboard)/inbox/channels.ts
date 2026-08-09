import { CHANNEL_META, type ThreadChannel } from "@/lib/messaging/channels";

export type Channel = ThreadChannel;

/** Tabs, in the order they matter day-to-day. `ready: false` = no ingest yet. */
export const CHANNELS: Array<{ key: Channel; label: string; ic: string; ready: boolean }> = [
  { key: "call", label: "Calls", ic: CHANNEL_META.call.ic, ready: true },
  { key: "sms", label: "Texts", ic: CHANNEL_META.sms.ic, ready: true },
  { key: "form", label: "Forms", ic: CHANNEL_META.form.ic, ready: true },
  { key: "facebook", label: "Facebook", ic: CHANNEL_META.facebook.ic, ready: true },
  // Not wired to a mailbox yet. The tab ships visible-but-empty on purpose: the
  // data model already stores email, so turning it on is an ingest route.
  { key: "email", label: "Email", ic: CHANNEL_META.email.ic, ready: false },
];

export function isChannel(v: string): v is Channel {
  return CHANNELS.some((c) => c.key === v);
}

/** Parse `?channel=` — anything unrecognized means "all channels". */
export function parseChannel(param: string | undefined): Channel | null {
  return param && isChannel(param) ? param : null;
}

export type StateFilter = "open" | "all";

export function parseState(param: string | undefined): StateFilter {
  return param === "all" ? "all" : "open";
}
