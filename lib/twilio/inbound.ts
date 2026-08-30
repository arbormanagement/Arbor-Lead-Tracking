import { displayNameFor } from "@/lib/sources/naming";
import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { numberAssignments, sources, spamRules, trackingNumbers, webSessions } from "@/lib/db/schema";

/**
 * Shared inbound-contact resolution for tracking numbers — used by both the voice
 * webhook and the SMS webhook so a call and a text arriving on the same number
 * attribute identically. Every function here is on a webhook hot path: keep the
 * query count low and never throw for a merely-missing row.
 */

/**
 * How long after a DNI lease ENDS a contact on that number is still explained by it.
 *
 * The number stays on the visitor's screen after the lease lapses, and people ring
 * when it suits them — they read it, get interrupted, and dial after the meeting.
 * At 15 minutes on top of a 15-minute lease, a caller had ~30 minutes from their
 * last pageview before the call resolved to NO SOURCE at all: pool numbers carry no
 * `static_source_id`, so with no assignment to match there is nothing to fall back
 * to. Measured 2026-08-21: a call on 8/20 that self-reported "google search" and
 * went on to produce an estimate landed with a null source — the first
 * `leadButNoSource` this app has ever recorded.
 *
 * Two hours, not longer, because the failure modes are asymmetric. Widening only
 * changes the outcome while the number sits IDLE — once it is re-leased the newest
 * assignment wins below, and a late caller is credited to whoever holds it now
 * whatever this value is. So the cost of a wide window is a stale cached page dialled
 * the next morning being credited to a lease from hours earlier, which is a WRONG
 * answer where null is merely a coarse one. Same principle as never sharing a lease
 * across a click id.
 */
const GRACE_MS = 120 * 60 * 1000;

export interface InboundAttribution {
  sourceKey: string | null;
  assignmentId: string | null;
  /**
   * The last page the leased session was seen on — what the caller was reading
   * when they dialled, as opposed to `lease.landingPage`, which is where the
   * visit began. Null for a static number, a session with no pageview, or any
   * session that started before `web_sessions.last_page` existed.
   */
  conversionPage: string | null;
  /**
   * The whole lease, not just its source. Everything else frozen onto it at assign
   * time — campaign, keyword, click ids, landing page, session/visitor — belongs on
   * the lead the contact produces. Returning only the source meant every DNI call
   * (and now text) reached `attributions` and campaign-level `roi_daily` with a
   * NULL campaign and NULL gclid, so paid contacts could be credited to a source
   * but never to the campaign or click that actually produced them, and the
   * offline-conversion upload had no gclid to send. The row is already fetched
   * below; discarding it was pure loss.
   */
  lease: typeof numberAssignments.$inferSelect | null;
  /**
   * The campaign a STATIC number stands for (`tracking_numbers.static_campaign_id`).
   *
   * A static number has no lease, so there is no `utm_campaign` text for
   * `resolveCampaignIdByName` to match and every call to one reached `roi_daily`
   * with a null campaign. That is fine where the source IS the whole story, and
   * wrong where one source runs several numbered assets — the two Google Business
   * Profile listings share the source `gbp`, and the listing is the thing worth
   * comparing. Null for a pooled number, whose campaign comes off the lease.
   */
  staticCampaignId: string | null;
}

/**
 * Which source does a contact on this number belong to? Static numbers map
 * straight to their configured source; pooled numbers resolve to the most recent
 * lease that is still active or ended within `GRACE_MS`.
 */
export async function resolveInboundAttribution(
  tn: typeof trackingNumbers.$inferSelect,
): Promise<InboundAttribution> {
  if (tn.isStatic && tn.staticSourceId) {
    const [src] = await db
      .select({ key: sources.key })
      .from(sources)
      .where(eq(sources.id, tn.staticSourceId))
      .limit(1);
    return {
      sourceKey: src?.key ?? null,
      assignmentId: null,
      lease: null,
      conversionPage: null,
      staticCampaignId: tn.staticCampaignId ?? null,
    };
  }

  // Keyed on `expires_at`, NOT `released_at`, and deliberately so. `released_at` is
  // stamped by `releaseExpired()`, which runs opportunistically at the top of each
  // /api/dni/assign request — so on a busy day it lands seconds after the lease
  // lapsed, while on a quiet evening an expired lease can sit with `released_at`
  // NULL for hours and match here forever. That made the real grace window a
  // function of how much OTHER traffic the site happened to get, which is exactly
  // the kind of silent, traffic-dependent behaviour that makes an attribution bug
  // impossible to reproduce. `expires_at` is when the lease actually ended and is
  // written once, so the window below is the same length at 3am as at noon.
  //
  // An active lease still matches: its `expires_at` is in the future, which is
  // trivially after the cutoff.
  const graceCutoff = new Date(Date.now() - GRACE_MS);
  // The LEFT JOIN pulls the session's last page in the same round trip. This route
  // has a hard sub-3s budget and fallback-forwards on error, so the page a caller
  // was reading is worth exactly one indexed join on a primary key and not a
  // second query. LEFT, not inner: a lease can be seeded by /api/dni/assign before
  // any pageview reached /api/track, and losing the whole attribution because the
  // page is unknown would be a far worse trade.
  const [row] = await db
    .select({ assignment: numberAssignments, conversionPage: webSessions.lastPage })
    .from(numberAssignments)
    .leftJoin(webSessions, eq(webSessions.id, numberAssignments.webSessionId))
    .where(and(eq(numberAssignments.trackingNumberId, tn.id), gt(numberAssignments.expiresAt, graceCutoff)))
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(1);

  return row
    ? {
        sourceKey: row.assignment.source ?? null,
        assignmentId: row.assignment.id,
        lease: row.assignment,
        conversionPage: row.conversionPage ?? null,
        staticCampaignId: null,
      }
    : { sourceKey: null, assignmentId: null, lease: null, conversionPage: null, staticCampaignId: null };
}

/**
 * Resolve a source key to its row id, creating the row when missing — a DNI lease
 * can freeze a key (e.g. facebook/organic) before any pageview reached /api/track
 * to create it, such as when the tracking snippet is ad-blocked.
 */
export async function ensureSourceId(sourceKey: string | null): Promise<string | null> {
  if (!sourceKey) return null;
  let [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, sourceKey)).limit(1);
  if (!src) {
    await db
      .insert(sources)
      .values({ key: sourceKey, displayName: displayNameFor(sourceKey) })
      .onConflictDoNothing({ target: sources.key });
    [src] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, sourceKey)).limit(1);
  }
  return src?.id ?? null;
}

/**
 * Hard spam rules on the originating number (reject-action rules only) — the
 * cheap pre-check both webhooks run before doing any real work.
 */
export async function isHardSpamNumber(fromE164: string): Promise<boolean> {
  const rules = await db
    .select()
    .from(spamRules)
    .where(
      and(eq(spamRules.field, "from_number"), eq(spamRules.enabled, true), eq(spamRules.action, "reject")),
    );
  return rules.some((r) => {
    try {
      return new RegExp(r.pattern).test(fromE164);
    } catch {
      // A bad pattern must never 500 a hot path — skip the rule and surface it.
      console.warn("[twilio/inbound] invalid spam rule pattern — skipping:", r.pattern);
      return false;
    }
  });
}
