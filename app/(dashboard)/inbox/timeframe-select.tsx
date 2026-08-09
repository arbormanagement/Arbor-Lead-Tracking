"use client";

import { useRouter } from "next/navigation";
import { TIMEFRAMES } from "@/lib/timeframes";
import type { Channel } from "./channels";

/** Timeframe picker that preserves the active channel filter. */
export function TimeframeSelect({ channel, days }: { channel: Channel | null; days: number }) {
  const router = useRouter();

  const nav = (nextDays: number) => {
    const q = new URLSearchParams();
    if (channel) q.set("channel", channel);
    if (nextDays !== 30) q.set("days", String(nextDays));
    const qs = q.toString();
    router.push(qs ? `/inbox?${qs}` : "/inbox");
  };

  return (
    <select
      className={`pill-select${days !== 30 ? " on" : ""}`}
      value={days}
      onChange={(e) => nav(Number(e.target.value))}
      aria-label="Timeframe"
    >
      {TIMEFRAMES.map((t) => (
        <option key={t.days} value={t.days}>◷ {t.label}</option>
      ))}
    </select>
  );
}
