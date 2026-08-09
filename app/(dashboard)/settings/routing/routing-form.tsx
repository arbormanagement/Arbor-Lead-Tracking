"use client";

import { useState } from "react";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text)",
};

/** One saved routing field. Each card posts only its own key, so saving the text
 *  relay can't disturb call forwarding (and vice versa). */
function RoutingField({
  title,
  field,
  initial,
  placeholder,
  clearedText,
  children,
  hint,
}: {
  title: string;
  field: "defaultForward" | "smsForward";
  initial: string;
  placeholder: string;
  clearedText: string;
  children: React.ReactNode;
  hint: string;
}) {
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
        body: JSON.stringify({ [field]: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setValue(body[field] ?? "");
        setMsg({ ok: true, text: body[field] ? "Saved." : clearedText });
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
        <h3>{title}</h3>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0, marginBottom: 12 }}>{children}</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} style={inputStyle} />
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{hint}</div>
      {msg && (
        <div style={{ marginTop: 10, fontSize: 13, color: msg.ok ? "var(--accent)" : "var(--danger)" }}>{msg.text}</div>
      )}
    </div>
  );
}

export function RoutingForm({
  initial,
  envFallback,
  initialSms,
  smsEnvFallback,
}: {
  initial: string;
  envFallback: string;
  initialSms: string;
  smsEnvFallback: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <RoutingField
        title="Default forward number"
        field="defaultForward"
        initial={initial}
        placeholder={envFallback}
        clearedText={`Cleared — using env default (${envFallback}).`}
        hint={`Leave blank to use the environment default (${envFallback}).`}
      >
        Where a call rings when its tracking number has no per-number forward set. Each number
        in <a href="/settings/numbers" style={{ color: "var(--accent)" }}>Numbers</a> can override this.
      </RoutingField>

      <RoutingField
        title="Text relay number"
        field="smsForward"
        initial={initialSms}
        placeholder={smsEnvFallback ?? "+16188368004"}
        clearedText="Cleared — texts are captured in the Inbox but not relayed."
        hint="Leave blank to stop relaying. Texts are still captured either way."
      >
        A mobile that can actually read a text — inbound texts to tracking numbers are relayed
        here so nobody has to be watching the dashboard. This is deliberately separate from
        call forwarding, which currently points at the voice agent.
      </RoutingField>
    </div>
  );
}
