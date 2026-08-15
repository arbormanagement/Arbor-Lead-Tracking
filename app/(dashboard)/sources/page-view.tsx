import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import Link from "next/link";
import { isLikelyBot } from "@/lib/bot";
import { campaignNotExcluded, excludedCampaignIds } from "@/lib/campaigns";
import { db } from "@/lib/db/client";
import { leads, webSessions } from "@/lib/db/schema";
import { dollars } from "@/lib/format";
import { landingPathSql } from "@/lib/landing-page";
import { estimateDrilldown } from "./drilldown";
import { sourcesHref } from "./view";

/**
 * Page performance — a CRO view, deliberately not an attribution one.
 *
 * **No spend column, and that is the point.** Money attaches to a campaign, not to a
 * landing page; splitting it across pages would be arbitrary, and no serious
 * attribution system does it. The question here is a RATE — of the people who landed
 * on this page, how many got in touch — and rates need the visitors who did NOT
 * convert in the denominator, which is why this reads `web_sessions` rather than
 * working backwards from leads.
 *
 * That is also why this view keeps its own table rather than joining the two above
 * it: they are built on `roi_daily`, which holds outcomes only, so the people who
 * never got in touch are not in it and the denominator does not exist there.
 *
 * That denominator is what makes this answerable at Arbor's volume. A page-level
 * revenue comparison needs on the order of a hundred conversions per page and would
 * be noise for a year; a session→contact rate has thousands of sessions behind it and
 * separates pages within weeks.
 *
 * The column that earns this view its keep is **Close** — of the contacts a page
 * produced, how many became won estimates. GA4 already reports page conversion rate
 * perfectly well and needs no help; what it cannot know is which pages produce
 * contacts that actually close, because that outcome lives in HousecallPro. A page can
 * produce fewer contacts and better ones, and that is the finding worth acting on.
 */
