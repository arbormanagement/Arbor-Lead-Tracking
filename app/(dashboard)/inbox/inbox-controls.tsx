"use client";

import { useRouter } from "next/navigation";
import { TIMEFRAMES } from "@/lib/timeframes";
import type { Channel, StateFilter } from "./channels";

/** Timeframe + open/all filters. Each preserves the others in the URL. */
export function InboxControls({
  channel,
  days,
  state,
}: {
  channel: Channel | null;
  days: number;
  state: StateFilter;
}) {
  const router = useRouter();

  const nav = (nextDays: number, nextState: StateFilter) => {
    const q = new URLSearchParams();
    if (channel) q.set("channel", channel);
    if (nextState !== "open") q.set("state", nextState);
    if (nextDays !== 30) q.set("days", String(nextDays));
    const qs = q.toString();
    router.push(qs ? `/inbox?${qs}` : "/inbox");
  };

  return (
    <>
      <select
        className={`pill-select${state !== "open" ? " on" : ""}`}
        value={state}
        onChange={(e) => nav(days, e.target.value as StateFilter)}
        aria-label="Thread state"
      >
        <option value="open">◍ Open</option>
        <option value="all">◍ All threads</option>
      </select>
      <select
        className={`pill-select${days !== 30 ? " on" : ""}`}
        value={days}
        onChange={(e) => nav(Number(e.target.value), state)}
        aria-label="Timeframe"
      >
        {TIMEFRAMES.map((t) => (
          <option key={t.days} value={t.days}>◷ {t.label}</option>
        ))}
      </select>
    </>
  );
}
