import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, conversionExports, facebookLeads, hcpEstimates, leads, numberAssignments, sources } from "@/lib/db/schema";
import { getPlatformCreds } from "@/lib/credentials";
import { ingestEvents, type EventSource, type IngestEvent } from "@/lib/integrations/data-manager";
import { facebook, type CapiEvent } from "@/lib/integrations/facebook";
import { hashEmail, hashPhone } from "@/lib/conversions/hash";
import { withSyncRun } from "./run";

/** Stop retrying an export after this many failed attempts. Matches the
 *  poison-pill guard the transcription backlog already uses. */
export const MAX_EXPORT_ATTEMPTS = 5;

/**
 * conversions.export — closed-loop feedback. Finds qualified/won leads that came
 * from a paid click (gclid → Google Ads, fbclid → Meta) OR a Meta lead-gen form
 * (leadgen_id → Meta CAPI "Conversion Leads" matching — form leads never have a
 * click id) OR a Google source where a missing click id is expected rather than
 * disqualifying (hashed email/phone → Google; see USER_DATA_FALLBACK_SOURCES) and
 * reports the conversion (with its dollar value) back to the ad platform so
 * bidding can optimize toward won revenue. Organic/GBP/direct leads still match
 * none of those and are correctly never uploaded. Idempotent via
 * `conversion_exports` (unique per lead+platform+event); a row only reaches
 * 'sent' once, so retries never double-count. Google additionally dedups on
 * `transactionId` server-side, so even a replayed batch cannot double-count.
 *
 * Google goes through the DATA MANAGER API, not the Google Ads
 * ConversionUploadService — that endpoint is closed to new integrations and
 * rejected every upload this job ever made, on policy rather than on data. See
 * `lib/integrations/data-manager.ts`.
 *
 * Gated: each destination runs only when its credentials + targets are configured
 * (Google conversion-action ids, Meta pixel id) — so this no-ops until wired.
 */
/**
 * Three tiers, in the order they happen — and in the order Justin ranks them as
 * bidding signals (2026-08-08):
 *   lead      — a form submission or a phone call. Earliest and highest volume;
 *               this is what replaces CallRail's Form Capture + First Time Phone
 *               Call, which both died when swap.js was removed.
 *   qualified — the office wrote an estimate for that lead.
 *   scheduled — that estimate got a date on the calendar. Not the same as being
 *               written: ~29% of estimates never get one (cancelled, or still
 *               "needs scheduling"), so this is a genuine step, not a rename.
 *   won       — an estimate option was approved.
 * A single customer legitimately produces all three. Whether that triple-counts
 * is a Google-side decision (which actions are primary), not ours — we report
 * each stage once and let the account decide what bids on it.
 */
type EventKind = "lead" | "qualified" | "scheduled" | "won";

/**
 * Sources whose leads may export to Google on hashed user identifiers ALONE, with
 * no click id — Enhanced-Conversions-for-Leads style matching, which the Data
 * Manager API supports and the retired upload endpoint did not.
 *
 * This exists because "no click id ⇒ not from the ad" is false for exactly one
 * shape of traffic: a STATIC tracking number wired directly to a Google ad. A call
 * to `+16184145907` (the call-only / call-extension asset on campaign
 * 23633267649) can ONLY have come from a Google ad — but static numbers hold no
 * DNI lease (`resolveInboundAttribution` returns `lease: null`), so there is no
 * gclid to inherit and the click-id gate dropped every one of those ~24 calls a
 * month. Google counted them natively via its own "Calls from ads" action, but
 * that action is value-1-per-call, so the won-estimate dollars never arrived —
 * precisely the revenue signal this job exists to deliver.
 *
 * It also rescues paid web leads whose gclid was lost (ad blocker, stripped
 * referrer): same source, same reasoning.
 *
 * Deliberately NOT a blanket "any lead with a phone". Organic, GBP, direct and
 * referral leads have no click id because they genuinely did not come from an ad;
 * uploading them would invite Google to credit itself for traffic it never sent.
 *
 * `google/lsa` is deliberately absent. Local Services leads have the same static
 * number problem, but LSA bidding does not run through these conversion actions,
 * and a hashed phone can match a Search click by the same person — which would
 * credit Search for an LSA lead. Add it only as a deliberate decision.
 */
