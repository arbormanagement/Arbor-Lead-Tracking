import Link from "next/link";
import { getSession } from "@/lib/auth";
import { credentialStatus, CREDENTIAL_SPECS } from "@/lib/credentials";
import { getDefaultForwardNumber } from "@/lib/routing";
import { formatPhoneDisplay } from "@/lib/phone";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  const defaultForward = await getDefaultForwardNumber();

  // How many platforms have at least one credential resolved (db or env).
  const statuses = await Promise.all(
    CREDENTIAL_SPECS.map(async (s) => ({
      label: s.label,
      configured: (await credentialStatus(s.platform)).some((f) => f.set),
    })),
  );
  const configured = statuses.filter((s) => s.configured).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Account, routing, and integration credentials</p>
        </div>
      </div>

      <Link href="/settings/facebook-forms" className="card pad" style={{ display: "block", marginBottom: 14 }}>
        <div className="label">ⓕ Facebook lead forms</div>
        <div className="value" style={{ fontSize: 17, marginTop: 6 }}>Choose which forms become leads →</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Exclude recruiting / non-customer forms from the inbox</div>
      </Link>

      <Link href="/settings/integrations" className="card pad" style={{ display: "block", marginBottom: 20 }}>
        <div className="label">⚙ Integrations</div>
        <div className="value" style={{ fontSize: 17, marginTop: 6 }}>
          Manage API credentials →
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {configured} of {statuses.length} connected · HousecallPro, Google Ads, Facebook, Deepgram, Twilio — encrypted at rest
        </div>
      </Link>

      <div className="cards">
        <div className="card pad">
          <div className="label">◑ Signed in as</div>
          <div className="value" style={{ fontSize: 16 }}>{session?.email}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Owner</div>
        </div>
        <Link href="/settings/routing" className="card pad" style={{ display: "block" }}>
          <div className="label">☎ Default call routing →</div>
          <div className="value" style={{ fontSize: 16 }}>{formatPhoneDisplay(defaultForward)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>edit default forward · per-number override in /numbers</div>
        </Link>
        <div className="card pad">
          <div className="label">◈ Attribution model</div>
          <div className="value" style={{ fontSize: 16 }}>Last-touch</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>first-touch toggle planned</div>
        </div>
      </div>

      <div className="empty">
        Editable settings (routing rules per number/location, whisper text, spam rules,
        attribution window) are wired up in later phases. Sign out:{" "}
        <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
          <button type="submit" style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit" }}>
            log out
          </button>
        </form>
      </div>
    </>
  );
}
