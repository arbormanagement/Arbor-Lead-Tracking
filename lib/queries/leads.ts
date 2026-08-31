import { and, desc, eq, ilike, isNotNull, not, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, leads, sources } from "@/lib/db/schema";

/**
 * Lead search — shared by GET /api/leads and the MCP `list_leads` tool.
 *
 * This exists because nothing could read a lead back: verifying "did that call land
 * with the right source?" or "did the form submission carry its gclid?" meant either
 * opening the UI or inferring it from webhook status codes. Filters are the ones
 * actually needed to answer a support question.
 */

// Enum vocabularies live with the client-safe contracts; re-exported here so
// existing imports keep working.
export { LEAD_STATUSES, LEAD_TYPES } from "@/lib/api-contracts/tools";
import { LEAD_STATUSES, LEAD_TYPES } from "@/lib/api-contracts/tools";

export interface LeadSearch {
  /** Free text over name/email/phone/message. */
  q?: string;
  type?: (typeof LEAD_TYPES)[number];
  status?: (typeof LEAD_STATUSES)[number];
  isSpam?: boolean;
  /** true = carries any of gclid/gbraid/wbraid/fbclid; false = carries none. */
  hasClickId?: boolean;
  limit?: number;
  offset?: number;
}

export interface LeadRow {
  id: string;
  type: string;
  status: string;
  name: string | null;
  phoneE164: string | null;
  emailLc: string | null;
  sourceKey: string | null;
  campaignName: string | null;
  medium: string | null;
  keyword: string | null;
  /** The caller's own answer to "how did you hear about us" — the only field that
   *  can say what is inside the `direct` bucket. */
  selfReportedSource: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  landingPage: string | null;
  isSpam: boolean;
  isFirstTime: boolean | null;
  hcpEstimateId: string | null;
  occurredAt: Date;
}

export async function searchLeads(
  p: LeadSearch,
): Promise<{ rows: LeadRow[]; total: number; hasMore: boolean; nextOffset: number | null }> {
  const where: SQL[] = [];
  if (p.type) where.push(eq(leads.type, p.type));
  if (p.status) where.push(eq(leads.status, p.status));
  if (p.isSpam !== undefined) where.push(eq(leads.isSpam, p.isSpam));
  if (p.q) {
    // Escape LIKE metacharacters so a search for "50%" or "a_b" is a literal
    // search rather than a wildcard — `q=%` otherwise matches every lead.
    const like = `%${p.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const m = or(
      ilike(leads.name, like),
      ilike(leads.emailLc, like),
      ilike(leads.phoneE164, like),
      ilike(leads.message, like),
    );
    if (m) where.push(m);
  }

  // In SQL, not in JS after the fact. Filtering the fetched page instead meant a
  // query could return far fewer rows than `limit` — or none at all — while
  // matching leads sat just beyond the page.
  if (p.hasClickId !== undefined) {
    const anyClickId = or(
      isNotNull(leads.gclid),
      isNotNull(leads.gbraid),
      isNotNull(leads.wbraid),
      isNotNull(leads.fbclid),
    )!;
    where.push(p.hasClickId ? anyClickId : not(anyClickId));
  }

  const where_ = where.length ? and(...where) : undefined;
  const limit = p.limit ?? 50;
  const offset = p.offset ?? 0;

  // Counted over the same predicate as the page, so "showing N of M" is honest
  // rather than a description of whatever the fetch happened to return.
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(where_);
  const total = counted?.n ?? 0;

  const rows = await db
    .select({
      id: leads.id,
      type: leads.type,
      status: leads.status,
      name: leads.name,
      phoneE164: leads.phoneE164,
      emailLc: leads.emailLc,
      sourceKey: sources.key,
      campaignName: campaigns.name,
      medium: leads.medium,
      keyword: leads.keyword,
      selfReportedSource: leads.selfReportedSource,
      gclid: leads.gclid,
      gbraid: leads.gbraid,
      wbraid: leads.wbraid,
      fbclid: leads.fbclid,
      landingPage: leads.landingPage,
      isSpam: leads.isSpam,
      isFirstTime: leads.isFirstTime,
      hcpEstimateId: leads.hcpEstimateId,
      occurredAt: leads.occurredAt,
    })
    .from(leads)
    .leftJoin(sources, eq(sources.id, leads.sourceId))
    .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .where(where_)
    .orderBy(desc(leads.occurredAt))
    .limit(limit)
    .offset(offset);

  const hasMore = offset + rows.length < total;
  return { rows, total, hasMore, nextOffset: hasMore ? offset + rows.length : null };
}
