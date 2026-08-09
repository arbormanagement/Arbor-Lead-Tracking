"use client";

import Link from "next/link";
import { CHANNELS, type Channel, type StateFilter } from "./channels";

/**
 * Channel filter strip. Plain links (not state) so a filtered inbox is a URL you
 * can bookmark, and the other filters ride along instead of resetting.
 */
export function ChannelTabs({
  active,
  counts,
  state,
  days,
}: {
  active: Channel | null;
  counts: Record<Channel, number>;
  state: StateFilter;
  days: number;
}) {
  const href = (channel: Channel | null) => {
    const q = new URLSearchParams();
    if (channel) q.set("channel", channel);
    if (state !== "open") q.set("state", state);
    if (days !== 30) q.set("days", String(days));
    const qs = q.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  };

  const tab = (key: Channel | null, label: string, ic: string, count?: number, dim = false) => {
    const on = active === key;
    return (
      <Link
        key={label}
        href={href(key)}
        className={on ? "pill active" : "pill"}
        style={{
          textDecoration: "none",
          opacity: dim && !on ? 0.5 : 1,
          ...(on ? { borderColor: "var(--accent-line)", color: "var(--accent)" } : {}),
        }}
      >
        <span style={{ marginRight: 6, opacity: 0.85 }}>{ic}</span>
        {label}
        {count != null && count > 0 && (
          <span className="muted" style={{ marginLeft: 6, fontSize: 11.5 }}>{count}</span>
        )}
      </Link>
    );
  };

  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      {tab(null, "All", "◧")}
      {CHANNELS.map((c) => tab(c.key, c.label, c.ic, counts[c.key], !c.ready))}
    </div>
  );
}
