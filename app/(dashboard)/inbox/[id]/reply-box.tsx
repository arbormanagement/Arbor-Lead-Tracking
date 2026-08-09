"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatPhoneDisplay } from "@/lib/phone";

/** Twilio's hard cap for a single API message. */
const MAX = 1600;

/**
 * Reply by text on a thread.
 *
 * Disabled states are explained rather than silently greyed out, because every
 * reason it can't send is something the user has to go fix somewhere else (a
 * missing mobile, a STOP, a thread that only ever arrived by web form).
 */
export function ReplyBox({
  conversationId,
  canText,
  optedOut,
  fromNumber,
  fromLabel,
}: {
  conversationId: string;
  canText: boolean;
  optedOut: boolean;
  fromNumber: string | null;
  fromLabel: string | null;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blocked = optedOut || !canText;

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/${conversationId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        setBody("");
        router.refresh();
      } else {
        setError(payload.error || "Send failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  if (blocked) {
    return (
      <div className="card pad" style={{ marginTop: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {optedOut
            ? "This person replied STOP. Texting them is blocked until they text START — that block is a legal requirement, not a setting."
            : "No texting endpoint on this thread. Replies go out from the tracking number the customer contacted, so this only works once they've called or texted one."}
        </p>
      </div>
    );
  }

  return (
    <div className="card pad" style={{ marginTop: 16 }}>
      <div className="card-head" style={{ padding: 0, marginBottom: 10 }}>
        <h3>💬 Reply by text</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          from {fromLabel ? `${fromLabel} · ` : ""}{formatPhoneDisplay(fromNumber) || fromNumber}
        </span>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, MAX))}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends; plain Enter stays a newline so addresses and
          // quotes can be written naturally.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send();
        }}
        rows={3}
        placeholder="Type a reply…"
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          font: "inherit",
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
        <button className="btn solid" onClick={send} disabled={sending || !body.trim()}>
          {sending ? "Sending…" : "Send text"}
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {body.length}/{MAX} · ⌘↵ to send
        </span>
        {error && <span style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</span>}
      </div>
    </div>
  );
}
