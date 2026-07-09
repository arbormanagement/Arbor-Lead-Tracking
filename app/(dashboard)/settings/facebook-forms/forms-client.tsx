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

      <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn solid" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save selection"}
        </button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    </>
  );
}
