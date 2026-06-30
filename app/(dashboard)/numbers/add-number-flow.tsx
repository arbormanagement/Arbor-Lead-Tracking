"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatPhoneDisplay } from "@/lib/phone";

interface SourceOpt {
  key: string;
  displayName: string;
}
interface PoolOpt {
  key: string;
  displayName: string;
}
interface Available {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
}

/**
 * CallRail-style "add a tracking number": search Twilio inventory → pick the
 * actual digits → name it for a source + set where it forwards / the whisper →
 * buy. Posts to /api/numbers/available (search) and /api/numbers (purchase).
 */
export function AddNumberFlow({
  sources,
  pools,
  officeDefault,
}: {
  sources: SourceOpt[];
  pools: PoolOpt[];
  officeDefault: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Search
  const [tollFree, setTollFree] = useState(false);
  const [areaCode, setAreaCode] = useState("618");
  const [contains, setContains] = useState("");
  const [results, setResults] = useState<Available[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Selection + config
  const [selected, setSelected] = useState<Available | null>(null);
  const [friendlyName, setFriendlyName] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [isStatic, setIsStatic] = useState(true);
  const [pool, setPool] = useState<string>("reserved");
  const [forward, setForward] = useState(officeDefault);
  const [whisper, setWhisper] = useState("");
  const [record, setRecord] = useState(true);

  const [buying, setBuying] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function search() {
    setSearching(true);
    setMsg(null);
    setResults(null);
    setSelected(null);
    const qs = new URLSearchParams();
    if (tollFree) qs.set("tollFree", "true");
    else qs.set("areaCode", areaCode);
    if (contains) qs.set("contains", contains);
    const res = await fetch(`/api/numbers/available?${qs}`);
    const body = await res.json().catch(() => ({}));
    setSearching(false);
    if (res.ok && body.ok) {
      setResults(body.numbers);
      if (!body.numbers.length) setMsg({ ok: false, text: "No numbers found — try a different area code or pattern." });
    } else {
      setMsg({ ok: false, text: body.error || "Search failed" });
    }
  }

  async function buy() {
    if (!selected) return;
    setBuying(true);
    setMsg(null);
    const res = await fetch("/api/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purchasePhoneNumber: selected.phoneNumber,
        pool,
        isStatic,
        staticSourceKey: isStatic ? sourceKey || undefined : undefined,
        friendlyName: friendlyName || undefined,
        forwardDestination: forward || undefined,
        whisperMessage: whisper || undefined,
        recordCalls: record,
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBuying(false);
    if (res.ok && body.ok) {
      setMsg({ ok: true, text: `Added ${formatPhoneDisplay(body.number?.phoneNumber ?? selected.phoneNumber)}` });
      // Reset for the next add.
      setResults(null);
      setSelected(null);
      setFriendlyName("");
      setSourceKey("");
      setContains("");
      router.refresh();
    } else {
      setMsg({ ok: false, text: body.error || "Purchase failed" });
    }
  }

  const input = {
    padding: "8px 10px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    color: "var(--text)",
  } as const;
  const label = { color: "var(--muted)", fontSize: 12, display: "block", marginBottom: 4 } as const;

  if (!open) {
    return (
      <div style={{ marginBottom: 20 }}>
        <button onClick={() => setOpen(true)} style={solidBtn}>
          + Add tracking number
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 700 }}>Add tracking number</div>
        <button onClick={() => setOpen(false)} style={ghostBtn}>
          Close
        </button>
      </div>

      {/* Step 1 — search inventory */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)" }}>
          <input type="checkbox" checked={tollFree} onChange={(e) => setTollFree(e.target.checked)} />
          toll-free
        </label>
        {!tollFree && (
          <div>
            <span style={label}>Area code</span>
            <input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} style={{ ...input, width: 90 }} />
          </div>
        )}
        <div>
          <span style={label}>Contains (optional)</span>
          <input
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            placeholder="e.g. 8004 or TREE"
            style={{ ...input, width: 140 }}
          />
        </div>
        <button onClick={search} disabled={searching} style={solidBtn}>
          {searching ? "Searching…" : "Search numbers"}
        </button>
      </div>

      {/* Step 2 — pick the actual number */}
      {results && results.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {results.map((n) => {
            const active = selected?.phoneNumber === n.phoneNumber;
            return (
              <button
                key={n.phoneNumber}
                onClick={() => {
                  setSelected(n);
                  if (!friendlyName) setFriendlyName("");
                }}
                style={{
                  ...ghostBtn,
                  borderColor: active ? "var(--accent)" : "var(--border)",
                  background: active ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "transparent",
                  textAlign: "left",
                }}
              >
                <div style={{ fontWeight: 700 }}>{formatPhoneDisplay(n.phoneNumber)}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  {[n.locality, n.region].filter(Boolean).join(", ") || "US"}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Step 3 — name + route the chosen number */}
      {selected && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <div style={{ marginBottom: 12, fontWeight: 600 }}>
            Configure {formatPhoneDisplay(selected.phoneNumber)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <span style={label}>Name</span>
              <input
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder="e.g. GBP Edwardsville"
                style={{ ...input, width: "100%" }}
              />
            </div>
            <div>
              <span style={label}>Forwards to</span>
              <input
                value={forward}
                onChange={(e) => setForward(e.target.value)}
                placeholder={officeDefault || "+1618…"}
                style={{ ...input, width: "100%" }}
              />
            </div>
            <div>
              <span style={label}>Source key {isStatic ? "" : "(pool number — ignored)"}</span>
              <input
                list="source-keys"
                value={sourceKey}
                onChange={(e) => setSourceKey(e.target.value)}
                placeholder="e.g. gbp, google/cpc, print"
                disabled={!isStatic}
                style={{ ...input, width: "100%", opacity: isStatic ? 1 : 0.5 }}
              />
              <datalist id="source-keys">
                {sources.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.displayName}
                  </option>
                ))}
              </datalist>
            </div>
            <div>
              <span style={label}>Whisper (optional)</span>
              <input
                value={whisper}
                onChange={(e) => setWhisper(e.target.value)}
                placeholder="default: “Tree lead from {source}”"
                style={{ ...input, width: "100%" }}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", fontSize: 13 }}>
              <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
              record calls
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", fontSize: 13 }}>
              <input type="checkbox" checked={isStatic} onChange={(e) => setIsStatic(e.target.checked)} />
              static (fixed source) — uncheck for a DNI pool number
            </label>
            {!isStatic && (
              <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--muted)", fontSize: 13 }}>
                pool
                <select value={pool} onChange={(e) => setPool(e.target.value)} style={{ ...input, padding: "4px 8px" }}>
                  {pools.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={buy} disabled={buying} style={solidBtn}>
              {buying ? "Buying…" : `Buy ${formatPhoneDisplay(selected.phoneNumber)}`}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <div style={{ marginTop: 12, color: msg.ok ? "var(--accent)" : "var(--danger)", fontSize: 13 }}>{msg.text}</div>
      )}
    </div>
  );
}

const solidBtn: React.CSSProperties = {
  padding: "8px 14px",
  border: "none",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#06210b",
  fontWeight: 700,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
};
