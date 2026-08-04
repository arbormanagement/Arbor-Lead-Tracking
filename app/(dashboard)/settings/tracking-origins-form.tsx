"use client";

import { useState } from "react";

/**
 * Tracking-origins card: the sites whose pages may POST to the public tracking
 * endpoints (/api/track, /api/dni/assign). Empty falls back to the built-in
 * arbor-mgmt.com defaults; the app's own origin is always allowed.
 */
export function TrackingOriginsForm({ initialOrigins, usingDefaults }: { initialOrigins: string[]; usingDefaults: boolean }) {
  const [value, setValue] = useState(initialOrigins.join("\n"));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedOrigins: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setValue((body.allowedOrigins as string[]).join("\n"));
        setMsg({ ok: true, text: body.defaults ? "Cleared — using the defaults." : "Saved — live within a minute." });
      } else setMsg({ ok: false, text: body.error || "Save failed" });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card pad">
      <div className="label">⛨ Tracking origins</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Sites allowed to send pageviews, form leads &amp; number requests (one per line).
        {usingDefaults ? " Using defaults." : ""}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={"https://arbor-mgmt.com\nhttps://www.arbor-mgmt.com"}
        style={{
          width: "100%",
          marginTop: 10,
          padding: "6px 8px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          font: "inherit",
          fontSize: 12.5,
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button onClick={save} disabled={saving} className="pill" style={{ cursor: "pointer" }}>
          {saving ? "Saving…" : "Save"}
        </button>
        {msg && <span style={{ fontSize: 12.5, color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
