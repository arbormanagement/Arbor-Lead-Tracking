"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const POOLS = ["google", "facebook", "organic", "lsa", "direct", "print", "reserved"] as const;

/**
 * Per-number lifecycle controls: change pool, enable/disable, release. All hit
 * /api/numbers/[id] (PATCH/DELETE) so the full lifecycle is in-app.
 */
export function NumberActions({ id, status, pool }: { id: string; status: string; pool: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/numbers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    router.refresh();
  }

  async function release() {
    if (!confirm("Release this number? It will be relinquished on Twilio (you lose the number) and disabled here.")) return;
    setBusy(true);
    await fetch(`/api/numbers/${id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  const select = {
    padding: "4px 6px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text)",
    fontSize: 12,
  } as const;
  const btn = (danger?: boolean) =>
    ({
      padding: "4px 8px",
      borderRadius: 6,
      border: "1px solid var(--border)",
      background: "transparent",
      color: danger ? "var(--danger)" : "var(--text)",
      cursor: "pointer",
      fontSize: 12,
    }) as const;

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }} aria-busy={busy}>
      <select value={pool} onChange={(e) => patch({ pool: e.target.value })} disabled={busy} style={select}>
        {POOLS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <button
        onClick={() => patch({ status: status === "active" ? "disabled" : "active" })}
        disabled={busy}
        style={btn()}
      >
        {status === "active" ? "Disable" : "Enable"}
      </button>
      <button onClick={release} disabled={busy} style={btn(true)}>
        Release
      </button>
    </div>
  );
}