export async function PageView({ days }: { days: number }) {
  const since = new Date(Date.now() - days * 86_400_000);
  const excluded = await excludedCampaignIds();

  // Sessions carry their user-agent so crawlers can be dropped in JS through the
  // SAME predicate the DNI gate uses. Replicating that regex in SQL would give two
  // definitions of "bot" that drift; the row count here is small enough that there
  // is no reason to.
  const sessionRows = await db
    .select({ path: landingPathSql(webSessions.landingPage), ua: webSessions.userAgent })
    .from(webSessions)
    .where(
      and(gte(webSessions.startedAt, since), isNotNull(webSessions.landingPage), ne(webSessions.landingPage, "")),
    );

  // `isLikelyBot` treats an ABSENT user-agent as a bot. That is right where it is
  // used — a pool number is scarce and a false negative costs several visitors
  // their attribution — but it is wrong here, and the asymmetry reverses: user_agent
  // was only recorded from 2026-08-13, so counting older sessions as crawlers would
  // silently shrink the denominator and inflate every conversion rate on the page.
  // Unknown is counted as human and reported, rather than assumed either way.
  let unknownUa = 0;
  const sessionsByPath = new Map<string, number>();
  for (const s of sessionRows) {
    if (s.ua == null || s.ua.trim() === "") unknownUa++;
    else if (isLikelyBot(s.ua)) continue;
    sessionsByPath.set(s.path, (sessionsByPath.get(s.path) ?? 0) + 1);
  }

  // Contacts and what they became. Counted from `leads` — every non-spam contact,
  // not a "qualified lead" — so this agrees with the demand figure everywhere else.
  const outcomeRows = await db
    .select({
      path: landingPathSql(leads.landingPage),
      contacts: sql<number>`count(*)::int`,
      estimates: sql<number>`count(*) filter (where ${leads.hcpEstimateId} is not null)::int`,
      won: sql<number>`count(*) filter (where ${leads.status} = 'won')::int`,
      revenue: sql<number>`coalesce(sum(${leads.salesValueCents}) filter (where ${leads.status} = 'won'), 0)::int`,
    })
    .from(leads)
    .where(
      and(
        gte(leads.occurredAt, since),
        eq(leads.isSpam, false),
        isNotNull(leads.landingPage),
        ne(leads.landingPage, ""),
        campaignNotExcluded(leads.campaignId, excluded),
      ),
    )
    .groupBy(landingPathSql(leads.landingPage));

  const outcomeByPath = new Map(outcomeRows.map((r) => [r.path, r]));
  const paths = [...new Set([...sessionsByPath.keys(), ...outcomeByPath.keys()])];

  const rows = paths
    .map((path) => {
      const o = outcomeByPath.get(path);
      const sessions = sessionsByPath.get(path) ?? 0;
      return {
        path,
        sessions,
        contacts: o?.contacts ?? 0,
        estimates: o?.estimates ?? 0,
        won: o?.won ?? 0,
        revenue: o?.revenue ?? 0,
      };
    })
    .sort((a, b) => b.sessions - a.sessions || b.contacts - a.contacts);

  const totals = rows.reduce(
    (a, r) => ({
      sessions: a.sessions + r.sessions,
      contacts: a.contacts + r.contacts,
      estimates: a.estimates + r.estimates,
      won: a.won + r.won,
      revenue: a.revenue + r.revenue,
    }),
    { sessions: 0, contacts: 0, estimates: 0, won: 0, revenue: 0 },
  );

  // A rate off a handful of sessions is noise wearing a percent sign, so it is
  // withheld rather than printed small. 30 is a low bar, deliberately: the point is
  // to suppress the 1-of-2 rows, not to wait for significance.
  const MIN_SESSIONS_FOR_RATE = 30;
  const pct = (num: number, den: number, floor = 0) =>
    den >= floor && den > 0 ? `${Math.round((num / den) * 100)}%` : "—";

  return (
    <>
      {rows.length === 0 ? (
        <div className="empty">No landing pages recorded in this window — populates from track.js on arbor-mgmt.com.</div>
      ) : (
        <>
          <div className="table-scroll" style={{ marginBottom: 14 }}>
            <table>
              <thead>
                <tr>
                  <th>Page</th>
                  <th title="Visits that started on this page, crawlers excluded">Sessions</th>
                  <th title="People who got in touch after landing here">Contacts</th>
                  <th title="Contacts ÷ sessions — the page's job">Conv.</th>
                  <th title="Contacts that became a scheduled estimate">Estimates</th>
                  <th title="Estimates approved">Won</th>
                  <th title="Won ÷ estimates — whether this page sends good work, not just volume">Close</th>
                  <th style={{ textAlign: "right" }}>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.path}>
                    <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.path}>
                      <Link href={estimateDrilldown({ page: r.path }, days)} className="link">{r.path}</Link>
                    </td>
                    <td className="mono">{r.sessions || <span className="muted">—</span>}</td>
                    <td className="mono">{r.contacts}</td>
                    <td className="mono muted">{pct(r.contacts, r.sessions, MIN_SESSIONS_FOR_RATE)}</td>
                    <td className="mono">{r.estimates}</td>
                    <td>{r.won > 0 ? <span className="badge win">{r.won}</span> : <span className="muted mono">0</span>}</td>
                    <td className="mono muted">{pct(r.won, r.estimates)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {r.revenue > 0 ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>{dollars(r.revenue)}</span> : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td>Total</td>
                  <td className="mono">{totals.sessions}</td>
                  <td className="mono">{totals.contacts}</td>
                  <td className="mono muted">{pct(totals.contacts, totals.sessions)}</td>
                  <td className="mono">{totals.estimates}</td>
                  <td className="mono">{totals.won}</td>
                  <td className="mono muted">{pct(totals.won, totals.estimates)}</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--accent)" }}>{dollars(totals.revenue)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="page-sub" style={{ fontSize: 12.5 }}>
            No spend column on purpose: cost attaches to a campaign, not a page — see{" "}
            <Link href={sourcesHref("campaign", days)} className="link">Campaigns</Link> for return on spend. Conversion is withheld under{" "}
            {MIN_SESSIONS_FOR_RATE} sessions rather than printed as noise.
            {unknownUa > 0 && (
              <> {unknownUa} session{unknownUa === 1 ? " has" : "s have"} no user-agent recorded (captured from
              2026-08-13) and {unknownUa === 1 ? "is" : "are"} counted as human rather than guessed at, so older
              windows may include some crawler traffic.</>
            )}
          </p>
        </>
      )}
    </>
  );
}
