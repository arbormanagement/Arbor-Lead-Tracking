"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatPhoneDisplay } from "@/lib/phone";

interface SourceOpt {
  key: string;
  displayName: string;
}
export interface NumberRow {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  pool: string;
  status: string;
  isStatic: boolean;
  location: string;
  sourceKey: string | null;
  forwardDestination: string | null;
  whisperMessage: string | null;
  recordCalls: boolean;
  greetingMessage: string | null;
  greetingEnabled: boolean;
  leased: boolean;
  callCount: number;
  lastCallAt: string | null;
}

/**
 * CallRail-style number list: name, source/pool, forward target, call activity,
 * status — with an inline editor per row for routing (forward / whisper /
 * recording / source / pool) and lifecycle actions (enable/disable/release).
 */
export function NumbersTable({
  rows,
  sources,
  officeDefault,
}: {
  rows: NumberRow[];
  sources: SourceOpt[];
  officeDefault: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <table>
      <thead>
        <tr>
          <th>Number</th>
          <th>Name</th>
          <th>Source / pool</th>
          <th>Forwards to</th>
          <th>Calls</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => (
          <Row
            key={n.id}
            n={n}
            sources={sources}
            officeDefault={officeDefault}
            editing={editing === n.id}
            onEdit={() => setEditing(editing === n.id ? null : n.id)}
            onDone={() => setEditing(null)}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  n,
  sources,
  officeDefault,
  editing,
  onEdit,
  onDone,
}: {
  n: NumberRow;
  sources: SourceOpt[];
  officeDefault: string;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  // Editable fields
  const [friendlyName, setFriendlyName] = useState(n.friendlyName ?? "");
  const [sourceKey, setSourceKey] = useState(n.sourceKey ?? "");
  const [isStatic, setIsStatic] = useState(n.isStatic);
  const [forward, setForward] = useState(n.forwardDestination ?? "");
  const [whisper, setWhisper] = useState(n.whisperMessage ?? "");
  const [record, setRecord] = useState(n.recordCalls);
  const [greeting, setGreeting] = useState(n.greetingMessage ?? "");
  const [greetingOn, setGreetingOn] = useState(n.greetingEnabled);
  const [msg, setMsg] = useState("");

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setMsg("");
    const res = await fetch(`/api/numbers/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || j.ok === false) {
      setMsg(j.error || "Save failed");
      return false;
    }
    return true;
  }

  async function save() {
    const ok = await patch({
      friendlyName,
      pool: "reserved",
      isStatic,
      staticSourceKey: isStatic ? sourceKey : "",
      forwardDestination: forward || null,
      whisperMessage: whisper || null,
      recordCalls: record,
      greetingMessage: greeting || null,
      greetingEnabled: greetingOn,
    });
    if (ok) {
      onDone();
      router.refresh();
    }
  }

  async function toggleStatus() {
    setBusy(true);
    await fetch(`/api/numbers/${n.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: n.status === "active" ? "disabled" : "active" }),
    });
    setBusy(false);
    router.refresh();
  }

  async function release() {
    if (!confirm("Release this number? It will be relinquished on Twilio (you lose the number) and disabled here.")) return;
    setBusy(true);
    await fetch(`/api/numbers/${n.id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <>
      <tr>
        <td>{formatPhoneDisplay(n.phoneNumber)}</td>
        <td>{n.friendlyName || <span style={{ color: "var(--muted)" }}>—</span>}</td>
        <td>
          {n.isStatic ? (
            <span className="badge">{n.sourceKey ?? "no source"}</span>
          ) : (
            <span className="badge">website{n.leased ? " · leased" : ""}</span>
          )}
        </td>
        <td>{n.forwardDestination ? formatPhoneDisplay(n.forwardDestination) : <span style={{ color: "var(--muted)" }}>default</span>}</td>
        <td>
          {n.callCount > 0 ? (
            <span title={n.lastCallAt ? `Last: ${n.lastCallAt}` : undefined}>
              {n.callCount}
              {n.lastCallAt && <span style={{ color: "var(--muted)", fontSize: 11 }}> · {n.lastCallAt}</span>}
            </span>
          ) : (
            <span style={{ color: "var(--muted)" }}>0</span>
          )}
        </td>
        <td>
          <span className="badge">{n.status}</span>
          {!n.recordCalls && <span style={{ color: "var(--muted)", fontSize: 11 }}> · no rec</span>}
        </td>
        <td>
          <div style={{ display: "flex", gap: 6 }} aria-busy={busy}>
            <button onClick={onEdit} disabled={busy} style={btn()}>
              {editing ? "Cancel" : "Edit"}
            </button>
            <button onClick={toggleStatus} disabled={busy} style={btn()}>
              {n.status === "active" ? "Disable" : "Enable"}
            </button>
            <button onClick={release} disabled={busy} style={btn(true)}>
              Release
            </button>
          </div>
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={7} style={{ background: "var(--bg)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "4px 2px" }}>
              <Field label="Name">
                <input value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} style={input} placeholder="e.g. GBP Edwardsville" />
              </Field>
              <Field label="Forwards to (blank = account default)">
                <input value={forward} onChange={(e) => setForward(e.target.value)} style={input} placeholder={officeDefault || "+1618…"} />
              </Field>
              {isStatic ? (
                <Field label="Source (what this number represents)">
                  <input
                    list={`src-${n.id}`}
                    value={sourceKey}
                    onChange={(e) => setSourceKey(e.target.value)}
                    style={input}
                    placeholder="e.g. gbp, google/cpc"
                  />
                  <datalist id={`src-${n.id}`}>
                    {sources.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.displayName}
                      </option>
                    ))}
                  </datalist>
                </Field>
              ) : (
                <Field label="Source">
                  <div style={{ color: "var(--muted)", fontSize: 12, padding: "7px 0" }}>
                    Auto-detected per visitor (shared website rotation)
                  </div>
                </Field>
              )}
              <Field label="Whisper (blank = default)">
                <input value={whisper} onChange={(e) => setWhisper(e.target.value)} style={input} placeholder="“Tree lead from {source}”" />
              </Field>
              <Field label="Pre-call message to caller (blank = default)">
                <input
                  value={greeting}
                  onChange={(e) => setGreeting(e.target.value)}
                  style={{ ...input, opacity: greetingOn ? 1 : 0.5 }}
                  disabled={!greetingOn}
                  placeholder="“This call may be recorded.”"
                />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 10, flexWrap: "wrap", padding: "0 2px" }}>
              <label style={chk}>
                <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} /> record calls
              </label>
              <label style={chk}>
                <input type="checkbox" checked={greetingOn} onChange={(e) => setGreetingOn(e.target.checked)} /> play pre-call message
              </label>
              {record && !greetingOn && (
                <span style={{ color: "var(--warn, #d19a00)", fontSize: 11 }}>
                  ⚠ recording without a notice — check IL/MO consent rules
                </span>
              )}
              <label style={chk}>
                type
                <select
                  value={isStatic ? "source" : "dni"}
                  onChange={(e) => setIsStatic(e.target.value === "source")}
                  style={{ ...input, padding: "4px 8px", width: "auto" }}
                >
                  <option value="source">Source number</option>
                  <option value="dni">Website DNI</option>
                </select>
              </label>
              <button onClick={save} disabled={busy} style={solidBtn}>
                {busy ? "Saving…" : "Save"}
              </button>
              {msg && <span style={{ color: "var(--danger)", fontSize: 12 }}>{msg}</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span style={{ color: "var(--muted)", fontSize: 12, display: "block", marginBottom: 4 }}>{label}</span>
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  background: "var(--card, #111)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
};
const chk: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", fontSize: 13 };
const solidBtn: React.CSSProperties = {
  padding: "7px 14px",
  border: "none",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#06210b",
  fontWeight: 700,
  cursor: "pointer",
};
const btn = (danger?: boolean): React.CSSProperties => ({
  padding: "4px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: danger ? "var(--danger)" : "var(--text)",
  cursor: "pointer",
  fontSize: 12,
});
