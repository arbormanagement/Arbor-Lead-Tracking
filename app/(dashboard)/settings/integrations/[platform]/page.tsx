import Link from "next/link";
import { notFound } from "next/navigation";
import { credentialStatus, getSpec } from "@/lib/credentials";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { redirectUri } from "@/lib/integrations/google-oauth";
import { PlatformCard } from "../integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { platform } = await params;
  const spec = getSpec(platform);
  if (!spec) notFound();

  const sp = await searchParams;
  const oauthStatus = typeof sp.google_oauth === "string" ? sp.google_oauth : null;
  const oauthMessage = typeof sp.message === "string" ? sp.message : null;

  const encryptionOn = credentialEncryptionAvailable();
  const platformData = {
    platform: spec.platform,
    label: spec.label,
    fields: spec.fields.map((f) => ({
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      placeholder: f.placeholder ?? "",
    })),
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
          <p className="page-sub">Platform API credentials — encrypted at rest.</p>
        </div>
      </div>

      {!encryptionOn && (
        <div className="empty" style={{ marginBottom: 20 }}>
          Set <code>CREDENTIALS_ENCRYPTION_KEY</code> in the environment to store credentials in-app.
          Until then values are read from env only and saving is disabled.
        </div>
      )}

      {spec.platform === "google_ads" && (
        <div className="card pad" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>Connect with Google</h2>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 10px", lineHeight: 1.5 }}>
            Mints a refresh token with both <code>adwords</code> (spend + reporting) and{" "}
            <code>datamanager</code> (offline conversion export) and stores it encrypted. Consent is
            incremental, so scopes you have already granted are kept. Offline conversion export cannot
            work without the second scope — the token currently in use only has the first.
          </p>
          {oauthStatus && (
            <div
              style={{
                marginBottom: 10,
                fontSize: 12,
                lineHeight: 1.5,
                padding: "9px 11px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                color: oauthStatus === "ok" ? "var(--accent)" : "var(--danger)",
                wordBreak: "break-word",
              }}
            >
              <strong>{oauthStatus === "ok" ? "Connected" : "Not connected"}</strong>
              {oauthMessage ? ` — ${oauthMessage}` : null}
            </div>
          )}
          <a className="btn" href="/api/oauth/google/start">
            Connect Google Ads
          </a>
          <p className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            One-time setup: this exact URI must be listed under <em>Authorized redirect URIs</em> on the
            OAuth client in Google Cloud Console, or Google rejects the request before it ever reaches
            this app.
            <br />
            <code>{redirectUri()}</code>
          </p>
        </div>
      )}

      <PlatformCard platform={platformData} canSave={encryptionOn} />
    </>
  );
}
