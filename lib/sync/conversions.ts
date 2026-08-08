import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, conversionExports, facebookLeads, hcpEstimates, leads, numberAssignments } from "@/lib/db/schema";
import { getPlatformCreds } from "@/lib/credentials";
import { googleAds, type ClickConversionInput } from "@/lib/integrations/google-ads";
import { facebook, type CapiEvent } from "@/lib/integrations/facebook";
import { hashEmail, hashPhone } from "@/lib/conversions/hash";
import { withSyncRun } from "./run";

/**
 * conversions.export — closed-loop feedback. Finds qualified/won leads that came
 * from a paid click (gclid → Google Ads, fbclid → Meta) OR a Meta lead-gen form
 * (leadgen_id → Meta CAPI "Conversion Leads" matching — form leads never have a
 * click id) and reports the conversion (with its dollar value) back to the ad
 * platform so bidding can optimize toward won revenue. Organic/GBP leads have
 * neither identifier and are correctly never uploaded. Idempotent via
 * `conversion_exports` (unique per lead+platform+event); a row only reaches
 * 'sent' once, so retries never double-count.
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
 *   won       — an estimate option was approved.
 * A single customer legitimately produces all three. Whether that triple-counts
 * is a Google-side decision (which actions are primary), not ours — we report
 * each stage once and let the account decide what bids on it.
 */
type EventKind = "lead" | "qualified" | "won";

interface Task {
  leadId: string;
  platform: "google" | "facebook";
  event: EventKind;
  valueCents: number;
  identifier: string;
  identifierType: "gclid" | "gbraid" | "wbraid" | "fbclid" | "leadgen_id";
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
      won: googleReady ? g.conversion_action_won || undefined : undefined,
    };
    const googleOn = !!(googleAction.lead || googleAction.qualified || googleAction.won);

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
        quoteValueCents: leads.quoteValueCents,
        salesValueCents: leads.salesValueCents,
        occurredAt: leads.occurredAt,
        estimateCreatedAt: hcpEstimates.createdAtHcp,
        estimateApprovedAt: hcpEstimates.approvedAtHcp,
      })
      .from(leads)
      .leftJoin(facebookLeads, eq(facebookLeads.leadId, leads.id))
      .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
      .leftJoin(calls, eq(calls.leadId, leads.id))
      .leftJoin(numberAssignments, eq(numberAssignments.id, calls.numberAssignmentId))
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
        ),
      )
      // Deterministic under LIMIT: keep the newest candidates, not planner order.
      .orderBy(desc(leads.occurredAt))
      .limit(limit);

    // ── Expand to (platform, event) tasks ─────────────────────────────────────
    const tasks: Task[] = [];
    const seenTask = new Set<string>(); // the calls join can repeat a lead
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
      if (googleOn && gId) {
        for (const e of events) {
          if (!googleAction[e.event]) continue; // that action not configured → skip event
          push({ ...base, platform: "google", ...e, ...gId });
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

    if (!tasks.length) return { candidates: rows.length, sent: 0, failed: 0, note: "no exportable click-ids" };

    // ── Skip anything already 'sent'; reserve a pending row for the rest ──────
    const leadIds = [...new Set(tasks.map((t) => t.leadId))];
    const existing = await db
      .select({ leadId: conversionExports.leadId, platform: conversionExports.platform, event: conversionExports.event, status: conversionExports.status })
      .from(conversionExports)
      .where(inArray(conversionExports.leadId, leadIds));
    const sentKeys = new Set(existing.filter((e) => e.status === "sent").map((e) => key(e.leadId, e.platform, e.event)));
    const todo = tasks.filter((t) => !sentKeys.has(key(t.leadId, t.platform, t.event)));
    if (!todo.length) return { candidates: rows.length, sent: 0, failed: 0, note: "all already exported" };

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
        const inputs: ClickConversionInput[] = googleTasks.map((t) => ({
          [t.identifierType]: t.identifier, // gclid | gbraid | wbraid
          conversionAction: googleAction[t.event]!,
          conversionDateTime: googleDateTime(t.convertedAt),
          valueDollars: t.valueCents / 100,
        }));
        const results = await googleAds.uploadClickConversions(inputs);
        for (let i = 0; i < googleTasks.length; i++) {
          const r = results[i] ?? { ok: false, error: "no result" };
          await markExport(googleTasks[i], r.ok ? "sent" : "error", r);
          r.ok ? sent++ : failed++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const t of googleTasks) await markExport(t, "error", { ok: false, error: msg });
        failed += googleTasks.length;
      }
    }

    // ── Meta: batch (event_id dedups server-side, so batch ok/error is safe) ──
    const fbTasks = todo.filter((t) => t.platform === "facebook");
    if (fbTasks.length) {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const events: CapiEvent[] = fbTasks.map((t) => {
          const convSec = Math.floor(t.convertedAt.getTime() / 1000);
          return {
            eventName: t.event === "won" ? "Purchase" : "Lead",
            // CAPI rejects the WHOLE batch if any event_time is >7 days old, so a
            // late-approved estimate is reported as recent rather than dropped.
            // Attribution is unaffected: Meta ties the event to the original lead
            // via `lead_id`/`fbc`, not to event_time.
            eventTime: Math.min(nowSec, Math.max(convSec, nowSec - 6 * 86_400)),
            actionSource: t.leadType === "call" ? "phone_call" : t.leadType === "web_form" ? "website" : "system_generated",
            eventId: `${t.leadId}:${t.event}`,
            emailHash: hashEmail(t.emailLc),
            phoneHash: hashPhone(t.phoneE164),
            fbc: t.identifierType === "fbclid" ? `fb.1.${t.occurredAt.getTime()}.${t.identifier}` : undefined,
            leadgenId: t.identifierType === "leadgen_id" ? t.identifier : undefined,
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

    return { candidates: rows.length, attempted: todo.length, sent, failed, google: googleTasks.length, facebook: fbTasks.length };
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

/** Google Ads conversion_date_time format: "yyyy-MM-dd HH:mm:ss+00:00" (UTC). */
function googleDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}
