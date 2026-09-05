import { and, asc, desc, eq, getTableColumns, gte, sql, type SQL } from "drizzle-orm";
import { hcpEstimates } from "@/lib/db/schema";
import { leadQuoteCentsSql, leadSalesCentsSql, leadStageSql } from "@/lib/leads/stage";
import { db } from "@/lib/db/client";
import {
  calls,
  contacts,
  conversations,
  facebookLeads,
  formSubmissions,
  hcpCustomers,
  leads,
  messages,
  sources,
  trackingNumbers,
} from "@/lib/db/schema";
import type { ThreadChannel } from "@/lib/messaging/channels";

/**
 * The inbox reads — thread list and one thread's whole timeline — extracted so
 * /inbox and the MCP tools (`list_threads`, `get_thread`) share one implementation.
 *
 * The inbox is CONTACT-centric: one thread per person, holding every channel
 * they've ever used. Channel filtering means "threads CONTAINING that channel"
 * (`conversations.channels`, a text[]), not "threads whose newest activity is it".
 * Recruiting enquiries are deliberately present — the inbox is the one surface the
 * campaign exclusion does not apply to: a recruiting enquiry is still someone
 * contacting the business; it just never becomes a lead, so it stays out of ROI.
 *
 * Reading here has NO side effects: marking a thread read is the page's decision
 * (`markThreadRead`), not the query's.
 */

export type ThreadStateFilter = "open" | "all";

export interface ThreadListRow {
  id: string;
  state: string;
  channels: string[];
  lastChannel: string | null;
  lastDirection: string | null;
  lastPreview: string | null;
  lastActivityAt: Date;
  unreadCount: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  optedOut: Date | null;
  /** HousecallPro owns the customer record — the name reads through the link. */
  hcpFirst: string | null;
  hcpLast: string | null;
}

export async function listThreads(opts: {
  days: number;
  channel?: ThreadChannel | null;
  state?: ThreadStateFilter;
  limit?: number;
  offset?: number;
}): Promise<{
  threads: ThreadListRow[];
  counts: Record<ThreadChannel, number>;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}> {
  const { days, channel = null, state = "open", limit = 50, offset = 0 } = opts;
  const since = new Date(Date.now() - days * 86_400_000);

  const filters: SQL[] = [gte(conversations.lastActivityAt, since)];
  if (channel) filters.push(sql`${channel} = any(${conversations.channels})`);
  if (state === "open") filters.push(eq(conversations.state, "open"));

  const [threads, counts, [counted]] = await Promise.all([
    db
      .select({
        id: conversations.id,
        state: conversations.state,
        channels: conversations.channels,
        lastChannel: conversations.lastChannel,
        lastDirection: conversations.lastDirection,
        lastPreview: conversations.lastPreview,
        lastActivityAt: conversations.lastActivityAt,
        unreadCount: conversations.unreadCount,
        name: contacts.displayName,
        phone: contacts.primaryPhone,
        email: contacts.primaryEmail,
        optedOut: contacts.smsOptedOutAt,
        hcpFirst: hcpCustomers.firstName,
        hcpLast: hcpCustomers.lastName,
      })
      .from(conversations)
      .innerJoin(contacts, eq(conversations.contactId, contacts.id))
      .leftJoin(hcpCustomers, eq(contacts.hcpCustomerId, hcpCustomers.id))
      .where(and(...filters))
      .orderBy(desc(conversations.lastActivityAt))
      .limit(limit)
      .offset(offset),
    channelCounts(since, state),
    // Total under the SAME filters, so a caller can distinguish "that is all of
    // them" from "that is the first page".
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(and(...filters)),
  ]);

  const total = counted?.n ?? 0;
  const hasMore = offset + threads.length < total;

  return { threads, counts, total, hasMore, nextOffset: hasMore ? offset + threads.length : null };
}

