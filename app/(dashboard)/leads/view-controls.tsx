"use client";

import { useRouter } from "next/navigation";
import { TIMEFRAMES } from "@/lib/timeframes";
import { DIMS, type Dim } from "./view";

/** Compact timeframe + grouping selectors — one row of dropdowns instead of
 *  stacked pill rows. Navigation is URL-driven like the rest of the page. */
export function ViewControls({ type, by, by2, days }: { type: string; by?: Dim; by2?: Dim; days: number }) {
  const router = useRouter();

  const nav = (next: Partial<{ by: string; by2: string; days: number }>) => {
    const s = { by: by ?? "", by2: by2 ?? "", days, ...next };
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (s.by) {
      q.set("by", s.by);
      if (s.by2 && s.by2 !== s.by) q.set("by2", s.by2);
    }
    if (s.days !== 90) q.set("days", String(s.days));
    const qs = q.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
  };

  return (
    <>
      <select
        className={`pill-select${days !== 90 ? " on" : ""}`}
        value={days}
        onChange={(e) => nav({ days: Number(e.target.value) })}
        aria-label="Timeframe"
      >
        {TIMEFRAMES.map((t) => (
          <option key={t.days} value={t.days}>◷ {t.label}</option>
        ))}
      </select>
      <select
        className={`pill-select${by ? " on" : ""}`}
        value={by ?? ""}
        onChange={(e) => nav({ by: e.target.value, by2: "" })}
        aria-label="Group by"
      >
        <option value="">No grouping</option>
        {DIMS.map((d) => (
          <option key={d.key} value={d.key}>Group: {d.label}</option>
        ))}
      </select>
      {by && (
        <select
          className={`pill-select${by2 ? " on" : ""}`}
          value={by2 ?? ""}
          onChange={(e) => nav({ by2: e.target.value })}
          aria-label="Then group by"
        >
          <option value="">then: —</option>
          {DIMS.filter((d) => d.key !== by).map((d) => (
            <option key={d.key} value={d.key}>then: {d.label}</option>
          ))}
        </select>
      )}
    </>
  );
}
