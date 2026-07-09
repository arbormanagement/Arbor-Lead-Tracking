"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual lead / not-a-lead override. `leadId` may be null (a call with no lead row —
 * shouldn't happen, but guard). `isLead` is the current value (true/false/null). On
 * click it persists the human decision (sticky vs auto-classification).
 */
export function LeadToggle({ leadId, isLead, manual }: { leadId: string | null; isLead: boolean | null; manual: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState<boolean | null>(isLead);
  const [isManual, setIsManual] = useState(manual);

  if (!leadId) return <span className="muted" style={{ fontSize: 12 }}>—</span>;

  async function set(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isLead: next }),
      });
      if (res.ok) {
        setVal(next);
        setIsManual(true);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const pill = (active: boolean, tone: "yes" | "no"): React.CSSProperties => ({
    padding: "3px 9px",
    borderRadius: 999,
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--border)",
    background: active ? (tone === "yes" ? "var(--accent-soft)" : "var(--danger-soft)") : "transparent",
    color: active ? (tone === "yes" ? "var(--accent)" : "var(--danger)") : "var(--muted)",
    borderColor: active ? (tone === "yes" ? "var(--accent-line)" : "rgba(240,97,106,.3)") : "var(--border)",
    opacity: busy ? 0.5 : 1,
  });

  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <button onClick={() => set(true)} disabled={busy} style={pill(val === true, "yes")} title="Mark as a lead">
        Lead
      </button>
      <button onClick={() => set(false)} disabled={busy} style={pill(val === false, "no")} title="Not a lead">
        Not
      </button>
      {isManual && <span className="muted" title="Manually set — auto-classify won't change it" style={{ fontSize: 11 }}>✎</span>}
    </span>
  );
}
