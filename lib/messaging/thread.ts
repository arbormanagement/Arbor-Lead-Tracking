import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations } from "@/lib/db/schema";
import { resolveContact, type ContactInput } from "@/lib/contacts/resolve";
import type { ThreadChannel } from "./channels";

// Re-exported for server callers already importing them from here. Client
// components must import from ./channels directly — this module loads the DB driver.
export { CHANNEL_META, preview } from "./channels";
export type { ThreadChannel } from "./channels";

interface ThreadFacts {
  /** Arbor-side endpoint they reached (tracking number / mailbox), for replying. */
  endpointKey?: string | null;
  trackingNumberId?: string | null;
  numberAssignmentId?: string | null;
  sourceId?: string | null;
  subject?: string | null;
}

export interface ResolvedThread {
  conversationId: string;
  contactId: string;
}

/**
 * Find or open the one thread belonging to a person, creating the contact if this
 * is the first time we've seen them.
 *
 * Attribution and endpoint facts only FILL GAPS on an existing thread —
 * `coalesce(existing, new)`, never the reverse. That is what stops a pool number
 * whose DNI lease has since rotated to a different visitor from rewriting the
 * source that earned the original call. `lastEndpointKey` is the deliberate
 * exception: it tracks the most recent inbound endpoint, because a reply has to go
 * out from the number they actually contacted.
 *
 * Returns null when the contact isn't identifiable (nothing to thread on).
 */
export async function upsertThread(
  who: ContactInput,
  facts: ThreadFacts = {},
): Promise<ResolvedThread | null> {
  const contact = await resolveContact(who);
  if (!contact) return null;

  const [row] = await db
    .insert(conversations)
    .values({
      contactId: contact.id,
      lastEndpointKey: facts.endpointKey ?? null,
      trackingNumberId: facts.trackingNumberId ?? null,
      numberAssignmentId: facts.numberAssignmentId ?? null,
      sourceId: facts.sourceId ?? null,
      subject: facts.subject ?? null,
    })
    .onConflictDoUpdate({
      target: conversations.contactId,
      set: {
        trackingNumberId: sql`coalesce(${conversations.trackingNumberId}, excluded.tracking_number_id)`,
        numberAssignmentId: sql`coalesce(${conversations.numberAssignmentId}, excluded.number_assignment_id)`,
        sourceId: sql`coalesce(${conversations.sourceId}, excluded.source_id)`,
        subject: sql`coalesce(${conversations.subject}, excluded.subject)`,
        // Newest endpoint wins — this is the reply-to address.
        lastEndpointKey: sql`coalesce(excluded.last_endpoint_key, ${conversations.lastEndpointKey})`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: conversations.id });

  return { conversationId: row.id, contactId: contact.id };
}

/**
 * Record that something happened on a thread, keeping the denormalized "last
 * activity" columns the inbox list reads.
 *
 * The `last_activity_at` guard matters: Twilio delivers webhooks out of order
 * under retry and the backfills replay history, so a late-arriving older event
 * must not rewrite the preview to something stale. Inbound activity also reopens
 * a closed thread — a customer replying to a finished job is new work.
 */
export async function recordThreadActivity(
  conversationId: string,
  activity: {
    channel: ThreadChannel;
    direction: "inbound" | "outbound";
    preview?: string | null;
    occurredAt?: Date;
    /** Set false when replaying history — a 2024 call is not unread work. */
    markUnread?: boolean;
  },
) {
  const at = activity.occurredAt ?? new Date();
  const inbound = activity.direction === "inbound";
  const counts = inbound && activity.markUnread !== false;
  const isNewest = sql`${conversations.lastActivityAt} <= ${at}`;

  await db
    .update(conversations)
    .set({
      // Idempotent set-add: replaying an event can't grow the array.
      channels: sql`case when ${activity.channel} = any(${conversations.channels}) then ${conversations.channels} else array_append(${conversations.channels}, ${activity.channel}) end`,
      lastChannel: sql`case when ${isNewest} then ${activity.channel} else ${conversations.lastChannel} end`,
      lastDirection: sql`case when ${isNewest} then ${activity.direction} else ${conversations.lastDirection} end`,
      lastPreview: sql`case when ${isNewest} then ${activity.preview ?? null} else ${conversations.lastPreview} end`,
      lastActivityAt: sql`greatest(${conversations.lastActivityAt}, ${at})`,
      unreadCount: counts ? sql`${conversations.unreadCount} + 1` : conversations.unreadCount,
      // Real inbound work reopens a thread someone had marked done.
      state: counts ? "open" : conversations.state,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}

/** Mark a thread read (opening it in the inbox). */
export async function markThreadRead(conversationId: string) {
  await db
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), sql`${conversations.unreadCount} > 0`));
}

/** Open/close a thread — the "dealt with" flag that lets the inbox drain. */
export async function setThreadState(conversationId: string, state: "open" | "closed") {
  await db
    .update(conversations)
    .set({ state, updatedAt: new Date(), ...(state === "closed" ? { unreadCount: 0 } : {}) })
    .where(eq(conversations.id, conversationId));
}
