"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SourceOpt {
  id: string;
  name: string;
}
interface Row {
  sourceId: string;
  sourceName: string;
  month: string; // YYYY-MM-DD (first of month)
  amountCents: number;
}

/**
 * Manual monthly spend entry for channels without an API sync (LSA, GBP, print…).
 * Upserts one (source, month) amount; the next attribution run spreads it across
 * the month's days in roi_daily so the channel gets CPL/ROAS rows.
 */
export function ManualSpend({ sources, rows }: { sources: SourceOpt[]; rows: Row[] }) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dollars, setDollars] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    const amount = Math.round(Number(dollars) * 100);
    if (!sourceId || !month || !Number.isFinite(amount) || amount < 0) {
      setErr("Pick a source, month, and a dollar amount.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/manual-spend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, month, amountCents: amount }),
      });
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || "save failed");
      setDollars("");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Row) {
    setBusy(true);
    try {
      await fetch(`/api/admin/manual-spend?sourceId=${encodeURIComponent(r.sourceId)}&month=${r.month.slice(0, 7)}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const input = {
    padding: "7px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
    fontSize: 13,
  } as const;

  return (
    <div className="card pad" style={{ marginBottom: 24 }}>
      <div style={{ fontWeight: 650, marginBottom: 4 }}>Manual spend</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Monthly spend for channels without an API sync (LSA, Google Business Profile, print, yard signs…). Counted into
        CPL &amp; ROAS on the next sync, spread across the month.
      </div>

      <div className="controls" style={{ marginBottom: rows.length ? 14 : 0 }}>
        <select style={input} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <input style={input} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        <input
          style={{ ...input, width: 110 }}
          type="number"
          min="0"
          step="0.01"
          placeholder="$ amount"
          value={dollars}
          onChange={(e) => setDollars(e.target.value)}
        />
        <button className="btn solid" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        {err && <span style={{ color: "var(--danger)", fontSize: 12 }}>{err}</span>}
      </div>

      {rows.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Month</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.sourceId}:${r.month}`}>
                  <td style={{ fontWeight: 600 }}>{r.sourceName}</td>
                  <td className="mono muted">{r.month.slice(0, 7)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    ${(r.amountCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      onClick={() => remove(r)}
                      disabled={busy}
                      title="Remove"
                      style={{ background: "none", border: "none", color: "var(--faint)", cursor: "pointer", fontSize: 14 }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
