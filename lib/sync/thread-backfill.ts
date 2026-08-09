import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, facebookLeads, formSubmissions, leads, trackingNumbers } from "@/lib/db/schema";
import { preview, recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { withSyncRun } from "./run";

const BATCH = 500;

/**
 * File historical activity into contact threads.
 *
 * Two jobs in one, both idempotent:
 *  - the one-off backfill of everything captured before the inbox existed;
 *  - the ongoing repair path, because threading in the ingest routes is
 *    deliberately best-effort (it must never cost a call forward or a lead), so
 *    anything that failed there gets picked up on the next tick.
 *
 * Oldest-first, so each thread's `last_*` columns end up describing its most
 * recent activity rather than whichever row happened to be processed last.
 */
export async function backfillCallThreads({ limit = BATCH }: { limit?: number } = {}) {
  return withSyncRun("threads.backfill", async () => {
    const stats = { calls: 0, forms: 0, facebook: 0, leads: 0, failed: 0 };

    // ── Calls ────────────────────────────────────────────────────────────────
    const pendingCalls = await db
      .select({
        id: calls.id,
        leadId: calls.leadId,
        fromNumber: calls.fromNumber,
        createdAt: calls.createdAt,
        numberAssignmentId: calls.numberAssignmentId,
        endpoint: trackingNumbers.phoneNumber,
        trackingNumberId: trackingNumbers.id,
      })
      .from(calls)
      .innerJoin(trackingNumbers, eq(calls.trackingNumberId, trackingNumbers.id))
      .where(and(isNull(calls.conversationId), isNotNull(calls.fromNumber)))
      .orderBy(asc(calls.createdAt))
      .limit(limit);

    for (const call of pendingCalls) {
      try {
        const thread = await upsertThread(
          { phone: call.fromNumber, at: call.createdAt },
          {
            endpointKey: call.endpoint,
            trackingNumberId: call.trackingNumberId,
            numberAssignmentId: call.numberAssignmentId,
          },
        );
        if (!thread) continue;

        await db.update(calls).set({ conversationId: thread.conversationId }).where(eq(calls.id, call.id));
        if (call.leadId) {
          await db
            .update(leads)
            .set({ conversationId: thread.conversationId, contactId: thread.contactId })
            .where(eq(leads.id, call.leadId));
        }
        await recordThreadActivity(thread.conversationId, {
          channel: "call",
          direction: "inbound",
          preview: "Inbound call",
          occurredAt: call.createdAt,
          markUnread: false, // replaying history, not new work
        });
        stats.calls++;
      } catch (err) {
        stats.failed++;
        console.error("[thread-backfill] call failed", call.id, err);
      }
    }

    // ── Web forms ────────────────────────────────────────────────────────────
    const pendingForms = await db
      .select({
        id: formSubmissions.id,
        leadId: formSubmissions.leadId,
        formId: formSubmissions.formId,
        submittedAt: formSubmissions.submittedAt,
        name: leads.name,
        phone: leads.phoneE164,
        email: leads.emailLc,
        message: leads.message,
        sourceId: leads.sourceId,
      })
      .from(formSubmissions)
      .innerJoin(leads, eq(formSubmissions.leadId, leads.id))
      .where(isNull(formSubmissions.conversationId))
      .orderBy(asc(formSubmissions.submittedAt))
      .limit(limit);

    for (const form of pendingForms) {
      try {
        const thread = await upsertThread(
          { phone: form.phone, email: form.email, name: form.name, at: form.submittedAt },
          { endpointKey: form.formId ?? "web-form", sourceId: form.sourceId },
        );
        if (!thread) continue;

        await db
          .update(formSubmissions)
          .set({ conversationId: thread.conversationId })
          .where(eq(formSubmissions.id, form.id));
        if (form.leadId) {
          await db
            .update(leads)
            .set({ conversationId: thread.conversationId, contactId: thread.contactId })
            .where(eq(leads.id, form.leadId));
        }
        await recordThreadActivity(thread.conversationId, {
          channel: "form",
          direction: "inbound",
          preview: preview(form.message) ?? "Form submitted",
          occurredAt: form.submittedAt,
          markUnread: false,
        });
        stats.forms++;
      } catch (err) {
        stats.failed++;
        console.error("[thread-backfill] form failed", form.id, err);
      }
    }

    // ── Facebook lead forms ──────────────────────────────────────────────────
    const pendingFb = await db
      .select({
        id: facebookLeads.id,
        leadId: facebookLeads.leadId,
        formId: facebookLeads.fbFormId,
        createdTime: facebookLeads.createdTime,
        createdAt: facebookLeads.createdAt,
        name: leads.name,
        phone: leads.phoneE164,
        email: leads.emailLc,
        message: leads.message,
        sourceId: leads.sourceId,
      })
      .from(facebookLeads)
      .innerJoin(leads, eq(facebookLeads.leadId, leads.id))
      .where(isNull(facebookLeads.conversationId))
      .orderBy(asc(facebookLeads.createdAt))
      .limit(limit);

    for (const fb of pendingFb) {
      const at = fb.createdTime ?? fb.createdAt;
      try {
        const thread = await upsertThread(
          { phone: fb.phone, email: fb.email, name: fb.name, at },
          { endpointKey: fb.formId ? `fb:${fb.formId}` : "fb:leadgen", sourceId: fb.sourceId },
        );
        if (!thread) continue;

        await db
          .update(facebookLeads)
          .set({ conversationId: thread.conversationId })
          .where(eq(facebookLeads.id, fb.id));
        if (fb.leadId) {
          await db
            .update(leads)
            .set({ conversationId: thread.conversationId, contactId: thread.contactId })
            .where(eq(leads.id, fb.leadId));
        }
        await recordThreadActivity(thread.conversationId, {
          channel: "facebook",
          direction: "inbound",
          preview: preview(fb.message) ?? "Facebook lead form submitted",
          occurredAt: at,
          markUnread: false,
        });
        stats.facebook++;
      } catch (err) {
        stats.failed++;
        console.error("[thread-backfill] facebook lead failed", fb.id, err);
      }
    }

    // ── Leads with no activity row of their own (LSA, manual) ────────────────
    // They still belong to a person, so they still belong in the inbox.
    const pendingLeads = await db
      .select({
        id: leads.id,
        name: leads.name,
        phone: leads.phoneE164,
        email: leads.emailLc,
        sourceId: leads.sourceId,
        occurredAt: leads.occurredAt,
      })
      .from(leads)
      .where(
        and(
          isNull(leads.conversationId),
          or(isNotNull(leads.phoneE164), isNotNull(leads.emailLc)),
        ),
      )
      .orderBy(asc(leads.occurredAt))
      .limit(limit);

    for (const lead of pendingLeads) {
      try {
        const thread = await upsertThread(
          { phone: lead.phone, email: lead.email, name: lead.name, at: lead.occurredAt },
          { sourceId: lead.sourceId },
        );
        if (!thread) continue;
        await db
          .update(leads)
          .set({ conversationId: thread.conversationId, contactId: thread.contactId })
          .where(eq(leads.id, lead.id));
        stats.leads++;
      } catch (err) {
        stats.failed++;
        console.error("[thread-backfill] lead failed", lead.id, err);
      }
    }

    const more =
      pendingCalls.length === limit ||
      pendingForms.length === limit ||
      pendingFb.length === limit ||
      pendingLeads.length === limit;
    return { ...stats, more };
  });
}
