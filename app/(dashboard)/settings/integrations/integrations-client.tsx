"use client";

import { useState } from "react";

/**
 * Read-only integration status, plus the one action worth keeping: Test.
 *
 * This was an editor — inputs, Save, a Connect button, pickers that filled fields. All of it
 * wrote to a database store that outranked env, which is the precedence this app removed on
 * 2026-08-12. Credentials now come from Railway variables only, so there is nothing here to
 * edit and the page says where to go instead.
 *
 * Test earns its place because "configured" and "working" are different questions and only one
 * of them is answerable from a variable being non-empty. A token can be present, well-formed,
 * and revoked. `/api/settings/credentials/test` actually calls each provider.
 */
export interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  /** The env var backing this field, so "not set" tells you what to go and set. */
  envKey: string | null;
  last4: string | null;
}
export interface Platform {
  platform: string;
  label: string;
  status: FieldStatus[];
}

export function PlatformCard({ platform }: { platform: Platform }) {
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: platform.platform }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg({ ok: !!body.ok, text: body.ok ? `Connected — ${body.detail ?? "OK"}` : `Failed — ${body.error ?? "error"}` });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{platform.label}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {msg && <span style={{ color: msg.ok ? "var(--accent)" : "var(--danger)", fontSize: 13 }}>{msg.text}</span>}
          <button onClick={test} disabled={testing} style={btn()}>
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {platform.status.map((f) => {
          const masked = `${f.secret ? "••••" : ""}${f.last4 ?? ""}`;
          return (
            <div
              key={f.key}
              style={{ display: "grid", gridTemplateColumns: "240px 1fr auto", gap: 10, alignItems: "baseline" }}
            >
              <div style={{ color: "var(--muted)", fontSize: 13 }}>{f.label}</div>
              <code style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all" }}>{f.envKey ?? "—"}</code>
              <div style={{ fontSize: 12, color: f.set ? "var(--muted)" : "var(--warn)", whiteSpace: "nowrap" }}>
                {f.set ? masked || "set" : "not set"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function btn(): React.CSSProperties {
  return {
    padding: "7px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    fontWeight: 700,
    cursor: "pointer",
  };
}
