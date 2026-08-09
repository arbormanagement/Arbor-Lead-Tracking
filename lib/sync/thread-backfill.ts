import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { calls, trackingNumbers } from "@/lib/db/schema";
import { recordThreadActivity, upsertThread } from "@/lib/messaging/thread";
import { withSyncRun } from "./run";

/**
 * Thread historical calls into conversations.
 *
 * Calls recorded before the inbox existed have no `conversation_id`, so they'd
 * show in the inbox list but have no thread to open — and a customer who called
 * last month and texts today would look like two unrelated people. This walks the
 * backlog oldest-first and files each call under the (caller, tracking number)
 * thread it belongs to, which is the same key the live webhooks use.
 *
 * Idempotent: only untreaded calls are selected, and `upsertThread` is an upsert.
 * Safe to run repeatedly and safe to interrupt — a partial run just leaves fewer
 * rows for the next one. Run it from Settings → Sync (`POST /api/sync/thread-backfill`).
 */
export async function backfillCallThreads({ limit = 1000 }: { limit?: number } = {}) {
  return withSyncRun("threads.backfill", async () => {
    const pending = await db
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
      // Oldest first so each thread's `last_*` columns end up describing its most
      // recent call rather than whichever one happened to be processed last.
      .orderBy(asc(calls.createdAt))
      .limit(limit);

    let threaded = 0;
    let failed = 0;

    for (const call of pending) {
      try {
        const thread = await upsertThread(
          { contactKey: call.fromNumber!, endpointKey: call.endpoint },
          {
            leadId: call.leadId,
            trackingNumberId: call.trackingNumberId,
            numberAssignmentId: call.numberAssignmentId,
          },
        );
        if (!thread) continue;

        await db.update(calls).set({ conversationId: thread.id }).where(eq(calls.id, call.id));
        await recordThreadActivity(thread.id, {
          channel: "call",
          direction: "inbound",
          preview: "Inbound call",
          occurredAt: call.createdAt,
          markUnread: false, // replaying history, not new work
        });
        threaded++;
      } catch (err) {
        failed++;
        console.error("[thread-backfill] failed for call", call.id, err);
      }
    }

    return { pending: pending.length, threaded, failed, more: pending.length === limit };
  });
}
