import { z } from "zod";
import { classifySource } from "@/lib/attribution/classify";
import { formatPhoneDisplay } from "@/lib/phone";
import {
  getActiveAssignmentForSession,
  getFallbackNumber,
  leaseNumber,
  releaseExpired,
} from "@/lib/dni/assign";

export const runtime = "nodejs";

/**
 * Pool-based DNI: lease a per-session tracking number for the visitor's source so
 * `track.js` can swap the displayed phone number. Cookieless (keys off the
 * client-provided session id), CORS-open for the cross-origin call from the site.
 *
 * Order: reap expired leases → reuse this session's existing number → lease from
 * the single shared website pool → static fallback. The visitor's source is frozen
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
    });
    const snapshot = {
      source: cls.sourceKey,
      medium: utm.medium ?? cls.medium,
      campaign: utm.campaign,
      keyword: utm.term,
      gclid: click.gclid,
      gbraid: click.gbraid,
      wbraid: click.wbraid,
      fbclid: click.fbclid,
      landingPage: url,
    };

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
