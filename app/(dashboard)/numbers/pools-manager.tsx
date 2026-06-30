"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface PoolRow {
  key: string;
  displayName: string;
  description: string | null;
  isDni: boolean;
  numberCount: number;
}

/**
 * Manage number pools (create / rename / describe / toggle DNI / delete). The pool
 * `key` is the stable identifier stored on numbers, so it's set at creation and
 * immutable thereafter; everything else is editable. Hits /api/pools[/key].
 */
export function PoolsManager({ pools }: { pools: PoolRow[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 className="page-title" style={{ fontSize: 16, margin: 0 }}>
          Pools
        </h2>
        <button onClick={() => setOpen((v) => !v)} style={ghostBtn}>
          {open ? "Hide" : "Manage"}
        </button>
      </div>
      <p className="page-sub" style={{ marginTop: 4 }}>
        Channel buckets. DNI pools rotate numbers across website visitors; the rest just organize static numbers.
      </p>

      {open && (
        <>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Key</th>
                <th>Name</th>
                <th>Description</th>
                <th>DNI</th>
                <th>Numbers</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <PoolRowItem key={p.key} p={p} />
              ))}
            </tbody>
          </table>
          <CreatePool />
        </>
      )}
    </div>
  );
}

function PoolRowItem({ p }: { p: PoolRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(p.displayName);
  const [description, setDescription] = useState(p.description ?? "");
  const [isDni, setIsDni] = useState(p.isDni);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    setBusy(true);
    setMsg("");
    const res = await fetch(`/api/pools/${encodeURIComponent(p.key)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, description: description || null, isDni }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && j.ok) {
      setEditing(false);
      router.refresh();
    } else setMsg(j.error || "Save failed");
  }

  async function del() {
    if (!confirm(`Delete pool "${p.key}"?`)) return;
    setBusy(true);
    setMsg("");
    const res = await fetch(`/api/pools/${encodeURIComponent(p.key)}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && j.ok) router.refresh();
    else setMsg(j.error || "Delete failed");
  }

  if (editing) {
    return (
      <tr>
        <td>
          <span className="badge">{p.key}</span>
        </td>
        <td>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={input} />
        </td>
        <td>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={input} />
        </td>
        <td>
          <input type="checkbox" checked={isDni} onChange={(e) => setIsDni(e.target.checked)} />
        </td>
        <td>{p.numberCount}</td>
        <td>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-busy={busy}>
            <button onClick={save} disabled={busy} style={solidBtn}>
              Save
            </button>
            <button onClick={() => setEditing(false)} disabled={busy} style={btn()}>
              Cancel
            </button>
            {msg && <span style={{ color: "var(--danger)", fontSize: 11 }}>{msg}</span>}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <span className="badge">{p.key}</span>
      </td>
      <td>{p.displayName}</td>
      <td style={{ color: "var(--muted)", fontSize: 12 }}>{p.description || "—"}</td>
      <td>{p.isDni ? "✓" : ""}</td>
      <td>{p.numberCount}</td>
      <td>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-busy={busy}>
          <button onClick={() => setEditing(true)} disabled={busy} style={btn()}>
            Edit
          </button>
          <button
            onClick={del}
            disabled={busy || p.key === "reserved" || p.numberCount > 0}
            title={p.key === "reserved" ? "Default pool" : p.numberCount > 0 ? "Reassign its numbers first" : "Delete"}
            style={btn(true)}
          >
            Delete
          </button>
          {msg && <span style={{ color: "var(--danger)", fontSize: 11 }}>{msg}</span>}
        </div>
      </td>
    </tr>
  );
}

function CreatePool() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [isDni, setIsDni] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function create() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/pools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key.trim(), displayName: displayName.trim(), description: description || undefined, isDni }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && j.ok) {
      setKey("");
      setDisplayName("");
      setDescription("");
      setIsDni(false);
      setMsg({ ok: true, text: `Created “${j.pool.key}”` });
      router.refresh();
    } else setMsg({ ok: false, text: j.error || "Create failed" });
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>New pool</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Key (immutable)">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. yard-signs" style={{ ...input, width: 160 }} />
        </Field>
        <Field label="Name">
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Yard Signs" style={{ ...input, width: 180 }} />
        </Field>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...input, width: 220 }} />
        </Field>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", fontSize: 13, paddingBottom: 8 }}>
          <input type="checkbox" checked={isDni} onChange={(e) => setIsDni(e.target.checked)} /> DNI pool
        </label>
        <button onClick={create} disabled={busy || !key.trim() || !displayName.trim()} style={solidBtn}>
          {busy ? "Creating…" : "Create pool"}
        </button>
        {msg && <span style={{ color: msg.ok ? "var(--accent)" : "var(--danger)", fontSize: 13, paddingBottom: 8 }}>{msg.text}</span>}
      </div>
    </div>
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
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
};
const solidBtn: React.CSSProperties = {
  padding: "7px 14px",
  border: "none",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#06210b",
  fontWeight: 700,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "5px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 13,
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
