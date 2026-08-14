import { and, desc, eq, ilike, isNotNull, not, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import { campaigns, leads, sources } from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * List leads. Read-only, admin-gated (session or machine token).
 *
 * This exists because nothing could read a lead back. The dashboard renders the
 * table server-side, so verifying "did that call land with the right source?" or
 * "did the form submission carry its gclid?" meant either opening the UI or
 * inferring it from webhook status codes — and DELETE /api/leads/[id] is
 * unusable without a way to discover an id in the first place.
 *
 * Filters are the ones actually needed to answer a support question: free-text
 * over name/email/phone/message, plus type/status/spam.
 */
const Query = z.object({
  q: z.string().max(200).optional(),
  // Mirrors leadTypeEnum / leadStatusEnum in lib/db/schema.ts exactly — a value
  // that isn't in the pg enum fails the query rather than matching nothing.
  type: z.enum(["call", "web_form", "facebook_leadgen", "lsa", "manual"]).optional(),
  status: z
    .enum(["new", "working", "qualified", "quoted", "won", "lost", "cancelled", "spam", "duplicate"])
    .optional(),
  isSpam: z.enum(["true", "false"]).optional(),
  hasClickId: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const url = new URL(req.url);
  const parsed = Query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "invalid query" }, { status: 400 });
  const p = parsed.data;

  const where: SQL[] = [];
  if (p.type) where.push(eq(leads.type, p.type));
  if (p.status) where.push(eq(leads.status, p.status));
  if (p.isSpam) where.push(eq(leads.isSpam, p.isSpam === "true"));
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
  // matching leads sat just beyond the page, and the reported count described the
  // filtered page rather than the matches.
  if (p.hasClickId !== undefined) {
    const anyClickId = or(
      isNotNull(leads.gclid),
      isNotNull(leads.gbraid),
      isNotNull(leads.wbraid),
      isNotNull(leads.fbclid),
    )!;
    where.push(p.hasClickId === "true" ? anyClickId : not(anyClickId));
  }

  const rows = await db
    .select({
      id: leads.id,
      type: leads.type,
      status: leads.status,
      name: leads.name,
      phoneE164: leads.phoneE164,
      emailLc: leads.emailLc,
      sourceKey: sources.key,
      // Campaign belongs beside source here. Every other attribution field the
      // lead carries is already returned, and its absence meant the one question
      // this route exists to answer — "did that lead land with the attribution we
      // expect?" — could not be asked about campaign at all, on any surface: the
      // campaigns page is browser-session only.
      campaignName: campaigns.name,
      medium: leads.medium,
      keyword: leads.keyword,
      gclid: leads.gclid,
      gbraid: leads.gbraid,
      wbraid: leads.wbraid,
      fbclid: leads.fbclid,
      landingPage: leads.landingPage,
      location: leads.location,
      isSpam: leads.isSpam,
      isFirstTime: leads.isFirstTime,
      hcpEstimateId: leads.hcpEstimateId,
      occurredAt: leads.occurredAt,
    })
    .from(leads)
    .leftJoin(sources, eq(sources.id, leads.sourceId))
    .leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(leads.occurredAt))
    .limit(p.limit);

  const filtered = rows;

  return Response.json({ ok: true, count: filtered.length, leads: filtered });
}
