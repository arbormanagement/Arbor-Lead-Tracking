/**
 * Crawler detection for the DNI assign path.
 *
 * A pool number is a scarce, 15-minute-exclusive resource, and a crawler will never dial it.
 * GA4 filters known bots from its reporting; `track.js` does not, so every crawler pageview
 * was taking a number out of rotation and pushing a real visitor onto the static fallback —
 * which is the site's own published number, making that visitor's session indistinguishable
 * from untracked direct traffic.
 *
 * This is the most likely explanation for a gap measured on 2026-08-12: GA4 realtime reported
 * 3 active users while the pool issued 5 leases in 13 minutes. Ad blockers explain GA4 running
 * 10–30% light; they do not explain 2.5×.
 *
 * Deliberately conservative about what it costs to be wrong. A false positive costs one
 * visitor their attribution (they see the site's own number and still get through). A false
 * negative costs a pool slot for 15 minutes, which can cost several visitors theirs. So an
 * absent user-agent counts as a bot: every real browser sends one on a POST.
 *
 * Only used to decide whether to LEASE. Crawlers are not blocked from `/api/track` — pageview
 * capture is cheap and unbounded, and rejecting it there would change what the site records
 * rather than what the pool spends.
 */
const BOT_UA =
  /bot\b|bots?\/|crawl|spider|slurp|scrap|headlesschrome|phantomjs|puppeteer|playwright|selenium|python-requests|aiohttp|httpx|curl\/|wget|libwww|java\/|go-http|okhttp|axios\/|node-fetch|facebookexternalhit|whatsapp|telegrambot|discordbot|slackbot|linkedinbot|twitterbot|embedly|quora link preview|ahrefs|semrush|mj12|dotbot|petal|yandex|baidu|sogou|exabot|ia_archiver|lighthouse|gtmetrix|pingdom|uptimerobot|statuscake|site24x7|newrelic|datadog|censys|masscan|zgrab/i;

export function isLikelyBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (!ua) return true;
  return BOT_UA.test(ua);
}
