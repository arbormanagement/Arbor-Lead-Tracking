import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { formSubmissions, leads, sources, visitors, webSessions } from "@/lib/db/schema";
import { classifySource } from "@/lib/attribution/classify";
import { isAllowedOrigin } from "@/lib/origin";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * First-party web/form tracking ingest. `track.js` (served cross-origin from
 * arbor-mgmt.com) generates `arbor_vid`/`arbor_sid` client-side and posts events
 * here. This route is stateless re: cookies — it keys off the client-provided IDs,
 * so there's no third-party-cookie dependency.
 *
 * Events: `pageview` (upsert visitor + session) and `form_submit` (also create a
 * web_form lead). Bodies arrive as text/plain (to dodge CORS preflight) so we read
 * raw text and JSON.parse.
 */
const Body = z.object({
  event: z.enum(["pageview", "form_submit"]),
  vid: z.string().min(1).max(64),
  sid: z.string().min(1).max(64),
  url: z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  ga: z.string().max(128).optional(),
  utm: z
    .object({
      source: z.string().max(256).optional(),
      medium: z.string().max(256).optional(),
      campaign: z.string().max(256).optional(),
      term: z.string().max(256).optional(),
      content: z.string().max(256).optional(),
    })
    .partial()
    .optional(),
  click: z
    .object({
      gclid: z.string().max(512).optional(),
      gbraid: z.string().max(512).optional(),
      wbraid: z.string().max(512).optional(),
      fbclid: z.string().max(512).optional(),
      msclkid: z.string().max(512).optional(),
    })
    .partial()
    .optional(),
  form: z
    .object({
      formId: z.string().max(256).optional(),
      pageUrl: z.string().max(2048).optional(),
      fields: z.record(z.string(), z.string()).default({}),
    })
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
  // every IP gets a budget (pageviews are chatty; form submits are not).
  if (!isAllowedOrigin(req)) {
    return Response.json({ error: "origin not allowed" }, { status: 403, headers: CORS });
  }
  const ip = clientIp(req);
  const rl = rateLimit(`track:${ip}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let parsed;
  try {
    parsed = Body.parse(JSON.parse(await req.text()));
  } catch {
    return Response.json({ error: "invalid payload" }, { status: 400, headers: CORS });
  }

  // Tighter budget for the event that mints leads.
  if (parsed.event === "form_submit") {
    const frl = rateLimit(`track-form:${ip}`, 5, 60_000);
    if (!frl.ok) return tooManyRequests(frl.retryAfterSec);
  }

  // Cap the form-fields blob we store verbatim in form_submissions.fields:
  // bounded key count, bounded value length, hard ceiling on the serialized size.
  if (parsed.form) {
    const fields = parsed.form.fields;
    const keys = Object.keys(fields);
    if (keys.length > 50) {
      return Response.json({ error: "too many fields" }, { status: 413, headers: CORS });
    }
    for (const k of keys) fields[k] = fields[k]!.slice(0, 1000);
    if (JSON.stringify(fields).length > 32_768) {
      return Response.json({ error: "fields too large" }, { status: 413, headers: CORS });
    }
  }

  const { vid, sid, url, referrer, ga, utm = {}, click = {}, form } = parsed;

  const cls = classifySource({
    gclid: click.gclid,
    gbraid: click.gbraid,
    wbraid: click.wbraid,
    fbclid: click.fbclid,
    utmSource: utm.source,
    utmMedium: utm.medium,
    referrer,
  });
  const sourceId = await getOrCreateSource(cls.sourceKey);
  // classify lowercases its output; normalize raw UTM the same way so "CPC" and
  // "cpc" don't split dashboard groupings.
  const medium = utm.medium?.toLowerCase() ?? cls.medium;
  const location = inferLocation(form?.pageUrl ?? url);
  const now = new Date();

  // 1) Visitor — first-touch frozen on insert; only last_seen/ga bump on conflict.
  await db
    .insert(visitors)
    .values({
      id: vid,
      gaClientId: ga,
      ftSource: cls.sourceKey,
      ftMedium: medium,
      ftCampaign: utm.campaign,
      ftContent: utm.content,
      ftTerm: utm.term,
      ftGclid: click.gclid,
      ftFbclid: click.fbclid,
      ftReferrer: referrer,
      ftLandingPage: url,
      ftAt: now,
    })
    .onConflictDoUpdate({
      target: visitors.id,
      set: { lastSeenAt: now, ...(ga ? { gaClientId: ga } : {}) },
    });

  // 2) Session — last-touch frozen on insert; activity bump on conflict.
  await db
    .insert(webSessions)
    .values({
      id: sid,
      visitorId: vid,
      source: cls.sourceKey,
      medium,
      campaign: utm.campaign,
      content: utm.content,
      term: utm.term,
      gclid: click.gclid,
      gbraid: click.gbraid,
      wbraid: click.wbraid,
      fbclid: click.fbclid,
      msclkid: click.msclkid,
      referrer,
      landingPage: url,
      location,
      derivedSourceId: sourceId,
    })
    .onConflictDoUpdate({ target: webSessions.id, set: { lastActivityAt: now } });

  // 3) Form submission → web_form lead.
  if (parsed.event === "form_submit" && form) {
    const c = mapFormFields(form.fields);
    const [lead] = await db
      .insert(leads)
      .values({
        type: "web_form",
        status: "new",
        isLead: true, // a submitted web form is inherently a lead
        name: c.name,
        phoneE164: normalizePhone(c.phone),
        emailLc: normalizeEmail(c.email),
        message: c.message,
        sourceId,
        medium,
        gclid: click.gclid,
        gbraid: click.gbraid,
        wbraid: click.wbraid,
        fbclid: click.fbclid,
        landingPage: form.pageUrl ?? url,
        referrer,
        location,
        visitorId: vid,
        webSessionId: sid,
        occurredAt: now,
      })
      .returning({ id: leads.id });

    await db.insert(formSubmissions).values({
      leadId: lead.id,
      webSessionId: sid,
      formId: form.formId,
      pageUrl: form.pageUrl ?? url,
      fields: form.fields,
      submittedAt: now,
    });
  }

  return Response.json({ ok: true }, { headers: CORS });
}

/** 429 with Retry-After — CORS headers included so the browser sees it cleanly. */
function tooManyRequests(retryAfterSec: number) {
  return Response.json(
    { error: "rate limited" },
    { status: 429, headers: { ...CORS, "Retry-After": String(retryAfterSec) } },
  );
}

/** Upsert a source row by key so every lead/session rolls up to a named source. */
async function getOrCreateSource(key: string): Promise<string | null> {
  if (!key) return null;
  await db.insert(sources).values({ key, displayName: key }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}

function inferLocation(url?: string): "edwardsville" | "ofallon" | "unknown" {
  const u = (url ?? "").toLowerCase();
  if (u.includes("edwardsville")) return "edwardsville";
  if (u.includes("ofallon") || u.includes("o-fallon") || u.includes("o'fallon")) return "ofallon";
  return "unknown";
}

function mapFormFields(fields: Record<string, string>) {
  const entries = Object.entries(fields);
  const find = (needles: string[]) => {
    for (const [k, v] of entries) {
      const lk = k.toLowerCase();
      if (v && needles.some((n) => lk.includes(n))) return String(v).slice(0, 1000);
    }
    return null;
  };
  // Prefer an explicit name; otherwise stitch first + last.
  const first = find(["first", "fname"]);
  const last = find(["last", "lname"]);
  const stitched = [first, last].filter(Boolean).join(" ") || null;
  const name = find(["fullname", "your-name", "name"]) ?? stitched;
  return {
    name,
    email: find(["email", "e-mail"]),
    phone: find(["phone", "tel", "mobile", "number"]),
    message: find(["message", "comment", "detail", "description", "note", "project"]),
  };
}
