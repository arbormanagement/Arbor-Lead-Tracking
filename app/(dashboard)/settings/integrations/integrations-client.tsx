"use client";

import { useState } from "react";

/**
 * One row per integration: is it configured, and does it actually authenticate.
 *
 * Those are the only two questions this page can answer now that credentials come from Railway
 * env vars — everything else it used to show (per-field inputs, Save, Connect, pickers) drove a
 * credential store that no longer exists. The per-platform detail route went with them: six rows
 * of status did not need a list page, a drill-down, and a field-by-field breakdown you cannot act
 * on from here.
 *
 * Test is the half worth keeping, because "configured" and "working" are different questions and
 * a non-empty variable only answers the first — a token can be present, well-formed and revoked.
 */
export interface PlatformStatus {
  platform: string;
  label: string;
  total: number;
  set: number;
  /** Env vars behind the fields that are unset — the one place a variable name does real work. */
  missing: string[];
}

export function IntegrationRow({ p }: { p: PlatformStatus }) {
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function test() {
    setTesting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: p.platform }),
      });
      const body = await res.json().catch(() => ({}));
      setMsg({ ok: !!body.ok, text: body.ok ? `Connected — ${body.detail ?? "OK"}` : `Failed — ${body.error ?? "error"}` });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setTesting(false);
    }
  }

  const configured = p.set > 0;

  return (
    <div className="card pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{p.label}</div>
          <div style={{ fontSize: 12, color: configured ? "var(--muted)" : "var(--warn)", marginTop: 3 }}>
            {configured ? `${p.set} of ${p.total} fields set` : "not configured"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {msg && (
            <span style={{ color: msg.ok ? "var(--accent)" : "var(--danger)", fontSize: 13, wordBreak: "break-word" }}>
              {msg.text}
            </span>
          )}
          <button onClick={test} disabled={testing} style={btn}>
            {testing ? "Testing…" : "Test"}
          </button>
        </div>
      </div>

      {p.missing.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.7 }}>
          not set:{" "}
          {p.missing.map((m, i) => (
            <span key={m}>
              {i > 0 ? ", " : ""}
              <code style={{ fontSize: 11 }}>{m}</code>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontWeight: 700,
  cursor: "pointer",
};
