import { CREDENTIAL_SPECS, credentialStatus } from "@/lib/credentials";
import { IntegrationRow } from "./integrations-client";

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
        // Name the env var, not the internal key — it is the thing you go and change.
        missing: status.filter((f) => !f.set).map((f) => f.envKey ?? f.key),
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
            Read-only. Every credential comes from a Railway environment variable on the{" "}
            <code>web</code> service — there is no in-app store, so there is exactly one place a value
            can come from. <strong>Test</strong> calls the provider, which is the only way to tell a
            working credential from a merely present one.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {platforms.map((p) => (
          <IntegrationRow key={p.platform} p={p} />
        ))}
      </div>

      <div className="card pad" style={{ marginTop: 20 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Replacing the Google refresh token</div>
        <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.7 }}>
          There is no Connect button — the in-app OAuth flow went with the credential store, since it
          could only write somewhere nothing reads. Run consent in the{" "}
          <a
            href="https://developers.google.com/oauthplayground"
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--accent)" }}
          >
            OAuth Playground
          </a>{" "}
          and paste the refresh token into <code>GOOGLE_ADS_REFRESH_TOKEN</code>. Both scopes must be
          typed into <em>Input your own scopes</em> — Data Manager is not in the product list, and a
          consent that silently omits it still returns a valid-looking token that only fails later, at
          export time:
          <br />
          <code style={{ wordBreak: "break-all" }}>
            https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager
          </code>
          <br />
          Verify with <code>/api/diagnostics/data-manager</code> before trusting it (validates against
          Google, records nothing). <strong>Never revoke the grant</strong> to force a fresh token — the
          OAuth client is shared with the Arbor MCP server.
        </p>
      </div>
    </>
  );
}
