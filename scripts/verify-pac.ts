import { db } from "@/lib/db/client";
import { visitors, webSessions, numberAssignments, trackingNumbers, pools } from "@/lib/db/schema";
import { resolveInboundAttribution } from "@/lib/twilio/inbound";
import { landingPagePerformance } from "@/lib/queries/sources";
import { eq, sql } from "drizzle-orm";

/**
 * Verifies the page-at-conversion capture against a real Postgres, in the style
 * of verify-hcp-queries.ts — this repo has no test runner, and `tsc` cannot see
 * inside a `sql` template, which is exactly where the risk in this change lives.
 *
 * DESTRUCTIVE: it truncates the tables it fixtures. It refuses to run against
 * anything that does not look like a local scratch database, because the failure
 * mode of getting that wrong is deleting production leads.
 */
const url = process.env.DATABASE_URL ?? "";
const isScratch = /localhost|127\.0\.0\.1|host=\/tmp/.test(url) && !/railway|neon|prod/i.test(url);
if (!isScratch) {
  console.error("refusing to run: DATABASE_URL is not a local scratch database.");
  console.error("this script truncates tables. point it at a throwaway Postgres.");
  process.exit(1);
}

const ok = (b: boolean, m: string) => console.log(`  ${b ? "PASS" : "FAIL"}  ${m}`);

async function main() {
  // Idempotent: the script is meant to be re-runnable against a scratch database.
  await db.execute(sql`truncate number_assignments, tracking_numbers, pools, web_sessions, leads, visitors restart identity cascade`);
  await db.insert(visitors).values({ id: "vis1" });

  // ── 1. First pageview: landing_page and last_page both the entry page ──────
  const upsert = (url: string) =>
    db.insert(webSessions).values({ id: "s1", visitorId: "vis1", landingPage: url, lastPage: url })
      .onConflictDoUpdate({
        target: webSessions.id,
        set: { lastActivityAt: new Date(), lastPage: sql`excluded.last_page` },
      });

  await upsert("https://arbor-mgmt.com/");
  let [s] = await db.select().from(webSessions).where(eq(webSessions.id, "s1"));
  ok(s.landingPage === "https://arbor-mgmt.com/" && s.lastPage === "https://arbor-mgmt.com/", "first pageview sets both");

  // ── 2. Second pageview: last_page moves, landing_page FROZEN ──────────────
  await upsert("https://arbor-mgmt.com/locations/belleville-tree-services");
  [s] = await db.select().from(webSessions).where(eq(webSessions.id, "s1"));
  ok(s.landingPage === "https://arbor-mgmt.com/", "landing_page NOT overwritten (the load-bearing one)");
  ok(s.lastPage === "https://arbor-mgmt.com/locations/belleville-tree-services", "last_page updated by excluded.last_page");

  // ── 3. Third pageview, to be sure it keeps moving ─────────────────────────
  await upsert("https://arbor-mgmt.com/services/tree-removal");
  [s] = await db.select().from(webSessions).where(eq(webSessions.id, "s1"));
  ok(s.landingPage === "https://arbor-mgmt.com/", "landing_page still frozen after 3 pageviews");
  ok(s.lastPage === "https://arbor-mgmt.com/services/tree-removal", "last_page tracks the newest page");

  // ── 4. resolveInboundAttribution LEFT JOIN ────────────────────────────────
  await db.insert(pools).values({ id: "p1", key: "google-cpc", displayName: "Google CPC" } as any);
  await db.insert(trackingNumbers).values({ id: "tn1", twilioSid: "PN1", phoneNumber: "+15551110000", pool: "google-cpc" } as any);
  await db.insert(numberAssignments).values({
    id: "na1", trackingNumberId: "tn1", webSessionId: "s1", visitorId: "vis1",
    expiresAt: new Date(Date.now() + 3600_000), source: "google/cpc",
    landingPage: "https://arbor-mgmt.com/",
  });
  const [tn] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, "tn1"));
  const a = await resolveInboundAttribution(tn);
  ok(a.lease?.id === "na1", "lease still resolves and keeps its full row shape");
  ok(a.lease?.landingPage === "https://arbor-mgmt.com/", "lease.landingPage unchanged (entry page)");
  ok(a.conversionPage === "https://arbor-mgmt.com/services/tree-removal", "conversionPage = session's last page");

  // ── 5. LEFT, not inner: a lease with no session row must still resolve ────
  await db.insert(trackingNumbers).values({ id: "tn2", twilioSid: "PN2", phoneNumber: "+15551110001", pool: "google-cpc" } as any);
  await db.insert(numberAssignments).values({
    id: "na2", trackingNumberId: "tn2", webSessionId: null, visitorId: null,
    expiresAt: new Date(Date.now() + 3600_000), source: "google/cpc",
  });
  const [tn2] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, "tn2"));
  const a2 = await resolveInboundAttribution(tn2);
  ok(a2.lease?.id === "na2", "lease with NO session still resolves (LEFT join holds)");
  ok(a2.conversionPage === null, "conversionPage null rather than losing the lease");

  // ── 6. Both report bases run and the default is unchanged ────────────────
  const entry = await landingPagePerformance(30);
  const conv = await landingPagePerformance(30, "conversion");
  ok(Array.isArray(entry.rows), "landingPagePerformance(30) still works with no basis arg");
  ok(entry.rows.some((r) => r.path === "/"), "entry basis groups the session under /");
  ok(conv.rows.some((r) => r.path === "/services/tree-removal"), "conversion basis groups it under the last page");
  process.exit(0);
}
main().catch((e) => { console.error("THREW:", e.message); process.exit(1); });
