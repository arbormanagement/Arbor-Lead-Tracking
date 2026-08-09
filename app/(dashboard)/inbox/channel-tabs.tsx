"use client";

import Link from "next/link";
import { CHANNELS, type Channel } from "./channels";

/**
 * Channel filter strip. Plain links (not state) so a filtered inbox is a URL you
 * can bookmark and the server render stays cacheable per filter.
 */
export function ChannelTabs({ active, counts }: { active: Channel | null; counts: Record<Channel, number> }) {
  const tab = (href: string, label: string, ic: string, on: boolean, count?: number, dim = false) => (
    <Link
      key={href}
      href={href}
      className={on ? "pill active" : "pill"}
      style={{
        textDecoration: "none",
        opacity: dim ? 0.5 : 1,
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

  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      {tab("/inbox", "All", "◧", active === null)}
      {CHANNELS.map((c) =>
        tab(`/inbox?channel=${c.key}`, c.label, c.ic, active === c.key, counts[c.key], !c.ready),
      )}
    </div>
  );
}
