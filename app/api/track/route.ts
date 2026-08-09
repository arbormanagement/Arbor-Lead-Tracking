import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
  if (!(await isAllowedOrigin(req))) {
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
    currentUrl: form?.pageUrl ?? url,
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
    .onConflictDoUpdate({
      target: webSessions.id,
      set: {
        lastActivityAt: now,
        // Backfill, never overwrite. /api/dni/assign seeds a session row to satisfy
        // the lease's FKs but cannot populate these (it has no source resolution and
        // no page context), and it frequently wins the race against this beacon — so
        // without a backfill those sessions keep `derived_source_id` NULL forever and
        // drop out of every surface that groups sessions by source. COALESCE keeps
        // the session's original last-touch frozen where it already exists.
        derivedSourceId: sql`coalesce(${webSessions.derivedSourceId}, excluded.derived_source_id)`,
        location: sql`coalesce(${webSessions.location}, excluded.location)`,
        content: sql`coalesce(${webSessions.content}, excluded.content)`,
        msclkid: sql`coalesce(${webSessions.msclkid}, excluded.msclkid)`,
      },
    });

  // 3) Form submission → web_form lead.
  if (parsed.event === "form_submit" && form) {
    const c = mapFormFields(form.fields);

    // Attribute from the SESSION, falling back to this event. The submit event
    // carries only what is on the URL at submit time, so on any hard navigation
    // (or a direct entry to an inner page) it has no click ids and an own-domain
    // referrer — a Google Ads lead would be filed as direct/self-referral with a
    // null gclid, breaking both ROI and the offline-conversion upload, while the
    // real values sit on the session row one read away. The session holds the
    // attribution frozen when the visit began, which is exactly last-touch.
    const [sess] = await db
      .select({
        gclid: webSessions.gclid,
        gbraid: webSessions.gbraid,
        wbraid: webSessions.wbraid,
        fbclid: webSessions.fbclid,
        medium: webSessions.medium,
        derivedSourceId: webSessions.derivedSourceId,
        referrer: webSessions.referrer,
        landingPage: webSessions.landingPage,
      })
      .from(webSessions)
      .where(eq(webSessions.id, sid))
      .limit(1);

    const leadSourceId = sess?.derivedSourceId ?? sourceId;

    // Idempotency key for the submission. The browser posts once and does not
    // retry, but a double-clicked submit button fires two `submit` events, and a
    // keepalive beacon can be re-sent by the browser after a connection reset —
    // each of which minted a second identical lead. Keying on the session + form +
    // exact field values (sorted, so key order can't vary the hash) collapses
    // those; an identical submission from the same session is the same inquiry
    // either way. Enforced by leads_type_external_id_uq, so concurrent duplicates
    // lose the insert rather than racing the check.
    const dedupeKey = createHash("sha256")
      .update(
        JSON.stringify([
          sid,
          form.formId ?? "",
          Object.entries(form.fields).sort(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest("hex")
      .slice(0, 32);

    const [lead] = await db
      .insert(leads)
      .values({
        externalId: dedupeKey,
        type: "web_form",
        status: "new",
        isLead: true, // a submitted web form is inherently a lead
        name: c.name,
        phoneE164: normalizePhone(c.phone),
        emailLc: normalizeEmail(c.email),
        message: c.message,
        sourceId: leadSourceId,
        medium: sess?.medium ?? medium,
        gclid: click.gclid ?? sess?.gclid,
        gbraid: click.gbraid ?? sess?.gbraid,
        wbraid: click.wbraid ?? sess?.wbraid,
        fbclid: click.fbclid ?? sess?.fbclid,
        // The page the form was on is the useful landing page for the lead itself;
        // the session's own landing page is kept on the session row.
        landingPage: form.pageUrl ?? url,
        referrer: referrer ?? sess?.referrer,
        location,
        visitorId: vid,
        webSessionId: sid,
        occurredAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });

    // Lost the dedupe race (or a genuine re-post): the lead and its submission row
    // already exist, so adding another form_submissions row would leave the
    // original lead with two.
    if (lead) {
      await db.insert(formSubmissions).values({
        leadId: lead.id,
        webSessionId: sid,
        formId: form.formId,
        pageUrl: form.pageUrl ?? url,
        fields: form.fields,
        submittedAt: now,
      });
    }
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
  /**
   * First field whose name matches a needle. Matching is exact-or-boundary rather
   * than bare substring, and it is first-match-wins over an arbitrary key order:
   * a plain `includes("number")` lets `number_of_trees` win the phone slot ahead of
   * `phone`, and `normalizePhone("5")` then returns null, so the lead loses the
   * phone that lead↔HCP matching (and therefore all revenue attribution) depends
   * on. `last` behaved the same way against `last_service_date`.
   */
  /** Exact (or separator-stripped exact) only — for needles too generic to be
   *  matched loosely. `number` is the motivating case: as a whole field name it
   *  means a phone number, but as a fragment it matches `number_of_trees`. */
  const findExact = (needles: string[]) => {
    for (const n of needles) {
      for (const [k, v] of entries) {
        const lk = k.toLowerCase();
        if (v && (lk === n || lk.replace(/[^a-z0-9]/g, "") === n)) return String(v).slice(0, 1000);
      }
    }
    return null;
  };
  const find = (needles: string[]) => {
    const matches = (key: string, n: string) => {
      if (key === n) return true;
      // An exact match once separators are stripped, so `last_name` / `last-name`
      // / `lastName` all satisfy the needle `lastname` while `last_service_date`
      // does not.
      const flat = key.replace(/[^a-z0-9]/g, "");
      if (flat === n || flat === `${n}s`) return true;
      // Otherwise the needle must sit at a word edge, never mid-token. A trailing
      // plural is allowed so `comments`/`details`/`notes` match too.
      return new RegExp(`(^|[^a-z0-9])${n}s?([^a-z0-9]|$)`).test(key);
    };
    // Needle-major: a needle earlier in the list beats an arbitrary field order,
    // so the specific names are consumed before the loose ones.
    for (const n of needles) {
      for (const [k, v] of entries) {
        if (v && matches(k.toLowerCase(), n)) return String(v).slice(0, 1000);
      }
    }
    return null;
  };
  // Split first/last wins when BOTH halves are present — otherwise the generic
  // "name" needle matches `last_name` itself and the lead is filed under a surname
  // with the given name dropped. Fall back to an explicit full-name field.
  const first = find(["firstname", "first", "fname"]);
  const last = find(["lastname", "last", "lname"]);
  const stitched = [first, last].filter(Boolean).join(" ") || null;
  const name = (first && last ? stitched : null) ?? find(["fullname", "your-name", "name"]) ?? stitched;
  return {
    name,
    email: find(["email", "e-mail"]),
    // "number" only as a whole field name, and only after the unambiguous ones:
    // loose-matching it steals the phone slot from fields like `number_of_trees`,
    // and the resulting non-phone fails normalizePhone — leaving the lead with no
    // phone at all, which is what lead↔HCP revenue matching keys on.
    phone: find(["phone", "tel", "telephone", "mobile", "cell"]) ?? findExact(["number", "contactnumber"]),
    message: find(["message", "comment", "details", "detail", "description", "note", "project"]),
  };
}
