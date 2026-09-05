"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The disposition control: why nothing (or something) came of this enquiry.
 * Persists a human decision, which the classifiers then never overwrite; "Pending"
 * clears the override back to automatic. See leadDispositionEnum in lib/db/schema.ts.
 * `leadId` may be null (a call with no lead row — shouldn't happen, but guard).
 */
const OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "", label: "Pending", title: "Nobody has decided yet (automatic)" },
  { value: "requested_work", label: "Lead", title: "Asked for tree work / an estimate" },
  { value: "not_business", label: "Not business", title: "Vendor, recruiter, wrong number" },
  { value: "existing_customer", label: "Existing customer", title: "Service, scheduling or billing on work already sold" },
  { value: "missed", label: "Missed", title: "A real request nobody wrote an estimate for" },
  { value: "spam", label: "Spam", title: "Robocall, scam, junk form" },
  { value: "test", label: "Test", title: "Our own synthetic traffic — excluded from every count, like spam" },
];

export function LeadToggle({
  leadId,
  disposition,
  manual,
}: {
  leadId: string | null;
  disposition: string | null;
  manual: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [val, setVal] = useState<string>(disposition ?? "");
  const [isManual, setIsManual] = useState(manual);

  if (!leadId) return <span className="muted" style={{ fontSize: 12 }}>—</span>;

  async function set(next: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/disposition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: next || null }),
      });
      if (res.ok) {
        const body = (await res.json()) as { disposition: string | null; dispositionManual: boolean };
        setVal(body.disposition ?? "");
        setIsManual(body.dispositionManual);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const tone = val === "requested_work" ? "var(--accent)" : val === "spam" || val === "not_business" ? "var(--danger)" : "var(--muted)";

  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <select
        value={val}
        disabled={busy}
        onChange={(e) => set(e.target.value)}
        title={OPTIONS.find((o) => o.value === val)?.title}
        style={{
          padding: "3px 8px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 600,
          border: "1px solid var(--border)",
          background: "transparent",
          color: tone,
          opacity: busy ? 0.5 : 1,
        }}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
      {isManual && <span className="muted" title="Manually set — the classifiers won't change it" style={{ fontSize: 11 }}>✎</span>}
    </span>
  );
}
