import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { conversations } from "@/lib/db/schema";

/** Longest snippet worth keeping for an inbox row preview. */
const PREVIEW_CHARS = 140;

export type ThreadChannel = "call" | "sms" | "email";

/** Collapse whitespace and clip — inbox previews are one line, never a paragraph. */
export function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS - 1) + "…" : flat;
}

interface ThreadKey {
  /** Contact side: E.164 phone (call/sms) or lowercased email. */
  contactKey: string;
  /** Arbor side: the tracking number reached, or the mailbox address. */
  endpointKey: string;
}

interface ThreadFacts {
  contactName?: string | null;
  leadId?: string | null;
  trackingNumberId?: string | null;
  numberAssignmentId?: string | null;
  sourceId?: string | null;
  subject?: string | null;
}

/**
 * Find or create the thread for a (contact, endpoint) pair.
 *
 * On an existing thread the extra facts only FILL GAPS — `coalesce(existing, new)`,
 * never the other way round. That is deliberate: the attribution snapshot on a
 * thread belongs to the contact that opened it, and a later text arriving on a
 * pool number whose lease has since rotated to a different visitor must not
 * overwrite the source that earned the original call.
 */
export async function upsertThread(key: ThreadKey, facts: ThreadFacts = {}) {
  const [row] = await db
    .insert(conversations)
    .values({
      contactKey: key.contactKey,
      endpointKey: key.endpointKey,
      contactName: facts.contactName ?? null,
      leadId: facts.leadId ?? null,
      trackingNumberId: facts.trackingNumberId ?? null,
      numberAssignmentId: facts.numberAssignmentId ?? null,
      sourceId: facts.sourceId ?? null,
      subject: facts.subject ?? null,
    })
    .onConflictDoUpdate({
      target: [conversations.contactKey, conversations.endpointKey],
      set: {
        contactName: sql`coalesce(${conversations.contactName}, excluded.contact_name)`,
        leadId: sql`coalesce(${conversations.leadId}, excluded.lead_id)`,
        trackingNumberId: sql`coalesce(${conversations.trackingNumberId}, excluded.tracking_number_id)`,
        numberAssignmentId: sql`coalesce(${conversations.numberAssignmentId}, excluded.number_assignment_id)`,
        sourceId: sql`coalesce(${conversations.sourceId}, excluded.source_id)`,
        subject: sql`coalesce(${conversations.subject}, excluded.subject)`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/**
 * Record that something happened on a thread, keeping the denormalized "last
 * activity" columns the inbox list reads.
 *
 * The `last_activity_at` guard matters: Twilio delivers status callbacks and
 * inbound webhooks out of order under retry, so a late-arriving older event must
 * not rewrite the preview to something stale. The unread counter is bumped
 * regardless — an inbound message still needs attention whenever it lands.
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
  const inbound = activity.direction === "inbound" && activity.markUnread !== false;

  await db
    .update(conversations)
    .set({
      lastChannel: sql`case when ${conversations.lastActivityAt} <= ${at} then ${activity.channel} else ${conversations.lastChannel} end`,
      lastDirection: sql`case when ${conversations.lastActivityAt} <= ${at} then ${activity.direction} else ${conversations.lastDirection} end`,
      lastPreview: sql`case when ${conversations.lastActivityAt} <= ${at} then ${activity.preview ?? null} else ${conversations.lastPreview} end`,
      lastActivityAt: sql`greatest(${conversations.lastActivityAt}, ${at})`,
      unreadCount: inbound ? sql`${conversations.unreadCount} + 1` : conversations.unreadCount,
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
