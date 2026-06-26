import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { leads, calls, roiDaily } from "@/lib/db/schema";
import { dollars } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  // Last 30 days, blended.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [leadAgg] = await db
    .select({
      total: sql<number>`count(*)::int`,
      calls: sql<number>`count(*) filter (where ${leads.type} = 'call')::int`,
      forms: sql<number>`count(*) filter (where ${leads.type} = 'web_form')::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
    })
    .from(leads)
    .where(sql`${leads.occurredAt} >= ${since} and ${leads.isSpam} = false`);

  const [roiAgg] = await db
    .select({
      spend: sql<number>`coalesce(sum(${roiDaily.spendCents}),0)::int`,
      revenue: sql<number>`coalesce(sum(${roiDaily.revenueCents}),0)::int`,
    })
    .from(roiDaily)
    .where(sql`${roiDaily.date} >= ${since.toISOString().slice(0, 10)}`);

  const [callAgg] = await db
    .select({ recorded: sql<number>`count(*) filter (where ${calls.recordingUrl} is not null)::int` })
    .from(calls);

  const spend = roiAgg?.spend ?? 0;
  const revenue = roiAgg?.revenue ?? 0;
  const roi = spend > 0 ? (revenue / spend).toFixed(2) + "×" : "—";
  const cpl = leadAgg?.total ? dollars(Math.round(spend / leadAgg.total)) : "—";

  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-sub">Last 30 days · all sources · Edwardsville + O&apos;Fallon</p>

      <div className="cards">
        <Stat label="Leads" value={String(leadAgg?.total ?? 0)} />
        <Stat label="Calls" value={String(leadAgg?.calls ?? 0)} />
        <Stat label="Forms" value={String(leadAgg?.forms ?? 0)} />
        <Stat label="Won" value={String(leadAgg?.won ?? 0)} />
        <Stat label="Ad spend" value={dollars(spend)} />
        <Stat label="Revenue" value={dollars(revenue)} />
        <Stat label="ROI" value={roi} />
        <Stat label="Cost / lead" value={cpl} />
      </div>

      {!leadAgg?.total && (
        <div className="empty">
          No leads yet. Once tracking numbers are provisioned and <code>track.js</code> is live,
          calls and forms will appear here. Recorded calls so far: {callAgg?.recorded ?? 0}.
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
