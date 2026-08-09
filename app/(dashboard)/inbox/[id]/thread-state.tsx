"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Mark a thread dealt with (or reopen it) — what lets the Open inbox drain. */
export function ThreadStateButton({
  conversationId,
  state,
}: {
  conversationId: string;
  state: "open" | "closed";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const next = state === "open" ? "closed" : "open";

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/inbox/${conversationId}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn" onClick={toggle} disabled={busy}>
      {state === "open" ? "✓ Mark done" : "↩ Reopen"}
    </button>
  );
}
