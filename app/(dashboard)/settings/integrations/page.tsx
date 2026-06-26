import { CREDENTIAL_SPECS, credentialStatus } from "@/lib/credentials";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { IntegrationsClient } from "./integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const encryptionOn = credentialEncryptionAvailable();

  const platforms = await Promise.all(
    CREDENTIAL_SPECS.map(async (s) => ({
      platform: s.platform,
      label: s.label,
      fields: s.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: !!f.secret,
        placeholder: f.placeholder ?? "",
      })),
      status: await credentialStatus(s.platform),
    })),
  );

  return (
    <>
      <h1 className="page-title">Integrations</h1>
      <p className="page-sub">
        Platform API credentials — encrypted at rest. Twilio + database secrets stay in env.
      </p>

      {!encryptionOn && (
        <div className="empty" style={{ marginBottom: 20 }}>
          Set <code>CREDENTIALS_ENCRYPTION_KEY</code> in the environment to store credentials in-app.
          Until then values are read from env only and saving is disabled.
        </div>
      )}

      <IntegrationsClient platforms={platforms} canSave={encryptionOn} />
    </>
  );
}