const USER_DATA_FALLBACK_SOURCES: ReadonlySet<string> = new Set(["google/cpc"]);

/** Stage -> Meta standard event. null = not reported to Meta at all. */
const META_EVENT: Record<EventKind, CapiEvent["eventName"] | null> = {
  lead: "Lead",
  qualified: null,
  scheduled: "Schedule",
  won: "Purchase",
};

interface Task {
  leadId: string;
  platform: "google" | "facebook";
  event: EventKind;
  valueCents: number;
  /** null only for `user_data`, where the hashed email/phone below IS the match key. */
  identifier: string | null;
  identifierType: "gclid" | "gbraid" | "wbraid" | "fbclid" | "leadgen_id" | "user_data";
  /** When the conversion happened (estimate created / approved), not when the lead came in. */
  convertedAt: Date;
  /** The original click/lead time — Meta needs it to build `fbc`. */
  occurredAt: Date;
  leadType: string;
  phoneE164: string | null;
  emailLc: string | null;
}

/**
 * `sinceDays` spans lead → outcome lag: HCP estimates are often approved weeks
 * after the lead arrives, and a lead that ages out of this window never exports.
 * 90 matches the conversion actions' click lookback (the outer bound on what
 * Google will still attribute).
 */
export async function syncConversions({ sinceDays = 90, limit = 500 }: { sinceDays?: number; limit?: number } = {}) {
  return withSyncRun("conversions.export", async () => {
    // ── Resolve which destinations are configured ────────────────────────────
    const g = await getPlatformCreds("google_ads");
    const googleReady = !!(g.refresh_token && g.developer_token && g.client_id && g.client_secret && g.customer_id);
    const googleAction: Record<EventKind, string | undefined> = {
      lead: googleReady ? g.conversion_action_lead || undefined : undefined,
      qualified: googleReady ? g.conversion_action_qualified || undefined : undefined,
      scheduled: googleReady ? g.conversion_action_scheduled || undefined : undefined,
      won: googleReady ? g.conversion_action_won || undefined : undefined,
    };
    const googleOn = !!(googleAction.lead || googleAction.qualified || googleAction.scheduled || googleAction.won);

    const fb = await getPlatformCreds("facebook");
    const facebookOn = !!fb.conversions_pixel_id && !!fb.access_token;

    if (!googleOn && !facebookOn) {
      return { skipped: "No conversion export destinations configured", sent: 0, failed: 0 };
    }

    // ── Candidate leads: qualified or won, not spam, recent ───────────────────
    const cutoff = new Date(Date.now() - sinceDays * 86_400_000);
    const rows = await db
      .select({
        id: leads.id,
        type: leads.type,
        status: leads.status,
        gclid: leads.gclid,
        gbraid: leads.gbraid,
        wbraid: leads.wbraid,
        fbclid: leads.fbclid,
        fbLeadgenId: facebookLeads.fbLeadgenId,
        // Pooled-DNI calls carry their click ids on the number lease, not the lead.
        naGclid: numberAssignments.gclid,
        naGbraid: numberAssignments.gbraid,
        naWbraid: numberAssignments.wbraid,
        naFbclid: numberAssignments.fbclid,
        phoneE164: leads.phoneE164,
        emailLc: leads.emailLc,
        // Gates the no-click-id fallback: only genuinely-paid sources qualify.
        sourceKey: sources.key,
        quoteValueCents: leads.quoteValueCents,
        salesValueCents: leads.salesValueCents,
        occurredAt: leads.occurredAt,
        estimateCreatedAt: hcpEstimates.createdAtHcp,
        estimateScheduledAt: hcpEstimates.scheduledStartHcp,
        estimateApprovedAt: hcpEstimates.approvedAtHcp,
      })
      .from(leads)
      .leftJoin(facebookLeads, eq(facebookLeads.leadId, leads.id))
      .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
      .leftJoin(calls, eq(calls.leadId, leads.id))
      .leftJoin(numberAssignments, eq(numberAssignments.id, calls.numberAssignmentId))
      .leftJoin(sources, eq(sources.id, leads.sourceId))
      .where(
        and(
          // Was qualified/quoted/won only, which made an estimate a precondition
          // for exporting ANYTHING. `new`/`working` are now in scope so the
          // lead-stage event can fire on the form submission or call itself.
          // Terminal non-outcomes stay out: a lost/cancelled/duplicate lead has
          // nothing useful to teach bidding.
          inArray(leads.status, ["new", "working", "qualified", "quoted", "won"]),
          eq(leads.isSpam, false),
          gte(leads.occurredAt, cutoff),
          // A call lead is only a lead once transcription has classified it, and
          // that is what also scores it for spam. Exporting on `isLead IS NULL`
          // raced the classifier: a call arriving shortly before this job ran was
          // uploaded as a "Lead" conversion and then flagged spam minutes later —
          // and a sent conversion cannot be retracted, so Google and Meta keep
          // optimizing toward junk calls. Non-call types are inherently leads.
          or(ne(leads.type, "call"), eq(leads.isLead, true)),
        ),
      )
      // Deterministic under LIMIT: keep the newest candidates, not planner order.
      .orderBy(desc(leads.occurredAt))
      .limit(limit);

    // ── Expand to (platform, event) tasks ─────────────────────────────────────
    const tasks: Task[] = [];
    const seenTask = new Set<string>(); // the calls join can repeat a lead
    // A repeat caller has several `calls` rows, so the join emits the lead more
    // than once and only SOME of those rows carry a pooled-DNI lease. `seenTask`
    // keeps whichever arrives first, and row order within a lead is not defined —
    // so deciding the fallback per row could publish a weaker `user_data` match
    // for a lead that has a real click id sitting on another row. Settle it across
    // all rows up front: a click id anywhere disqualifies the fallback everywhere.
    const leadsWithClickId = new Set(
      rows
        .filter((r) => r.gclid ?? r.naGclid ?? r.gbraid ?? r.naGbraid ?? r.wbraid ?? r.naWbraid)
        .map((r) => r.id),
    );
    for (const l of rows) {
      // Report the conversion at the time it actually happened — the estimate being
      // written (qualified) or approved (won) — falling back to the lead time. An
      // estimate approved weeks later would otherwise be reported at lead time.
      // The lead itself always converts at lead time and carries no value — its
      // worth to bidding is volume and recency, not a dollar figure.
      const events: Array<{ event: EventKind; valueCents: number; convertedAt: Date }> = [
        { event: "lead", valueCents: 0, convertedAt: l.occurredAt },
      ];
      // Only claim an estimate exists once one actually does. Status alone is not
      // enough to date it, so an estimate-less lead must not emit `qualified`.
      if (l.status !== "new" && l.status !== "working") {
        events.push({
          event: "qualified",
          valueCents: l.quoteValueCents ?? 0,
          convertedAt: l.estimateCreatedAt ?? l.occurredAt,
        });
        // Only when a date actually exists. Reporting it at estimate-creation time
        // would claim an appointment that may never have been booked.
        if (l.estimateScheduledAt) {
          events.push({
            event: "scheduled",
            valueCents: l.quoteValueCents ?? 0,
            convertedAt: l.estimateScheduledAt,
          });
        }
      }
      if (l.status === "won") {
        events.push({
          event: "won",
          valueCents: l.salesValueCents ?? 0,
          convertedAt: l.estimateApprovedAt ?? l.estimateCreatedAt ?? l.occurredAt,
        });
      }

      const base = {
        leadId: l.id,
        occurredAt: l.occurredAt,
        leadType: l.type,
        phoneE164: l.phoneE164,
        emailLc: l.emailLc,
      };
      const push = (t: Task) => {
        const k = key(t.leadId, t.platform, t.event);
        if (seenTask.has(k)) return;
        seenTask.add(k);
        tasks.push(t);
      };

      // Google: gclid, or the iOS/Safari click ids that replace it (gbraid on
      // app→web, wbraid on web→app). Pooled-DNI calls fall back to the lease.
      const gId: Pick<Task, "identifier" | "identifierType"> | null = clickId(
        [
          ["gclid", l.gclid ?? l.naGclid],
          ["gbraid", l.gbraid ?? l.naGbraid],
          ["wbraid", l.wbraid ?? l.naWbraid],
        ] as const,
      );
      // No click id, but the source is one where its absence does NOT mean the lead
      // came from somewhere else (see USER_DATA_FALLBACK_SOURCES). Match on hashed
      // email/phone instead — worthless without one, so require at least one.
      const gFallback: Pick<Task, "identifier" | "identifierType"> | null =
        !gId &&
        !leadsWithClickId.has(l.id) &&
        l.sourceKey &&
        USER_DATA_FALLBACK_SOURCES.has(l.sourceKey) &&
        (l.phoneE164 || l.emailLc)
          ? { identifier: null, identifierType: "user_data" }
          : null;
      const gMatch = gId ?? gFallback;
      if (googleOn && gMatch) {
        for (const e of events) {
          if (!googleAction[e.event]) continue; // that action not configured → skip event
          push({ ...base, platform: "google", ...e, ...gMatch });
        }
      }
      // Website-click leads match by fbclid; lead-form leads by Meta's leadgen id.
      const fbId: Pick<Task, "identifier" | "identifierType"> | null =
        clickId([["fbclid", l.fbclid ?? l.naFbclid]] as const) ??
        (l.fbLeadgenId ? { identifier: l.fbLeadgenId, identifierType: "leadgen_id" } : null);
      if (facebookOn && fbId) {
        for (const e of events) {
          push({ ...base, platform: "facebook", ...e, ...fbId });
        }
      }
    }

    if (!tasks.length) return { candidates: rows.length, sent: 0, failed: 0, note: "no exportable identifiers" };

    // ── Skip anything already 'sent'; reserve a pending row for the rest ──────
    const leadIds = [...new Set(tasks.map((t) => t.leadId))];
    const existing = await db
      .select({ leadId: conversionExports.leadId, platform: conversionExports.platform, event: conversionExports.event, status: conversionExports.status, attempts: conversionExports.attempts })
      .from(conversionExports)
      .where(inArray(conversionExports.leadId, leadIds));
    const sentKeys = new Set(existing.filter((e) => e.status === "sent").map((e) => key(e.leadId, e.platform, e.event)));
    // Give up on a row that has failed MAX_EXPORT_ATTEMPTS times. Retrying only
    // 'error' rows forever is not self-healing: a permanently-rejected click id
    // (expired click, malformed gclid) re-uploads on every run for the full 90-day
    // window — ~144 pointless API calls a day — and keeps `failed > 0` in every
    // sync_runs row, which buries genuinely new failures in constant noise.
    const exhausted = new Set(
      existing.filter((e) => e.attempts >= MAX_EXPORT_ATTEMPTS).map((e) => key(e.leadId, e.platform, e.event)),
    );
    const todo = tasks.filter(
      (t) => !sentKeys.has(key(t.leadId, t.platform, t.event)) && !exhausted.has(key(t.leadId, t.platform, t.event)),
    );
    // Giving up has to be REPORTED, not just logged. Once a row passes the cap it
    // leaves `todo`, so `failed` drops to 0 and the run looks clean — the export is
    // permanently un-uploaded and the only trace is a console line nobody reads.
    // Surface it in stats so /api/diagnostics can warn on it.
    if (exhausted.size) console.warn(`[conversions] ${exhausted.size} export(s) past ${MAX_EXPORT_ATTEMPTS} attempts — not retried`);
    if (!todo.length) {
      return {
        candidates: rows.length,
        sent: 0,
        failed: 0,
        abandoned: exhausted.size,
        note: exhausted.size
          ? `nothing left to try — ${exhausted.size} export(s) permanently abandoned after ${MAX_EXPORT_ATTEMPTS} attempts`
          : "all already exported",
      };
    }

    for (let i = 0; i < todo.length; i += 100) {
      await db
        .insert(conversionExports)
        .values(
          todo.slice(i, i + 100).map((t) => ({
            leadId: t.leadId,
            platform: t.platform,
            event: t.event,
            status: "pending" as const,
            valueCents: t.valueCents,
            identifier: t.identifier,
            identifierType: t.identifierType,
          })),
        )
        .onConflictDoNothing({ target: [conversionExports.leadId, conversionExports.platform, conversionExports.event] });
    }

    let sent = 0;
    let failed = 0;

    // ── Google: one request per conversion (clean per-item idempotency) ───────
    // Each platform is isolated in try/catch so a config/network failure on one
    // never fails the whole run (or the other platform's uploads).
    const googleTasks = todo.filter((t) => t.platform === "google");
    if (googleTasks.length) {
      try {
        const events: IngestEvent[] = googleTasks.map((t) => ({
          // Same key the export row is unique on, so a replay of an already-sent
          // conversion is discarded by Google rather than counted twice.
          transactionId: key(t.leadId, t.platform, t.event),
          conversionActionId: googleAction[t.event]!,
          // Never in the future. `scheduled` is dated from the estimate's
          // APPOINTMENT time, which is routinely days ahead — a conversion that
          // has not happened yet is a contradiction, and Google rejects the whole
          // batch for it. The booking itself already happened, so `now` is the
          // closest honest timestamp we have; HCP exposes the appointment date,
          // not the moment it was booked. (The Meta branch has always clamped for
          // the same reason, against a 7-day bound.)
          eventTimestamp: new Date(Math.min(t.convertedAt.getTime(), Date.now())),
          valueDollars: t.valueCents / 100,
          eventSource: eventSourceFor(t.leadType),
          // Spelled out rather than computed from identifierType: that field also
          // carries Meta's fbclid/leadgen_id, and a computed key would let one
          // through as an unknown property instead of failing here.
          gclid: t.identifierType === "gclid" ? t.identifier : null,
          gbraid: t.identifierType === "gbraid" ? t.identifier : null,
          wbraid: t.identifierType === "wbraid" ? t.identifier : null,
          // Sent ALONGSIDE the click id, which the old upload endpoint refused —
          // it rejected any conversion pairing a click id with user identifiers.
          // Google still matches on the click id first; these only widen it.
          // On a `user_data` task there is no click id and these ARE the match
          // key, which is why that task type requires at least one of them.
          emailLc: t.emailLc,
          phoneE164: t.phoneE164,
        }));
        const results = await ingestEvents(events);
        for (const t of googleTasks) {
          const r = results.get(key(t.leadId, t.platform, t.event)) ?? { ok: false, error: "no result" };
          await markExport(t, r.ok ? "sent" : "error", r);
          r.ok ? sent++ : failed++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const t of googleTasks) await markExport(t, "error", { ok: false, error: msg });
        failed += googleTasks.length;
      }
    }

    // ── Meta: batch (event_id dedups server-side, so batch ok/error is safe) ──
    // Meta gets a DISTINCT standard event per stage. Mapping several stages onto
    // "Lead" would triple-count: eventId is `${leadId}:${event}`, and Meta dedups
    // on (event_name, event_id) — so same name + different id = separate
    // conversions, not one. One caller reaching a scheduled estimate would post
    // three Leads. `qualified` has no honest Meta standard event (an internal
    // milestone, not a customer action) and is deliberately not sent; Meta's
    // funnel is Lead -> Schedule -> Purchase.
    const fbTasks = todo.filter((t) => t.platform === "facebook" && META_EVENT[t.event] !== null);

    if (fbTasks.length) {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const events: CapiEvent[] = fbTasks.map((t) => {
          const convSec = Math.floor(t.convertedAt.getTime() / 1000);
          return {
            eventName: META_EVENT[t.event]!, // non-null: fbTasks filtered these out
            // CAPI rejects the WHOLE batch if any event_time is >7 days old, so a
            // late-approved estimate is reported as recent rather than dropped.
            // Attribution is unaffected: Meta ties the event to the original lead
            // via `lead_id`/`fbc`, not to event_time.
            eventTime: Math.min(nowSec, Math.max(convSec, nowSec - 6 * 86_400)),
            actionSource: t.leadType === "call" ? "phone_call" : t.leadType === "web_form" ? "website" : "system_generated",
            eventId: `${t.leadId}:${t.event}`,
            emailHash: hashEmail(t.emailLc),
            phoneHash: hashPhone(t.phoneE164),
            // `identifier` is nullable only for Google's `user_data` tasks, which
            // never reach this branch — the `&&` / `??` keep that provable rather
            // than assumed, and stop a null ever stringifying into an `fb.1.…null`.
            fbc: t.identifierType === "fbclid" && t.identifier ? `fb.1.${t.occurredAt.getTime()}.${t.identifier}` : undefined,
            leadgenId: t.identifierType === "leadgen_id" ? (t.identifier ?? undefined) : undefined,
            valueDollars: t.valueCents / 100,
          };
        });
        const res = await facebook.sendConversions(events);
        for (const t of fbTasks) {
          await markExport(t, res.ok ? "sent" : "error", res);
          res.ok ? sent++ : failed++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const t of fbTasks) await markExport(t, "error", { ok: false, error: msg });
        failed += fbTasks.length;
      }
    }

    return { candidates: rows.length, attempted: todo.length, sent, failed, abandoned: exhausted.size, google: googleTasks.length, facebook: fbTasks.length };
  });
}

