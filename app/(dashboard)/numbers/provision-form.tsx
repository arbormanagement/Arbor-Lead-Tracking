"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const POOLS = ["google", "facebook", "organic", "lsa", "direct", "print", "reserved"] as const;

/**
 * Admin form: buy a Twilio number by area code (or import an owned one) into a pool.
 * Static numbers take a source key so inbound calls resolve directly to that source.
 */
export function ProvisionForm() {
  const router = useRouter();
  const [pool, setPool] = useState<(typeof POOLS)[number]>("google");
  const [areaCode, setAreaCode] = useState("618");
  const [importNumber, setImportNumber] = useState("");
  const [isStatic, setIsStatic] = useState(false);
  const [staticSourceKey, setStaticSourceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    const res = await fetch("/api/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pool,
        areaCode: importNumber ? undefined : areaCode,
        importPhoneNumber: importNumber || undefined,
        isStatic,
        staticSourceKey: isStatic ? staticSourceKey || undefined : undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && body.ok) {
      setMsg(`Added ${body.number?.phoneNumber ?? ""}`);
      router.refresh();
    } else {
      setMsg(body.error || "Failed");
    }
  }

  const input = {
    padding: "8px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
  } as const;

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
      <select value={pool} onChange={(e) => setPool(e.target.value as typeof pool)} style={input}>
        {POOLS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <input
        placeholder="Area code"
        value={areaCode}
        onChange={(e) => setAreaCode(e.target.value)}
        style={{ ...input, width: 90 }}
        disabled={!!importNumber}
      />
      <input
        placeholder="or import +1618…"
        value={importNumber}
        onChange={(e) => setImportNumber(e.target.value)}
        style={{ ...input, width: 150 }}
      />
      <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)" }}>
        <input type="checkbox" checked={isStatic} onChange={(e) => setIsStatic(e.target.checked)} />
        static
      </label>
      {isStatic && (
        <input
          placeholder="source key (e.g. gbp)"
          value={staticSourceKey}
          onChange={(e) => setStaticSourceKey(e.target.value)}
          style={{ ...input, width: 150 }}
        />
      )}
      <button
        type="submit"
        disabled={busy}
        style={{ padding: "8px 14px", border: "none", borderRadius: 8, background: "var(--accent)", color: "#06210b", fontWeight: 700, cursor: "pointer" }}
      >
        {busy ? "Adding…" : "Add number"}
      </button>
      {msg && <span style={{ color: "var(--muted)" }}>{msg}</span>}
    </form>
  );
}
