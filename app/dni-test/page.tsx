import type { Metadata } from "next";
import Link from "next/link";
import { classifySource } from "@/lib/attribution/classify";
import { DniTestClient } from "./dni-test-client";

// Hidden test surface: never indexed, not in the nav. Public (no auth) so it can be
// hit from a phone that isn't logged in — it mirrors how the real site loads track.js.
export const metadata: Metadata = {
  title: "DNI Test",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const PRESETS = [
  { label: "Google Ads", qs: "gclid=test-gclid&utm_source=google&utm_medium=cpc&utm_campaign=tree-removal" },
  { label: "Facebook", qs: "fbclid=test-fbclid&utm_source=facebook&utm_medium=paid" },
  { label: "GBP", qs: "utm_source=gbp&utm_medium=organic" },
  { label: "Direct", qs: "" },
];

export default async function DniTestPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;

  const params = {
    gclid: one(sp.gclid),
    gbraid: one(sp.gbraid),
    wbraid: one(sp.wbraid),
    fbclid: one(sp.fbclid),
    utmSource: one(sp.utm_source),
    utmMedium: one(sp.utm_medium),
  };
  const cls = classifySource(params);

  const seen = [
    ["gclid", params.gclid],
    ["fbclid", params.fbclid],
    ["utm_source", params.utmSource],
    ["utm_medium", params.utmMedium],
    ["utm_campaign", one(sp.utm_campaign)],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="pagewrap" style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px" }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">DNI end-to-end test</h1>
          <p className="page-sub">
            One page that exercises the whole pipeline: tracking → number swap → call → lead → attribution.
            Isolated from CallRail and hidden from customers.
          </p>
        </div>
      </div>

      {/* Source presets — reload the page as each traffic type */}
      <div className="controls" style={{ marginBottom: 18 }}>
        {PRESETS.map((p) => (
          <a key={p.label} className="pill" href={`/dni-test${p.qs ? "?" + p.qs : ""}`}>
            {p.label}
          </a>
        ))}
      </div>

      {/* What this load looks like to the tracker */}
      <div className="card pad" style={{ marginBottom: 18 }}>
        <div className="label" style={{ marginBottom: 10 }}>◈ This visit</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <div>
            <div className="muted" style={{ fontSize: 12 }}>Expected source (frozen on the lead)</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)", marginTop: 2 }}>
              {cls.sourceKey}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="muted" style={{ fontSize: 12 }}>Params seen</div>
            <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>
              {seen.length ? seen.map(([k, v]) => `${k}=${v}`).join(" · ") : "none (direct)"}
            </div>
          </div>
        </div>
      </div>

      {/* The swap target — track.js replaces this text + tel: href with the tracking number */}
      <div className="card pad" style={{ textAlign: "center", padding: "26px 20px", marginBottom: 4 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Displayed number on the “site”</div>
        <a data-arbor-phone href="tel:+16188368004" className="mono" style={{ fontSize: 26, fontWeight: 800 }}>
          (618) 836-8004
        </a>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Watch this swap to a tracking number once the pool leases one.
        </div>
      </div>

      <DniTestClient />

      <p className="muted" style={{ fontSize: 12, marginTop: 20, lineHeight: 1.6 }}>
        <strong>How to run it:</strong> pick a source preset above → confirm the number swaps and
        the expected source matches → call the swapped number from your phone → open{" "}
        <Link href="/leads" style={{ color: "var(--accent)" }}>/leads</Link> and confirm the call landed with that source.
        Repeat with a different preset to prove each channel. CallRail is untouched — this page isn’t on
        arbor-mgmt.com and only swaps its own <code>data-arbor-phone</code> element.
      </p>

      {/* Load the REAL snippet exactly as the live site would (currentScript-derived endpoint). */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script async src="/track.js" />
    </div>
  );
}
