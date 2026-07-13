import Link from "next/link";
import { CREDENTIAL_SPECS, credentialStatus } from "@/lib/credentials";
import { credentialEncryptionAvailable } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const encryptionOn = credentialEncryptionAvailable();

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
      <div className="page-head">
        <div>
          <h1 className="page-title">Integrations</h1>
          <p className="page-sub">
            Platform API credentials — encrypted at rest. Twilio + database secrets stay in env.
          </p>
        </div>
      </div>

      {!encryptionOn && (
        <div className="empty" style={{ marginBottom: 20 }}>
          Set <code>CREDENTIALS_ENCRYPTION_KEY</code> in the environment to store credentials in-app.
          Until then values are read from env only and saving is disabled.
        </div>
      )}

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
