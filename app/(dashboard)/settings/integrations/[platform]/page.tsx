import Link from "next/link";
import { notFound } from "next/navigation";
import { credentialStatus, getSpec } from "@/lib/credentials";
import { PlatformCard } from "../integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationDetailPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const spec = getSpec(platform);
  if (!spec) notFound();

  const platformData = {
    platform: spec.platform,
    label: spec.label,
    status: await credentialStatus(spec.platform),
  };

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/settings/integrations" className="muted" style={{ fontSize: 12 }}>
            ← Integrations
          </Link>
          <h1 className="page-title" style={{ marginTop: 4 }}>{spec.label}</h1>
          <p className="page-sub">
            Read-only. Values come from Railway environment variables on the <code>web</code> service —
            edit them there, then redeploy. <strong>Test</strong> calls the provider, which is the only
            way to tell a working credential from a merely present one.
          </p>
        </div>
      </div>

      {spec.platform === "google_ads" && (
        <div className="card pad" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>Replacing the refresh token</h2>
          <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.6 }}>
            There is no Connect button — the in-app OAuth flow was removed with the credential store,
            because it could only write somewhere nothing reads any more. To mint a replacement, run
            consent in the{" "}
            <a
              href="https://developers.google.com/oauthplayground"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)" }}
            >
              OAuth Playground
            </a>{" "}
            against this account&apos;s client, then paste the refresh token into{" "}
            <code>GOOGLE_ADS_REFRESH_TOKEN</code>.
            <br />
            <br />
            Both scopes are required and must be typed into <em>Input your own scopes</em> — Data
            Manager is not in the Playground&apos;s product list, and a consent that silently omits it
            still returns a valid-looking token that only fails later, at export time:
            <br />
            <code style={{ wordBreak: "break-all" }}>
              https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager
            </code>
            <br />
            <br />
            Verify before trusting it: <code>/api/diagnostics/data-manager</code> validates against
            Google without recording anything. <strong>Never revoke the grant</strong> to force a fresh
            token — the OAuth client is shared with the Arbor MCP server, and revoking kills its token
            too.
          </p>
        </div>
      )}

      <PlatformCard platform={platformData} />
    </>
  );
}
