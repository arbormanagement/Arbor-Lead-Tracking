import { displayNameFor } from "@/lib/sources/naming";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { formSubmissions, leads, sources, visitors, webSessions } from "@/lib/db/schema";
import { classifySource } from "@/lib/attribution/classify";
import { resolveCampaignId } from "@/lib/campaigns";
import { normalizeSelfReported } from "@/lib/leads/self-reported";
import { isAllowedOrigin } from "@/lib/origin";
import { preview, recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { findOpenLead } from "@/lib/leads/open";

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
    utmCampaign: utm.campaign,
    referrer,
    currentUrl: form?.pageUrl ?? url,
  });
  const sourceId = await getOrCreateSource(cls.sourceKey);
  // classify lowercases its output; normalize raw UTM the same way so "CPC" and
  // "cpc" don't split dashboard groupings.
  const medium = utm.medium?.toLowerCase() ?? cls.medium;
  // Recorded, never acted on here. /api/dni/assign refuses a crawler a pool number, but
  // nothing was storing what asked — so 'are bots draining the pool?' was unanswerable
  // both before and after that gate. The column already existed; it was simply never written.
  const userAgent = req.headers.get("user-agent");
  const now = new Date();

  // 1) Visitor — identity only; last_seen/ga bump on conflict. First touch is NOT
  //    snapshotted here: it derives from the contact's earliest lead in
  //    `runAttribution` (the `ft_*` columns that used to live here were never read).
  await db
    .insert(visitors)
    .values({
      id: vid,
      gaClientId: ga,
      userAgent,
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
      userAgent,
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
      lastPage: url,
      derivedSourceId: sourceId,
    })
    .onConflictDoUpdate({
      target: webSessions.id,
      set: {
        lastActivityAt: now,
        // Unlike everything below this, `lastPage` is a plain overwrite — that is
        // the whole point of it. `landingPage` stays absent from this set clause
        // and so stays frozen at the entry page.
        lastPage: sql`excluded.last_page`,
        // Backfill, never overwrite. /api/dni/assign seeds a session row to satisfy
        // the lease's FKs but cannot populate these (it has no source resolution and
        // no page context), and it frequently wins the race against this beacon — so
        // without a backfill those sessions keep `derived_source_id` NULL forever and
        // drop out of every surface that groups sessions by source. COALESCE keeps
        // the session's original last-touch frozen where it already exists.
        derivedSourceId: sql`coalesce(${webSessions.derivedSourceId}, excluded.derived_source_id)`,
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
        campaign: webSessions.campaign,
        term: webSessions.term,
      })
      .from(webSessions)
      .where(eq(webSessions.id, sid))
      .limit(1);

    const leadSourceId = sess?.derivedSourceId ?? sourceId;
    // The session has carried `utm_campaign` since the visit began, and this path
    // never read it — so a form fill from a tagged ad click was filed with the
    // right source and no campaign at all, and every campaign-level figure
    // under-counted by however much of its volume converts on a form rather than a
    // call. Same lookup the voice path uses, so the two agree.
    const leadCampaignId = await resolveCampaignId({ name: sess?.campaign, url: sess?.landingPage });

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

    // Thread it into the sender's conversation. A form carrying BOTH a phone and
    // an email is the event that stitches those two identities together, so a
    // later call from that number lands in the same thread. Best-effort — the
    // lead is what matters and must be recorded even if threading fails.
    let thread: Awaited<ReturnType<typeof upsertThread>> = null;
    try {
      thread = await upsertThread(
        { phone: c.phone, email: c.email, name: c.name, at: now },
        { endpointKey: form.formId ?? "web-form", sourceId },
      );
    } catch (err) {
      console.error("[track] threading failed (form still recorded)", err);
    }

    // One open enquiry per person. The dedupe key above catches a literal re-post;
    // it cannot catch a resubmission with a changed field, which is how one visitor
    // became two leads eighteen seconds apart. This is the same rule texts follow —
    // join the lead already in flight rather than minting a second — and it also
    // covers the cross-channel case, where a Meta lead form is followed a minute
    // later by the website form. The SUBMISSION is still recorded either way.
    const openLeadId = await findOpenLead(thread?.conversationId);

    const [lead] = openLeadId
      ? []
      : await db
      .insert(leads)
      .values({
        externalId: dedupeKey,
        type: "web_form",
        disposition: "requested_work", // you do not fill in the quote form by accident
        name: c.name,
        phoneE164: normalizePhone(c.phone),
        emailLc: normalizeEmail(c.email),
        message: c.message,
        // Parsed from the form's "how did you hear about us" field since 2026-08 and,
        // until 2026-09-05, never written to the lead — only Meta forms carried it.
        selfReportedSource: c.selfReportedSource,
        selfReportedChannel: normalizeSelfReported(c.selfReportedSource),
        conversationId: thread?.conversationId ?? null,
        contactId: thread?.contactId ?? null,
        sourceId: leadSourceId,
        campaignId: leadCampaignId,
        keyword: sess?.term ?? null,
        medium: sess?.medium ?? medium,
        gclid: click.gclid ?? sess?.gclid,
        gbraid: click.gbraid ?? sess?.gbraid,
        wbraid: click.wbraid ?? sess?.wbraid,
        fbclid: click.fbclid ?? sess?.fbclid,
        // The page the form was on is the useful landing page for the lead itself;
        // the session's own landing page is kept on the session row.
        landingPage: form.pageUrl ?? url,
        // Same value, under the name that means it. Form leads have always
        // recorded the page of the form here, so they were already attributed to
        // where the visitor converted — it is call leads, five times the volume,
        // that carry the session's ENTRY page instead. Setting both explicitly
        // gives `conversionPage` one meaning across every lead type without
        // moving a single existing number.
        conversionPage: form.pageUrl ?? url,
        referrer: referrer ?? sess?.referrer,
        visitorId: vid,
        webSessionId: sid,
        occurredAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });

    // Recorded against whichever lead this belongs to — the one just created, or
    // the one already open. A lost dedupe race yields neither, and that is correct:
    // the submission row already exists, so writing a second would leave one lead
    // with two and re-announce the same form in the thread.
    const leadId = lead?.id ?? openLeadId;
    if (leadId) {
      await db.insert(formSubmissions).values({
        leadId,
        conversationId: thread?.conversationId ?? null,
        webSessionId: sid,
        formId: form.formId,
        pageUrl: form.pageUrl ?? url,
        // Redacted, not raw. The snippet strips password INPUTS, but that is a
        // client-side check on input.type only: hidden CSRF tokens, and card or
        // SSN digits typed into an ordinary text box, still arrive here and would
        // be stored verbatim in jsonb forever. Contact details the app exists to
        // capture (name/email/phone) are unaffected — they are read from the lead
        // columns above, not from this blob.
        fields: redactSensitiveFields(form.fields),
        submittedAt: now,
      });

      if (thread) {
        try {
          await recordThreadActivity(thread.conversationId, {
            channel: "form",
            direction: "inbound",
            preview: preview(c.message) ?? `Form submitted${form.formId ? ` · ${form.formId}` : ""}`,
            occurredAt: now,
          });
        } catch (err) {
          console.error("[track] thread activity failed (form still recorded)", err);
        }
      }
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
  await db.insert(sources).values({ key, displayName: displayNameFor(key) }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}

/*
 * `inferLocation` lived here and is deliberately gone.
 *
 * It decided a contact's BRANCH by string-matching "edwardsville" / "ofallon" in the
 * utm_campaign OR THE PAGE URL. The campaign half was right but redundant — the two
 * Google Business Profiles already arrive as their own campaigns, and since #137 a
 * call to a profile's tracking number gets that campaign too, so the branch is
 * carried by `campaign` on every path. The URL half was simply wrong: reading
 * /locations/edwardsville-tree-services is a page view, not a branch touch, and it
 * recorded paid traffic as Google Business Profile traffic. Four Google Ads estimates
 * carried a branch that way.
 *
 * Branch reporting now derives from the campaign (see `branchExpr` in
 * lib/queries/sources.ts). Nothing should write a branch onto a session again.
 */


/** Field names that should never be stored, whatever their value. */
const SENSITIVE_NAME =
  /pass(word|wd)?|\bpwd\b|secret|token|csrf|nonce|authenticity|api[-_]?key|cvv|cvc|ssn|social.?security|routing|account.?number|card.?number|\bcc\b/i;
/** Value shapes worth redacting even under an innocuous field name. */
const CARD_LIKE = /\b(?:\d[ -]*?){13,19}\b/;
const SSN_LIKE = /\b\d{3}-\d{2}-\d{4}\b/;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function redactSensitiveFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_NAME.test(k)) {
      out[k] = "[redacted]";
      continue;
    }
    if (SSN_LIKE.test(v)) {
      out[k] = "[redacted]";
      continue;
    }
    // Luhn-check before redacting a long digit run, so a phone number or a
    // job-reference number isn't mistaken for a card.
    const m = v.match(CARD_LIKE);
    const digits = m?.[0].replace(/\D/g, "") ?? "";
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = v;
  }
  return out;
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
    // "How did you hear about us?" — the only signal that ever sees the channels
    // number-tracking cannot: word of mouth, a neighbour's recommendation, a yard
    // sign, a truck. Roughly 41% of estimate customers reach us with no trackable
    // touch at all, and no amount of attribution engineering will change that; the
    // question is the instrument for it.
    //
    // Until now the field was only ever filled from CALL TRANSCRIPTS, so a form
    // could carry the answer and the app would drop it. Reading it here costs
    // nothing and means the moment the website adds the question, the data starts
    // arriving — rather than needing a code change nobody remembers to make.
    //
    // Needles are specific on purpose: a bare "source" would match hidden UTM
    // fields that forms commonly post, filing an ad's own tag as the customer's
    // own words — which is worse than having nothing, because it looks like
    // first-party truth.
    selfReportedSource: find([
      "howdidyouhearaboutus",
      "howdidyouhear",
      "howdidyoufindus",
      "howheardaboutus",
      "hearaboutus",
      "heardaboutus",
      "howfoundus",
      "referralsource",
      "referredby",
    ]),
  };
}
