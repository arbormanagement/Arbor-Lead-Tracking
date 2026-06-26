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

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        onClick={run}
        disabled={state === "running"}
        style={{
          padding: "8px 14px",
          border: "none",
          borderRadius: 8,
          background: "var(--accent)",
          color: "#06210b",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {state === "running" ? "Syncing…" : "Run sync now"}
      </button>
      {msg && (
        <span style={{ marginLeft: 12, color: state === "error" ? "var(--danger)" : "var(--muted)" }}>
          {msg}
        </span>
      )}
    </div>
  );
}