/** Per-channel thread counts (for the tab badges and the tool's summary). */
async function channelCounts(since: Date, state: ThreadStateFilter): Promise<Record<ThreadChannel, number>> {
  const scope: SQL[] = [gte(conversations.lastActivityAt, since)];
  if (state === "open") scope.push(eq(conversations.state, "open"));

  const has = (c: ThreadChannel) => sql<number>`count(*) filter (where ${c} = any(${conversations.channels}))::int`;
  const [row] = await db
    .select({
      call: has("call"),
      sms: has("sms"),
      form: has("form"),
      facebook: has("facebook"),
      email: has("email"),
    })
    .from(conversations)
    .where(and(...scope));

  return row ?? { call: 0, sms: 0, form: 0, facebook: 0, email: 0 };
}

export interface ThreadDetail {
  thread: typeof conversations.$inferSelect;
  contact: typeof contacts.$inferSelect;
  sourceKey: string | null;
  sourceName: string | null;
  numberLabel: string | null;
  hcpFirst: string | null;
  hcpLast: string | null;
  hcpExternalId: string | null;
  calls: Array<{
    call: typeof calls.$inferSelect;
    /** Which of our numbers they actually dialed — the point of running ten of them. */
    dialedNumber: string | null;
    dialedName: string | null;
  }>;
  messages: Array<typeof messages.$inferSelect>;
  forms: Array<typeof formSubmissions.$inferSelect>;
  facebookLeads: Array<typeof facebookLeads.$inferSelect>;
  /** Newest first. One thread can hold several enquiries over time. */
  leads: Array<typeof leads.$inferSelect & { status: string; quoteValueCents: number | null; salesValueCents: number | null }>;
}

/** One person's whole history with us. Null when the thread does not exist. */
export async function getThreadDetail(id: string): Promise<ThreadDetail | null> {
  const [row] = await db
    .select({
      thread: conversations,
      contact: contacts,
      sourceKey: sources.key,
      sourceName: sources.displayName,
      numberLabel: trackingNumbers.friendlyName,
      hcpFirst: hcpCustomers.firstName,
      hcpLast: hcpCustomers.lastName,
      hcpExternalId: hcpCustomers.hcpCustomerId,
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(sources, eq(conversations.sourceId, sources.id))
    .leftJoin(trackingNumbers, eq(conversations.trackingNumberId, trackingNumbers.id))
    .leftJoin(hcpCustomers, eq(contacts.hcpCustomerId, hcpCustomers.id))
    .where(eq(conversations.id, id))
    .limit(1);
  if (!row) return null;

  const [callRows, messageRows, formRows, fbRows, leadRows] = await Promise.all([
    db
      .select({
        call: calls,
        dialedNumber: trackingNumbers.phoneNumber,
        dialedName: trackingNumbers.friendlyName,
      })
      .from(calls)
      .leftJoin(trackingNumbers, eq(calls.trackingNumberId, trackingNumbers.id))
      .where(eq(calls.conversationId, row.thread.id))
      .orderBy(asc(calls.createdAt)),
    db.select().from(messages).where(eq(messages.conversationId, row.thread.id)).orderBy(asc(messages.occurredAt)),
    db.select().from(formSubmissions).where(eq(formSubmissions.conversationId, row.thread.id)),
    db.select().from(facebookLeads).where(eq(facebookLeads.conversationId, row.thread.id)),
    db
      .select({ ...getTableColumns(leads), status: leadStageSql, quoteValueCents: leadQuoteCentsSql, salesValueCents: leadSalesCentsSql })
      .from(leads)
      .leftJoin(hcpEstimates, eq(hcpEstimates.id, leads.hcpEstimateId))
      .where(eq(leads.conversationId, row.thread.id))
      .orderBy(desc(leads.occurredAt)),
  ]);

  return {
    ...row,
    calls: callRows,
    messages: messageRows,
    forms: formRows,
    facebookLeads: fbRows,
    leads: leadRows,
  };
}
