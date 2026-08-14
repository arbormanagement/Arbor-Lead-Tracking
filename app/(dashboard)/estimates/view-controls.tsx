"use client";

import { useRouter } from "next/navigation";
import { TIMEFRAMES } from "@/lib/timeframes";
import { DIMS, MAX_GROUPS, type Dim } from "./view";

/** Compact timeframe + grouping controls. Groupings are an editable list:
 *  each active one is a chip (change via its select, remove via ×) and a
 *  trailing "+ Group" select adds the next level. URL-driven (?g=a,b&days=N). */
export function ViewControls({ groups, days }: { groups: Dim[]; days: number }) {
  const router = useRouter();

  const nav = (nextGroups: Dim[], nextDays: number = days) => {
    const q = new URLSearchParams();
    if (nextGroups.length) q.set("g", nextGroups.join(","));
    if (nextDays !== 90) q.set("days", String(nextDays));
    const qs = q.toString();
    router.push(qs ? `/estimates?${qs}` : "/estimates");
  };

  const label = (d: Dim) => DIMS.find((x) => x.key === d)!.label;
  const unused = DIMS.filter((d) => !groups.includes(d.key));

  return (
    <>
      <select
        className={`pill-select${days !== 90 ? " on" : ""}`}
        value={days}
        onChange={(e) => nav(groups, Number(e.target.value))}
        aria-label="Timeframe"
      >
        {TIMEFRAMES.map((t) => (
          <option key={t.days} value={t.days}>◷ {t.label}</option>
        ))}
      </select>

      {groups.map((g, i) => (
        <span key={g} className="pill-select on" style={{ display: "inline-flex", alignItems: "center", padding: 0 }}>
          <select
            value={g}
            onChange={(e) => nav(groups.map((x, j) => (j === i ? (e.target.value as Dim) : x)))}
            aria-label={`Grouping ${i + 1}`}
            style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", padding: "7px 0 7px 10px", cursor: "pointer" }}
          >
            <option value={g}>{label(g)}</option>
            {unused.map((d) => (
              <option key={d.key} value={d.key}>{d.label}</option>
            ))}
          </select>
          <button
            onClick={() => nav(groups.filter((_, j) => j !== i))}
            aria-label={`Remove ${label(g)} grouping`}
            title="Remove grouping"
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 14, padding: "0 9px 0 5px", lineHeight: 1 }}
          >
            ×
          </button>
        </span>
      ))}

      {groups.length < MAX_GROUPS && (
        <select
          className="pill-select"
          value=""
          onChange={(e) => e.target.value && nav([...groups, e.target.value as Dim])}
          aria-label="Add grouping"
        >
          <option value="">+ Group</option>
          {unused.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      )}
    </>
  );
}
