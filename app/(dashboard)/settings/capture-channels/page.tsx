import { sql } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { calls, trackingNumbers } from "@/lib/db/schema";
import { FormsClient } from "./forms-client";

export const dynamic = "force-dynamic";

export default async function CaptureChannelsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Tracking-number summary (call capture channel).
  const [numAgg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${trackingNumbers.status} = 'active')::int`,
      pool: sql<number>`count(*) filter (where not ${trackingNumbers.isStatic} and ${trackingNumbers.status} = 'active')::int`,
    })
    .from(trackingNumbers);
  const [callCount] = await db.select({ n: sql<number>`count(*)::int` }).from(calls);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Capture channels</h1>
          <p className="page-sub">The sources that feed leads into the inbox.</p>
        </div>
      </div>

      <div className="cards" style={{ marginBottom: 22 }}>
        <Link href="/numbers" className="card pad" style={{ display: "block" }}>
          <div className="label">☎ Call tracking →</div>
          <div className="value" style={{ fontSize: 20 }}>{numAgg?.active ?? 0} active</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{numAgg?.pool ?? 0} in website pool · {callCount?.n ?? 0} calls tracked</div>
        </Link>
        <Link href="/settings/integrations" className="card pad" style={{ display: "block" }}>
          <div className="label">✉ Web forms →</div>
          <div className="value" style={{ fontSize: 20 }}>track.js</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>install on arbor-mgmt.com to capture web-form leads</div>
        </Link>
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 650, margin: "8px 0 12px" }}>ⓕ Facebook lead forms</h3>
      <FormsClient />
    </>
  );
}
