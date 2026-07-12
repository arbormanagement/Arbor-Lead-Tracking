"use client";

import { useState } from "react";

/**
 * Attribution options card: single-touch model (last/first) + the customer window
 * for repeat business. Changes apply retroactively on the next attribution rebuild.
 */
export function AttributionForm({ initialModel, initialWindowDays }: { initialModel: string; initialWindowDays: number }) {
  const [model, setModel] = useState(initialModel);
  const [windowDays, setWindowDays] = useState(String(initialWindowDays));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(nextModel: string, nextWindow: string) {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/attribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: nextModel, customerWindowDays: Number(nextWindow) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setMsg({ ok: true, text: "Saved — applies on the next attribution run." });
      else setMsg({ ok: false, text: body.error || "Save failed" });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  const pill = (value: string, label: string) => (
    <button
      onClick={() => {
        setModel(value);
        save(value, windowDays);
      }}
      disabled={saving}
      className="pill"
      style={
        model === value
          ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)", cursor: "pointer" }
          : { cursor: "pointer" }
      }
    >
      {label}
    </button>
  );

  return (
    <div className="card pad">
      <div className="label">◈ Attribution</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        {pill("last_touch", "Last touch")}
        {pill("first_touch", "First touch")}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Which lead gets credit when a contact has several. Retroactive — the hourly rebuild reclassifies history.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Repeat-customer window</span>
        <input
          type="number"
          min={0}
          max={365}
          value={windowDays}
          onChange={(e) => setWindowDays(e.target.value)}
          onBlur={() => save(model, windowDays)}
          style={{
            width: 70,
            padding: "6px 8px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text)",
          }}
        />
        <span className="muted" style={{ fontSize: 12.5 }}>days</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Repeat jobs within this window credit the source that originally won the customer. 0 disables.
      </div>
      {msg && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</div>
      )}
    </div>
  );
}
