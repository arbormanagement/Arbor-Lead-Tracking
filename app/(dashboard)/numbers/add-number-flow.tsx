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
  isDni: boolean;
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

  // Only DNI pools are relevant when buying a number — static "buckets" like
  // print/lsa/reserved aren't something you pick per number.
  const dniPools = pools.filter((p) => p.isDni);

  // Selection + config
  const [selected, setSelected] = useState<Available | null>(null);
  // mode: a fixed number for one source, or a rotating website-DNI pool number.
  const [mode, setMode] = useState<"source" | "dni">("source");
  const [friendlyName, setFriendlyName] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [pool, setPool] = useState<string>(dniPools[0]?.key ?? "google");
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
    const isStatic = mode === "source";
    const res = await fetch("/api/numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purchasePhoneNumber: selected.phoneNumber,
        // Static numbers don't really belong to a pool — bucket them in "reserved".
        pool: isStatic ? "reserved" : pool,
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

          {/* What's this number for? — drives whether we ask for a source or a DNI pool */}
          <div style={{ marginBottom: 14 }}>
            <span style={label}>What is this number for?</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <ModeCard
                active={mode === "source"}
                onClick={() => setMode("source")}
                title="A specific source"
                desc="A fixed number you put on one place — GBP, a yard sign, LSA, a print ad, or a test. Calls always attribute to that one source."
              />
              <ModeCard
                active={mode === "dni"}
                onClick={() => setMode("dni")}
                title="Website DNI pool"
                desc="A number swapped onto your website per visitor, by channel. Use this only for dynamic website tracking."
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <span style={label}>Name</span>
              <input
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder={mode === "source" ? "e.g. GBP Edwardsville" : "e.g. Website — Google"}
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
            {mode === "source" ? (
              <div>
                <span style={label}>Source (what this number represents)</span>
                <input
                  list="source-keys"
                  value={sourceKey}
                  onChange={(e) => setSourceKey(e.target.value)}
                  placeholder="e.g. gbp, google/cpc, print"
                  style={{ ...input, width: "100%" }}
                />
                <datalist id="source-keys">
                  {sources.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.displayName}
                    </option>
                  ))}
                </datalist>
              </div>
            ) : (
              <div>
                <span style={label}>DNI pool (channel)</span>
                <select value={pool} onChange={(e) => setPool(e.target.value)} style={{ ...input, width: "100%" }}>
                  {dniPools.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}
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

function ModeCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: "1 1 280px",
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
        background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
        color: "var(--text)",
        cursor: "pointer",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>{desc}</div>
    </button>
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
