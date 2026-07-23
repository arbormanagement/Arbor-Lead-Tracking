"use client";

import { useState } from "react";

export interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  source: "db" | "env" | null;
  last4: string | null;
}
export interface Field {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}
export interface Platform {
  platform: string;
  label: string;
  fields: Field[];
  status: FieldStatus[];
}

export function PlatformCard({ platform, canSave }: { platform: Platform; canSave: boolean }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<FieldStatus[]>(platform.status);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pixels, setPixels] = useState<{ id: string; name: string }[] | null>(null);
  const [pixelMsg, setPixelMsg] = useState("");
  const [pixelLoading, setPixelLoading] = useState(false);
  const [convActions, setConvActions] = useState<{ id: string; name: string; category: string | null }[] | null>(null);
  const [convMsg, setConvMsg] = useState("");
  const [convLoading, setConvLoading] = useState(false);

  const statusFor = (key: string) => status.find((s) => s.key === key);

  async function findConvActions() {
    setConvLoading(true);
    setConvMsg("");
    try {
      const res = await fetch("/api/settings/google-ads/conversion-actions");
      const body = await res.json().catch(() => ({}));
      if (body.ok && Array.isArray(body.actions)) {
        setConvActions(body.actions);
        if (body.actions.length === 0)
          setConvMsg("No enabled import (upload) conversion actions in the account — create them in Google Ads first, or paste an ID manually.");
        else setConvMsg("Pick an action for each event, then hit Save. Only import (upload) actions are listed — other types can't receive offline conversions.");
      } else {
        setConvMsg(body.error ? `Couldn't fetch — ${body.error}` : "Couldn't fetch — save the Google Ads credentials first.");
      }
    } catch {
      setConvMsg("Network error");
    } finally {
      setConvLoading(false);
    }
  }

  async function findPixels() {
    setPixelLoading(true);
    setPixelMsg("");
    try {
      const res = await fetch("/api/settings/facebook/pixels");
      const body = await res.json().catch(() => ({}));
      if (body.ok && Array.isArray(body.pixels)) {
        setPixels(body.pixels);
        if (body.pixels.length === 0)
          setPixelMsg("No datasets found on the ad account or its business. Confirm one exists in Meta Events Manager (or that the token has business_management), or paste the ID manually.");
        else if (body.pixels.length === 1) {
          setValues((v) => ({ ...v, conversions_pixel_id: body.pixels[0].id }));
          setPixelMsg(`Found “${body.pixels[0].name}” — filled in. Hit Save.`);
        } else setPixelMsg("Pick a dataset below.");
      } else {
        setPixelMsg(body.error ? `Couldn't fetch — ${body.error}` : "Couldn't fetch — save the Access Token first.");
      }
    } catch {
      setPixelMsg("Network error");
    } finally {
      setPixelLoading(false);
    }
  }

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
          const isPixel = platform.platform === "facebook" && f.key === "conversions_pixel_id";
          const isConvAction = platform.platform === "google_ads" && f.key.startsWith("conversion_action_");
          return (
            <div key={f.key} style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 10, alignItems: "center" }}>
              <label style={{ color: "var(--muted)", fontSize: 13 }}>
                {f.label}
                <div style={{ fontSize: 11, color: st?.set ? "var(--muted)" : "var(--warn)" }}>{badge}</div>
              </label>
              <div>
                <input
                  type={f.secret ? "password" : "text"}
                  placeholder={
                    st?.set
                      ? `saved · ${f.secret ? "••••" : ""}${st.last4 ?? ""} — leave blank to keep`
                      : f.placeholder || ""
                  }
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  style={input}
                  autoComplete="off"
                />
                {isConvAction && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {convActions === null ? (
                        <button type="button" onClick={findConvActions} disabled={convLoading} style={btn("ghost")}>
                          {convLoading ? "Loading…" : "Choose from account"}
                        </button>
                      ) : convActions.length > 0 ? (
                        <select
                          value={values[f.key] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                          style={{ ...input, width: "auto" }}
                        >
                          <option value="">Select a conversion action…</option>
                          {convActions.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.id})
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                    {f.key === "conversion_action_won" && convMsg && (
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 5 }}>{convMsg}</div>
                    )}
                  </div>
                )}
                {isPixel && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <button type="button" onClick={findPixels} disabled={pixelLoading} style={btn("ghost")}>
                        {pixelLoading ? "Finding…" : "Find my pixel"}
                      </button>
                      {pixels && pixels.length > 1 && (
                        <select
                          value={values.conversions_pixel_id ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, conversions_pixel_id: e.target.value }))}
                          style={{ ...input, width: "auto" }}
                        >
                          <option value="">Select a dataset…</option>
                          {pixels.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.id})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {pixelMsg && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 5 }}>{pixelMsg}</div>}
                  </div>
                )}
              </div>
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
