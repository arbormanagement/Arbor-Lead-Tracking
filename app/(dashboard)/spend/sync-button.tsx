"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual triggers for the data sync (HCP → spend → attribution) — same chain the
 * hourly crons run. "Run sync now" is the normal incremental pull; "Backfill 90d"
 * re-pulls the full window on every job (`/api/sync/all?days=90`) to heal history —
 * e.g. spend from before syncing was first enabled, which otherwise never gets
 * fetched (the regular run only re-pulls a rolling 7 days). Other one-time
 * maintenance (Twilio fallback `/api/sync/twilio-fallback`) stays endpoint-only.
 */
export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function run(days?: number) {
    setState("running");
    setMsg("");
    try {
      const res = await fetch(`/api/sync/all${days ? `?days=${days}` : ""}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || "sync failed");
      setState("done");
      setMsg(JSON.stringify(body.result));
      router.refresh();
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  const primary = {
    padding: "8px 14px",
    border: "none",
    borderRadius: 8,
    background: "var(--accent)",
    color: "#06210b",
    fontWeight: 700,
    cursor: "pointer",
  } as const;

  return (
    <div style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={() => run()} disabled={state === "running"} style={primary}>
        {state === "running" ? "Syncing…" : "Run sync now"}
      </button>
      <button
        onClick={() => run(90)}
        disabled={state === "running"}
        className="btn"
        title="Re-pull the last 90 days of spend, leads & revenue — heals gaps from before syncing was enabled"
      >
        Backfill 90d
      </button>
      {msg && (
        <span style={{ color: state === "error" ? "var(--danger)" : "var(--muted)", fontSize: 12 }}>{msg}</span>
      )}
    </div>
  );
}
