import Link from "next/link";
import { CREDENTIAL_SPECS, credentialStatus } from "@/lib/credentials";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const platforms = await Promise.all(
    CREDENTIAL_SPECS.map(async (s) => {
      const status = await credentialStatus(s.platform);
      return {
        platform: s.platform,
        label: s.label,
        total: status.length,
        set: status.filter((f) => f.set).length,
      };
    }),
  );

  return (
    <>
      <a href="/settings" className="backlink">← Settings</a>
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">
            Read-only status. Every credential comes from a Railway environment variable on the{" "}
            <code>web</code> service — there is no in-app store, so there is exactly one place a value
            can come from. Open a platform to see which variable backs each field, and to test it.
          </p>
        </div>
      </div>

      <div className="cards">
        {platforms.map((p) => {
          const connected = p.set > 0;
          return (
            <Link
              key={p.platform}
              href={`/settings/integrations/${p.platform}`}
              className="card pad"
              style={{ display: "block" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div className="value" style={{ fontSize: 16 }}>{p.label}</div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: connected ? "var(--accent)" : "var(--warn)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {connected ? "● connected" : "○ not set"}
                </span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {p.set} of {p.total} field{p.total === 1 ? "" : "s"} configured →
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
