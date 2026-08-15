import Link from "next/link";
import { selectedTouchModel, touchModelLabel } from "@/lib/attribution/model";
import { TIMEFRAMES, pickDays, timeframeLabel } from "@/lib/timeframes";
import { CoverageNotice } from "../coverage-notice";
import { CampaignView } from "./campaign-view";
import { ChannelView } from "./channel-view";
import { PageView } from "./page-view";
import { DEFAULT_DAYS, DEFAULT_VIEW, parseView, sourcesHref, VIEWS } from "./view";

export const dynamic = "force-dynamic";

/**
 * Sources — one surface for "where does the work come from", at three grains:
 * channel, campaign, landing page.
 *
 * Campaigns and Landing pages used to be their own nav items (`/roi`, `/pages`).
 * They are the same question asked at different resolutions, and giving each its own
 * tab meant three places to set a timeframe and three subtly different answers to
 * compare by hand. Both routes now redirect here, the way `/leads`, `/calls`,
 * `/numbers` and `/spend` were retired into their new homes.
 *
 * **The views share a shell, not a table**, and that is deliberate. Channel and
 * Campaign read the `roi_daily` rollup and carry spend; Landing pages reads
 * `web_sessions` + `leads` and has no spend at all, because cost attaches to a
 * campaign rather than a page. Forcing them into one table would have meant either an
 * empty Spend column or dropping the conversion rate that is the whole reason the
 * page view exists. Each view keeps the columns its question needs.
 *
 * One consequence worth knowing before comparing them: Channel and Campaign window on
 * `roi_daily`'s BUSINESS date, Landing pages windows on raw session and lead
 * timestamps. At a window edge the totals will not reconcile row-for-row.
 */
export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; view?: string }>;
}) {
  const { days: daysParam, view: viewParam } = await searchParams;
  const days = pickDays(daysParam, DEFAULT_DAYS);
  const view = parseView(viewParam);
  // Read once here rather than in each view: it is a settings lookup, and the
  // subtitle needs it anyway. Landing pages ignores it — attribution touch model
  // has no meaning for a session count.
  const touch = await selectedTouchModel();
  const meta = VIEWS.find((v) => v.key === view)!;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Sources</h1>
          <p className="page-sub">
            {meta.sub} · {timeframeLabel(days)}
            {view !== "page" && <> · {touchModelLabel(touch)}</>}
          </p>
          {view === "channel" && (
            <p className="page-sub" style={{ marginTop: 2, fontSize: 12 }}>
              <span className="muted">
                A source expands by location only where it can actually tell them apart — Google Business Profile is two
                profiles, one per branch, each with its own link tag and tracking number. Elsewhere location is inferred
                from the landing page and is mostly unknown, so it is not broken out.
              </span>
            </p>
          )}
        </div>
        <div className="controls">
          {/* View first, then timeframe — the view decides what the numbers mean,
              the timeframe only how many of them there are. */}
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={sourcesHref(v.key, days)}
              className="pill"
              style={
                view === v.key
                  ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" }
                  : undefined
              }
            >
              {v.label}
            </Link>
          ))}
          <span className="muted" style={{ fontSize: 12, fontWeight: 600, marginLeft: 6 }}>◷</span>
          {TIMEFRAMES.map((t) => (
            <Link
              key={t.days}
              href={sourcesHref(view, t.days)}
              className="pill"
              style={
                days === t.days
                  ? { color: "var(--accent)", borderColor: "var(--accent-line)", background: "var(--accent-soft)" }
                  : undefined
              }
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Only on the spend-bearing views. The notice is about a window of spend being
          divided by a shorter window of attributed outcomes, which is not what the
          landing-page view computes — it has no spend in it. */}
      {view !== "page" && <CoverageNotice days={days} />}

      {view === DEFAULT_VIEW && <ChannelView days={days} touch={touch} />}
      {view === "campaign" && <CampaignView days={days} touch={touch} />}
      {view === "page" && <PageView days={days} />}
    </>
  );
}
