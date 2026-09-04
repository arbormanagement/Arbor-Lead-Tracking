import { and, eq, isNotNull } from "drizzle-orm";
import { classifySource } from "@/lib/attribution/classify";
import { db } from "@/lib/db/client";
import { leads, sources, webSessions } from "@/lib/db/schema";
import { UNMAPPED_SOURCE_KEY, displayNameFor } from "@/lib/sources/naming";

/**
 * Re-run `classifySource` over the leads sitting in `other` and move the ones it
 * now recognises.
 *
 * A source is classified ONCE, at ingest, and frozen onto the lead. So promoting a
 * channel — adding it to SEED_SOURCES and mapping it in `classifySource` — fixes
 * every future lead and none of the ones already in `other`, which are exactly the
 * rows that prompted the mapping. The 18 Aug 2026 SendGrid newsletter is the case
 * in point: 10 leads and 9 estimates filed under "Other / Unmapped" that would have
 * stayed there forever.
 *
 * **It only ever moves a lead OFF `other`.** A lead already on a mapped source is
 * never read, let alone written, so this cannot rewrite the source that earned a
 * call — the property `lib/messaging/thread.ts` is careful about for the same
 * reason. Re-running once the rows have moved is a no-op.
 *
 * Raw UTM values come from `web_sessions` where the lead has one. A call attributed
 * through a DNI lease has no session of its own, so its `landing_page` query string
 * is the fallback — for those leads that is where the tags survive.
 */

export interface ReclassifyMove {
  leadId: string;
  occurredAt: string | null;
  type: string;
  from: string;
  to: string;
}

export interface ReclassifyResult {
  apply: boolean;
  /** Leads currently sitting on `other`. */
  scanned: number;
  /** How many the classifier now recognises (moved when `apply`, otherwise would-move). */
  moved: number;
  byKey: Record<string, number>;
  moves: ReclassifyMove[];
  note: string;
}

/** utm_source / utm_medium / utm_campaign off a stored landing-page URL, for leads with no session. */
function utmFromUrl(
  landingPage: string | null,
): { source: string | null; medium: string | null; campaign: string | null } {
  if (!landingPage) return { source: null, medium: null, campaign: null };
  try {
    const q = new URL(landingPage).searchParams;
    return {
      source: q.get("utm_source"),
      medium: q.get("utm_medium"),
      campaign: q.get("utm_campaign"),
    };
  } catch {
    return { source: null, medium: null, campaign: null };
  }
}

async function sourceIdFor(key: string): Promise<string> {
  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, key))
    .limit(1);
  if (existing) return existing.id;
  await db
    .insert(sources)
    .values({ key, displayName: displayNameFor(key) })
    .onConflictDoNothing({ target: sources.key });
  const [created] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, key))
    .limit(1);
  if (!created) throw new Error(`could not resolve source ${key}`);
  return created.id;
}

export async function reclassifyUnmappedSources({
  apply = false,
}: { apply?: boolean } = {}): Promise<ReclassifyResult> {
  const [unmapped] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.key, UNMAPPED_SOURCE_KEY))
    .limit(1);

  const empty: ReclassifyResult = {
    apply,
    scanned: 0,
    moved: 0,
    byKey: {},
    moves: [],
    note: `no "${UNMAPPED_SOURCE_KEY}" source row exists — nothing to reclassify`,
  };
  if (!unmapped) return empty;

  const rows = await db
    .select({
      leadId: leads.id,
      occurredAt: leads.occurredAt,
      type: leads.type,
      landingPage: leads.landingPage,
      sessionSource: webSessions.source,
      sessionMedium: webSessions.medium,
      sessionCampaign: webSessions.campaign,
      sessionReferrer: webSessions.referrer,
      sessionLanding: webSessions.landingPage,
    })
    .from(leads)
    .leftJoin(webSessions, eq(leads.webSessionId, webSessions.id))
    .where(and(eq(leads.sourceId, unmapped.id), isNotNull(leads.occurredAt)));

  const byKey: Record<string, number> = {};
  const moves: ReclassifyMove[] = [];
  // Resolved lazily and cached: a dry run must not create source rows as a side
  // effect, and a real run should look each key up once rather than per lead.
  const idCache = new Map<string, string>();

  for (const r of rows) {
    const fallback = utmFromUrl(r.landingPage ?? r.sessionLanding);
    const cls = classifySource({
      utmSource: r.sessionSource ?? fallback.source,
      utmMedium: r.sessionMedium ?? fallback.medium,
      // `web_sessions.campaign` is the RAW `utm_campaign`, unlike `.source`, which
      // holds an already-classified key — so this one field reads the same whether
      // the lead has a session or only a stored landing page, and a lead whose tag
      // is legible only from the campaign slot is reachable either way.
      utmCampaign: r.sessionCampaign ?? fallback.campaign,
      referrer: r.sessionReferrer,
      currentUrl: r.sessionLanding ?? r.landingPage,
    });
    // Still unrecognised — leave it exactly where it is.
    if (cls.sourceKey === UNMAPPED_SOURCE_KEY) continue;

    byKey[cls.sourceKey] = (byKey[cls.sourceKey] ?? 0) + 1;
    moves.push({
      leadId: r.leadId,
      occurredAt: r.occurredAt?.toISOString() ?? null,
      type: r.type,
      from: UNMAPPED_SOURCE_KEY,
      to: cls.sourceKey,
    });
    if (!apply) continue;

    let sourceId = idCache.get(cls.sourceKey);
    if (!sourceId) {
      sourceId = await sourceIdFor(cls.sourceKey);
      idCache.set(cls.sourceKey, sourceId);
    }
    await db
      .update(leads)
      .set({ sourceId, medium: cls.medium })
      .where(eq(leads.id, r.leadId));
  }

  return {
    apply,
    scanned: rows.length,
    moved: moves.length,
    byKey,
    moves,
    note: apply
      ? "Applied. Run the `attribution` cron (or POST /api/sync/attribution) to rebuild roi_daily so /sources agrees."
      : "Dry run — nothing written. Re-run with apply to move these leads.",
  };
}
