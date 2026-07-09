"use client";

import { useEffect, useState } from "react";

type Form = { id: string; name: string; status: string; leadsCount: number };

export function FormsClient() {
  const [forms, setForms] = useState<Form[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [cleaning, setCleaning] = useState(false);
  const [cleanMsg, setCleanMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/facebook/forms");
        const body = await res.json();
        if (body.ok) {
          setForms(body.forms);
          setSelected(new Set<string>(body.selected ?? []));
        } else setErr(body.error || "Couldn't load forms");
      } catch {
        setErr("Network error");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMsg("");
    try {
      const res = await fetch("/api/settings/facebook/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formIds: [...selected] }),
      });
      const body = await res.json();
      setMsg(res.ok && body.ok ? "Saved." : body.error || "Save failed");
    } catch {
      setMsg("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function cleanup() {
    if (!confirm("Delete already-ingested leads from the forms you did NOT select? This can't be undone.")) return;
    setCleaning(true);
    setCleanMsg("");
    try {
      const res = await fetch("/api/settings/facebook/forms/cleanup", { method: "POST" });
      const body = await res.json();
      setCleanMsg(res.ok && body.ok ? `Removed ${body.removed} lead(s)${body.note ? ` — ${body.note}` : ""}.` : body.error || "Cleanup failed");
    } catch {
      setCleanMsg("Network error");
    } finally {
      setCleaning(false);
    }
  }

  if (loading) return <div className="empty">Loading forms…</div>;
  if (err)
    return (
      <div className="empty" style={{ textAlign: "left" }}>
        Couldn&apos;t load lead forms — {err}. Make sure the Facebook Access Token (with page access) is saved in Integrations.
      </div>
    );

  const none = selected.size === 0;

  return (
    <>
      <div className="card pad" style={{ marginBottom: 14 }}>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          Check the forms whose submissions should become <strong>customer leads</strong>. Uncheck recruiting /
          non-customer forms (e.g. hiring). {none && <strong>Nothing selected = all ACTIVE forms are polled (default).</strong>}
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }}>Poll</th>
            <th>Form</th>
            <th>Status</th>
            <th style={{ textAlign: "right" }}>Leads</th>
          </tr>
        </thead>
        <tbody>
          {forms!.map((f) => (
            <tr key={f.id}>
              <td>
                <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} />
              </td>
              <td style={{ fontWeight: 600 }}>
                {f.name}
                <div className="muted mono" style={{ fontSize: 11 }}>{f.id}</div>
              </td>
              <td>
                <span className={f.status === "ACTIVE" ? "badge win" : "badge"}>{f.status.toLowerCase()}</span>
              </td>
              <td className="mono" style={{ textAlign: "right" }}>{f.leadsCount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save selection"}
        </button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>

      <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn" onClick={cleanup} disabled={cleaning || none} style={none ? { opacity: 0.5 } : undefined}>
          {cleaning ? "Removing…" : "Remove already-ingested leads from unselected forms"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {none ? "Select forms first — with none selected, no forms are excluded." : cleanMsg || "Deletes past leads from forms you didn't check (e.g. hiring)."}
        </span>
      </div>
    </>
  );
}
