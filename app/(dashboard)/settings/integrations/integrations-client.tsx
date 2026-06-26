"use client";

import { useState } from "react";

interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  source: "db" | "env" | null;
  last4: string | null;
}
interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}
interface Platform {
  platform: string;
  label: string;
  fields: Field[];
  status: FieldStatus[];
}

export function IntegrationsClient({ platforms, canSave }: { platforms: Platform[]; canSave: boolean }) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {platforms.map((p) => (
        <PlatformCard key={p.platform} platform={p} canSave={canSave} />
      ))}
    </div>
  );
}

function PlatformCard({ platform, canSave }: { platform: Platform; canSave: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<FieldStatus[]>(platform.status);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const statusFor = (key: string) => status.find((s) => s.key === key);

  async function save() {
    setSaving(true);
    setMsg(null);
    const res = await fetch("/api/settings/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform.platform, values }),
    });
    const body = await res.json().catch(() => ({}));
    setSaving(false);
    if (res.ok && body.ok) {
      setStatus(body.status);
      setValues({});
      setMsg({ ok: true, text: "Saved" });
    } else {
      setMsg({ ok: false, text: body.error || "Save failed" });
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    const res = await fetch("/api/settings/credentials/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: platform.platform }),
    });
    const body = await res.json().catch(() => ({}));
    setTesting(false);
    setMsg({ ok: !!body.ok, text: body.ok ? `Connected — ${body.detail ?? "OK"}` : `Failed — ${body.error ?? "error"}` });
  }

  const input = {
    width: "100%",
    padding: "8px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
  } as const;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{platform.label}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {msg && (
            <span style={{ color: msg.ok ? "var(--accent)" : "var(--danger)", fontSize: 13 }}>{msg.text}</span>
          )}
          <button onClick={test} disabled={testing} style={btn("ghost")}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button onClick={save} disabled={!canSave || saving} style={btn("solid")}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {platform.fields.map((f) => {
          const st = statusFor(f.key);
          const badge = st?.set
            ? `${st.source === "db" ? "saved" : "env"} · ${f.secret ? "••••" : ""}${st.last4 ?? ""}`
            : "not set";
          return (
            <div key={f.key} style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 10, alignItems: "center" }}>
              <label style={{ color: "var(--muted)", fontSize: 13 }}>
                {f.label}
                <div style={{ fontSize: 11, color: st?.set ? "var(--muted)" : "var(--warn)" }}>{badge}</div>
              </label>
              <input
                type={f.secret ? "password" : "text"}
                placeholder={f.placeholder || (st?.set ? "•••••••• (leave blank to keep)" : "")}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={input}
                autoComplete="off"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function btn(kind: "solid" | "ghost"): React.CSSProperties {
  return {
    padding: "7px 12px",
    borderRadius: 8,
    border: kind === "ghost" ? "1px solid var(--border)" : "none",
    background: kind === "ghost" ? "transparent" : "var(--accent)",
    color: kind === "ghost" ? "var(--text)" : "#06210b",
    fontWeight: 700,
    cursor: "pointer",
  };
}
