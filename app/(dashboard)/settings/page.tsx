import Link from "next/link";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Routing, whisper text, spam rules, attribution window</p>

      <Link href="/settings/integrations" className="card" style={{ display: "block", marginBottom: 20 }}>
        <div className="label">Integrations</div>
        <div className="value" style={{ fontSize: 16 }}>
          Manage API credentials →
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          HousecallPro, Google Ads, Facebook, Deepgram — encrypted at rest
        </div>
      </Link>

      <div className="cards">
        <div className="card">
          <div className="label">Signed in as</div>
          <div className="value" style={{ fontSize: 16 }}>
            {session?.email}
          </div>
        </div>
        <div className="card">
          <div className="label">Default call routing</div>
          <div className="value" style={{ fontSize: 16 }}>
            Office · +1 (618) 836-8004
          </div>
        </div>
        <div className="card">
          <div className="label">Attribution model</div>
          <div className="value" style={{ fontSize: 16 }}>
            Last-touch
          </div>
        </div>
      </div>

      <div className="empty">
        Editable settings (routing rules per number/location, whisper text, spam rules,
        attribution window) are wired up in later phases. Sign out:{" "}
        <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
          <button
            type="submit"
            style={{
              background: "none",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            log out
          </button>
        </form>
      </div>
    </>
  );
}
