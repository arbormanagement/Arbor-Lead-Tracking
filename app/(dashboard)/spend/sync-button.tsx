"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Manual trigger for the data sync (HCP → spend → attribution). Useful before the
 * Inngest cron is wired at deploy, and for validating credentials as they land.
 */
export function SyncButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<null | "all" | "backfill">(null);

  async function post(url: string, label: "all" | "backfill") {
    setState("running");
    setBusy(label);
    setMsg("");
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json();
      if (!res.ok || body.ok === false) throw new Error(body.error || "sync failed");
      setState("done");
      setMsg(JSON.stringify(body.result));
      router.refresh();
    } catch (e) {
      setState("error");
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
  const ghost = {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    fontWeight: 600,
    cursor: "pointer",
  } as const;

  return (
    <div style={{ marginBottom: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <button onClick={() => post("/api/sync/all", "all")} disabled={state === "running"} style={primary}>
        {busy === "all" ? "Syncing…" : "Run sync now"}
      </button>
      <button
        onClick={() => post("/api/sync/all?days=90", "backfill")}
        disabled={state === "running"}
        style={ghost}
        title="One-time: pull 90 days of HousecallPro estimates + Facebook leads, then re-run matching/attribution"
      >
        {busy === "backfill" ? "Backfilling…" : "Backfill & match (90d)"}
      </button>
      {msg && (
        <span style={{ color: state === "error" ? "var(--danger)" : "var(--muted)", fontSize: 12 }}>{msg}</span>
      )}
    </div>
  );
}
