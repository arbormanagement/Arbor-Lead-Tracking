import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { db } from "@/lib/db/client";
import { leads, sources } from "@/lib/db/schema";

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
    const like = `%${p.q}%`;
    const m = or(
      ilike(leads.name, like),
      ilike(leads.emailLc, like),
      ilike(leads.phoneE164, like),
      ilike(leads.message, like),
    );
    if (m) where.push(m);
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
      medium: leads.medium,
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
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(leads.occurredAt))
    .limit(p.limit);

  // Applied after the query rather than in SQL: "carries any click id" spans four
  // nullable columns, and expressing it as OR(isNotNull…) reads worse than this.
  const filtered =
    p.hasClickId === undefined
      ? rows
      : rows.filter((r) => {
          const has = !!(r.gclid || r.gbraid || r.wbraid || r.fbclid);
          return p.hasClickId === "true" ? has : !has;
        });

  return Response.json({ ok: true, count: filtered.length, leads: filtered });
}
