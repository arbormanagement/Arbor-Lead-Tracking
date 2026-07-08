"use client";

import { useState } from "react";

export function RoutingForm({ initial, envFallback }: { initial: string; envFallback: string }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultForward: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setValue(body.defaultForward ?? "");
        setMsg({ ok: true, text: body.defaultForward ? "Saved." : `Cleared — using env default (${envFallback}).` });
      } else {
        setMsg({ ok: false, text: body.error || "Save failed" });
      }
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card pad" style={{ maxWidth: 520 }}>
      <div className="card-head" style={{ padding: 0, marginBottom: 12 }}>
        <h3>Default forward number</h3>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>
        Where a call rings when its tracking number has no per-number forward set. Each number
        in <a href="/numbers" style={{ color: "var(--accent)" }}>/numbers</a> can override this.
      </p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={envFallback}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
        }}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Leave blank to use the environment default ({envFallback}).
      </div>
      {msg && (
        <div style={{ marginTop: 10, fontSize: 13, color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</div>
      )}
    </div>
  );
}
