import Link from "next/link";
import { notFound } from "next/navigation";
import { credentialStatus, getSpec } from "@/lib/credentials";
import { credentialEncryptionAvailable } from "@/lib/crypto";
import { PlatformCard } from "../integrations-client";

export const dynamic = "force-dynamic";

export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await params;
  const spec = getSpec(platform);
  if (!spec) notFound();

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

      <PlatformCard platform={platformData} canSave={encryptionOn} />
    </>
  );
}
