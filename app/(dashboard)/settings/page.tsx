import Link from "next/link";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { syncRuns, trackingNumbers } from "@/lib/db/schema";
import { credentialStatus, CREDENTIAL_SPECS } from "@/lib/credentials";
import { getDefaultForwardNumber } from "@/lib/routing";
import { formatPhoneDisplay } from "@/lib/phone";
import { getSetting } from "@/lib/settings";
import { dateTime } from "@/lib/format";
import { TRACKING_ORIGINS_KEY, DEFAULT_ALLOWED_ORIGINS } from "@/lib/origin";
import { AttributionForm } from "./attribution-form";
import { TrackingOriginsForm } from "./tracking-origins-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  const defaultForward = await getDefaultForwardNumber();
  const attributionModel = await getSetting<string>("attribution_model", "last_touch");
  const customerWindowDays = await getSetting<number>("customer_window_days", 90);
  const storedOrigins = await getSetting<string[] | null>(TRACKING_ORIGINS_KEY, null);

  // Summary lines for the section cards.
  const statuses = await Promise.all(
    CREDENTIAL_SPECS.map(async (s) => ({
      label: s.label,
      configured: (await credentialStatus(s.platform)).some((f) => f.set),
    })),
  );
  const configured = statuses.filter((s) => s.configured).length;
  const [numAgg] = await db
    .select({
      active: sql<number>`count(*) filter (where ${trackingNumbers.status} = 'active')::int`,
      pool: sql<number>`count(*) filter (where not ${trackingNumbers.isStatic} and ${trackingNumbers.status} = 'active')::int`,
    })
    .from(trackingNumbers);
  const [lastRun] = await db
    .select({ job: syncRuns.job, status: syncRuns.status, startedAt: syncRuns.startedAt })
    .from(syncRuns)
    .orderBy(sql`${syncRuns.startedAt} desc`)
    .limit(1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Capture, numbers, integrations, data sync &amp; account</p>
        </div>
      </div>

      {/* Section cards — everything admin-shaped lives behind these four. */}
      <div className="cards" style={{ marginBottom: 20 }}>
        <Link href="/settings/capture-channels" className="card pad" style={{ display: "block" }}>
          <div className="label">◈ Capture channels →</div>
          <div className="value" style={{ fontSize: 16, marginTop: 6 }}>Calls, web forms &amp; Facebook</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>the sources that feed leads into the inbox</div>
        </Link>
        <Link href="/settings/numbers" className="card pad" style={{ display: "block" }}>
          <div className="label"># Tracking numbers →</div>
          <div className="value" style={{ fontSize: 16, marginTop: 6 }}>{numAgg?.active ?? 0} active</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{numAgg?.pool ?? 0} in the website DNI pool · buy, route &amp; release</div>
        </Link>
        <Link href="/settings/integrations" className="card pad" style={{ display: "block" }}>
          <div className="label">◱ Integrations →</div>
          <div className="value" style={{ fontSize: 16, marginTop: 6 }}>{configured} of {statuses.length} connected</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>HousecallPro, Google Ads, Facebook, Deepgram, Twilio</div>
        </Link>
        <Link href="/settings/sync" className="card pad" style={{ display: "block" }}>
          <div className="label">⟳ Data &amp; sync →</div>
          <div className="value" style={{ fontSize: 16, marginTop: 6 }}>
            {lastRun ? <>last run {lastRun.status === "success" ? "✓" : lastRun.status}</> : "no runs yet"}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {lastRun ? <>{lastRun.job} · {dateTime(lastRun.startedAt)}</> : "spend + revenue sync, manual spend"}
          </div>
        </Link>
      </div>

      {/* Inline config */}
      <div className="cards">
        <div className="card pad">
          <div className="label">◑ Signed in as</div>
          <div className="value" style={{ fontSize: 16 }}>{session?.email}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Owner · <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
              <button type="submit" style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit", fontSize: 12 }}>
                sign out
              </button>
            </form>
          </div>
        </div>
        <Link href="/settings/routing" className="card pad" style={{ display: "block" }}>
          <div className="label">☎ Default call routing →</div>
          <div className="value" style={{ fontSize: 16 }}>{formatPhoneDisplay(defaultForward)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>edit default forward · per-number override in Numbers</div>
        </Link>
        <AttributionForm initialModel={attributionModel} initialWindowDays={customerWindowDays} />
        <TrackingOriginsForm
          initialOrigins={storedOrigins?.length ? storedOrigins : DEFAULT_ALLOWED_ORIGINS}
          usingDefaults={!storedOrigins?.length}
        />
      </div>
    </>
  );
}
