"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual trigger for the data sync (HCP → spend → attribution) — same chain the
 * hourly crons run, for when you don't want to wait. One-time maintenance jobs
 * (historical backfill `/api/sync/all?days=N`, Twilio fallback
 * `/api/sync/twilio-fallback`) stay available as endpoints; the fallback also
 * self-heals via its hourly cron, so neither needs a button here.
 */
export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");

  async function run() {
    setState("running");
    setMsg("");
    try {
      const res = await fetch("/api/sync/all", { method: "POST" });
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
      <button onClick={run} disabled={state === "running"} style={primary}>
        {state === "running" ? "Syncing…" : "Run sync now"}
      </button>
      {msg && (
        <span style={{ color: state === "error" ? "var(--danger)" : "var(--muted)", fontSize: 12 }}>{msg}</span>
      )}
    </div>
  );
}
