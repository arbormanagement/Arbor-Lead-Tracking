import { z } from "zod";
import { classifySource } from "@/lib/attribution/classify";
import { db } from "@/lib/db/client";
import { visitors, webSessions } from "@/lib/db/schema";
import { isLikelyBot } from "@/lib/bot";
import { isAllowedOrigin } from "@/lib/origin";
import { formatPhoneDisplay } from "@/lib/phone";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  findShareableLease,
  getActiveAssignmentForSession,
  getFallbackNumber,
  getNewestAssignmentAtVisitorCap,
  leaseNumber,
  releaseExpired,
} from "@/lib/dni/assign";

export const runtime = "nodejs";

/**
 * Pool-based DNI: lease a per-session tracking number for the visitor's source so
 * `track.js` can swap the displayed phone number. Cookieless (keys off the
 * client-provided session id), CORS-open for the cross-origin call from the site.
 *
 * Order: reap expired leases → reuse this session's existing number → seed
 * visitor/session rows (the pageview beacon races us and may be ad-blocked) →
 * per-visitor lease cap → lease from the single shared website pool → static
 * fallback. The visitor's source is frozen
 * onto the lease, so the number itself is channel-agnostic. Never throws to the
 * page; on any failure it returns `{ number: null }` and the page keeps its number.
 */
const Body = z.object({
  vid: z.string().min(1).max(64),
  sid: z.string().min(1).max(64),
  url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  utm: z
    .object({
      source: z.string().max(256).optional(),
      medium: z.string().max(256).optional(),
      campaign: z.string().max(256).optional(),
      term: z.string().max(256).optional(),
    })
    .partial()
    .optional(),
  click: z
    .object({
      gclid: z.string().max(512).optional(),
      gbraid: z.string().max(512).optional(),
      wbraid: z.string().max(512).optional(),
      fbclid: z.string().max(512).optional(),
    })
    .partial()
    .optional(),
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  // Public-endpoint hygiene: browser posts must come from our own sites, and
  // each IP gets a budget — leases are a finite pool worth protecting.
  //
  // `requireOrigin` matters here specifically. The pool is 5 numbers and the
  // per-visitor cap keys on the client-supplied `vid`, so five requests with five
  // fabricated vids lease the whole pool; repeated, that keeps every real visitor
  // on the static fallback and silently ends paid-click attribution. Browsers
  // always send Origin on a POST, so requiring it costs real visitors nothing.
  if (!(await isAllowedOrigin(req, { requireOrigin: true }))) {
    return Response.json({ error: "origin not allowed" }, { status: 403, headers: CORS });
  }
  // A crawler will never dial the number it is handed, but it holds one for the full lease
  // window while it does not. Returning null leaves the page on its own hard-coded number,
  // which is exactly the right outcome for a bot and costs a misdetected human only their
  // attribution, not their call.
  if (isLikelyBot(req.headers.get("user-agent"))) {
    return Response.json({ number: null }, { headers: CORS });
  }
  // Tighter than /api/track's budget: a page needs ONE lease per session, not 30
  // per minute, and each request can consume a scarce pool number.
  const rl = rateLimit(`dni:${clientIp(req)}`, 10, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "rate limited" },
      { status: 429, headers: { ...CORS, "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let b;
  try {
    b = Body.parse(JSON.parse(await req.text()));
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400, headers: CORS });
  }

  try {
    const { vid, sid, url, referrer, utm = {}, click = {} } = b;

    await releaseExpired();

    // Same session → same number.
    const existing = await getActiveAssignmentForSession(sid);
    if (existing) return numberResponse(existing.phoneNumber);

    const cls = classifySource({
      gclid: click.gclid,
      gbraid: click.gbraid,
      wbraid: click.wbraid,
      fbclid: click.fbclid,
      utmSource: utm.source,
      utmMedium: utm.medium,
      referrer,
      currentUrl: url,
    });
    const medium = utm.medium?.toLowerCase() ?? cls.medium;
    const snapshot = {
      source: cls.sourceKey,
      medium,
      campaign: utm.campaign,
      keyword: utm.term,
      gclid: click.gclid,
      gbraid: click.gbraid,
      wbraid: click.wbraid,
      fbclid: click.fbclid,
      landingPage: url,
    };

    // FK safety: the snippet fires the pageview beacon and this assign call
    // concurrently — and /api/track may be ad-blocked outright — so the visitor/
    // session rows the lease FKs reference may not exist yet. Seed minimal rows
    // from this request's own attribution (no-op when the pageview won the race).
    await db
      .insert(visitors)
      .values({
        id: vid,
        ftSource: cls.sourceKey,
        ftMedium: medium,
        ftCampaign: utm.campaign,
        ftTerm: utm.term,
        ftGclid: click.gclid,
        ftFbclid: click.fbclid,
        ftReferrer: referrer,
        ftLandingPage: url,
        ftAt: new Date(),
      })
      .onConflictDoNothing({ target: visitors.id });
    await db
      .insert(webSessions)
      .values({
        id: sid,
        visitorId: vid,
        source: cls.sourceKey,
        medium,
        campaign: utm.campaign,
        term: utm.term,
        gclid: click.gclid,
        gbraid: click.gbraid,
        wbraid: click.wbraid,
        fbclid: click.fbclid,
        referrer,
        landingPage: url,
      })
      .onConflictDoNothing({ target: webSessions.id });

    // Cap concurrent leases per visitor: at the cap, reuse their newest number
    // rather than letting one visitor (e.g. sid churn with blocked cookies)
    // drain the pool.
    const capped = await getNewestAssignmentAtVisitorCap(vid);
    if (capped) return numberResponse(capped.phoneNumber);

    // Before spending a number: is one already out that says exactly the same thing? Only
    // ever true for visitors with no click id, so paid traffic still gets its own.
    const shared = await findShareableLease(snapshot);
    if (shared) return numberResponse(shared.phoneNumber);

    const leased = await leaseNumber(snapshot, sid, vid);
    if (leased) return numberResponse(leased.phoneNumber);

    // Website pool exhausted — fall back to a static number (still tracked) and flag it.
    console.warn(`[dni] website pool exhausted — using static fallback`);
    const fallback = await getFallbackNumber();
    if (fallback) return numberResponse(fallback.phoneNumber);

    return Response.json({ number: null }, { headers: CORS });
  } catch (err) {
    console.error("[dni/assign] error", err);
    return Response.json({ number: null }, { headers: CORS });
  }
}

function numberResponse(phone: string) {
  return Response.json({ number: phone, display: formatPhoneDisplay(phone) }, { headers: CORS });
}