function key(leadId: string, platform: string, event: string): string {
  return `${leadId}:${platform}:${event}`;
}

/** First non-empty click id, in preference order. */
function clickId(
  candidates: ReadonlyArray<readonly [Task["identifierType"], string | null | undefined]>,
): Pick<Task, "identifier" | "identifierType"> | null {
  for (const [identifierType, identifier] of candidates) {
    if (identifier) return { identifier, identifierType };
  }
  return null;
}

async function markExport(t: Task, status: "sent" | "error", r: { ok: boolean; error?: string; raw?: unknown }) {
  await db
    .update(conversionExports)
    .set({
      status,
      attempts: sql`${conversionExports.attempts} + 1`,
      response: (r.raw ?? null) as object | null,
      error: r.ok ? null : (r.error ?? "unknown error"),
      sentAt: r.ok ? sql`now()` : sql`${conversionExports.sentAt}`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(conversionExports.leadId, t.leadId),
        eq(conversionExports.platform, t.platform),
        eq(conversionExports.event, t.event),
      ),
    );
}

/**
 * Lead type -> Data Manager `EventSource`. The legal values were established by
 * sweeping the enum against the live API: WEB, APP, IN_STORE, PHONE, OTHER.
 * PHONE_CALL, OFFLINE and CRM all read as plausible and are all rejected, so this
 * mapping is not a matter of taste — anything else fails the whole batch.
 */
function eventSourceFor(leadType: string): EventSource {
  if (leadType === "call" || leadType === "sms") return "PHONE";
  if (leadType === "web_form") return "WEB";
  return "OTHER";
}
