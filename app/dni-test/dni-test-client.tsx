"use client";

import { useEffect, useState } from "react";

function getCookie(name: string): string | null {
  const m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
  return m ? decodeURIComponent(m[1]) : null;
}

type State = {
  vid: string | null;
  sid: string | null;
  number: string | null; // swapped display value
  waited: boolean; // long enough that "no number" is meaningful
};

/**
 * Live readout for /dni-test. Observes the REAL track.js flow (doesn't re-run it):
 * reads the arbor_vid/arbor_sid cookies track.js sets, and watches the
 * [data-arbor-phone] element for track.js's DNI swap. No extra lease is created —
 * we only look at what the snippet already did.
 */
export function DniTestClient() {
  const [s, setS] = useState<State>({ vid: null, sid: null, number: null, waited: false });

  useEffect(() => {
    const start = performance.now();
    const el = document.querySelector<HTMLElement>("[data-arbor-phone]");

    const tick = () => {
      const swapped = el?.getAttribute("data-arbor-swapped") ? (el.textContent || "").trim() : null;
      setS({
        vid: getCookie("arbor_vid"),
        sid: getCookie("arbor_sid"),
        number: swapped,
        waited: performance.now() - start > 6000,
      });
    };

    tick();
    const iv = setInterval(tick, 500);
    const stop = setTimeout(() => clearInterval(iv), 20000);
    return () => {
      clearInterval(iv);
      clearTimeout(stop);
    };
  }, []);

  const trackingOk = !!s.vid && !!s.sid;
  const numberOk = !!s.number;

  return (
    <div className="card pad" style={{ marginTop: 18 }}>
      <div className="label" style={{ marginBottom: 12 }}>◉ Live status</div>

      <Row
        state={trackingOk ? "ok" : "wait"}
        title="track.js loaded"
        detail={trackingOk ? `visitor + session cookies set` : "waiting for the snippet to run…"}
      />
      {trackingOk && (
        <div className="mono" style={{ color: "var(--faint)", fontSize: 11, margin: "-6px 0 12px 30px" }}>
          vid {s.vid!.slice(0, 8)}… · sid {s.sid!.slice(0, 8)}…
        </div>
      )}

      <Row
        state={numberOk ? "ok" : s.waited ? "bad" : "wait"}
        title="DNI number assigned"
        detail={
          numberOk
            ? "the displayed number was swapped to your tracking number"
            : s.waited
              ? "no number came back — see note below"
              : "waiting for the pool to lease a number…"
        }
      />
      {numberOk && (
        <div style={{ margin: "-2px 0 12px 30px" }}>
          <a href={`tel:${s.number}`} className="mono" style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>
            {s.number}
          </a>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Call this from your phone → it should ring the forward destination, then appear in{" "}
            <a href="/leads" style={{ color: "var(--accent)" }}>/leads</a> and{" "}
            <a href="/calls" style={{ color: "var(--accent)" }}>/calls</a>.
          </div>
        </div>
      )}

      {!numberOk && s.waited && (
        <div className="empty" style={{ marginTop: 6, textAlign: "left", padding: "14px 16px" }}>
          No tracking number was leased. That means the shared website pool is empty. Add one
          first: <strong>/numbers → Add tracking number</strong> (requires Twilio creds in
          <strong> Settings → Integrations</strong>). Tracking still works — only the swap is waiting on a number.
        </div>
      )}
    </div>
  );
}

function Row({ state, title, detail }: { state: "ok" | "wait" | "bad"; title: string; detail: string }) {
  const mark = state === "ok" ? "✓" : state === "bad" ? "✕" : "◌";
  const color = state === "ok" ? "var(--accent)" : state === "bad" ? "var(--danger)" : "var(--faint)";
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 10 }}>
      <span className="mono" style={{ color, fontSize: 16, width: 18, textAlign: "center", flex: "0 0 auto" }}>{mark}</span>
      <div>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="muted" style={{ fontSize: 12.5 }}>{detail}</div>
      </div>
    </div>
  );
}
