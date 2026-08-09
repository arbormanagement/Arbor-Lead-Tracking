import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { numberAssignments, sources, spamRules, trackingNumbers } from "@/lib/db/schema";

/**
 * Shared inbound-contact resolution for tracking numbers — used by both the voice
 * webhook and the SMS webhook so a call and a text arriving on the same number
 * attribute identically. Every function here is on a webhook hot path: keep the
 * query count low and never throw for a merely-missing row.
 */

/** A just-released lease still explains a contact that started before the release. */
const GRACE_MS = 15 * 60 * 1000;

export interface InboundAttribution {
  sourceKey: string | null;
  assignmentId: string | null;
}

/**
 * Which source does a contact on this number belong to? Static numbers map
 * straight to their configured source; pooled numbers resolve to the most recent
 * active (or recently released) DNI lease.
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
    return { sourceKey: src?.key ?? null, assignmentId: null };
  }

  const graceCutoff = new Date(Date.now() - GRACE_MS);
  const [assignment] = await db
    .select()
    .from(numberAssignments)
    .where(
      and(
        eq(numberAssignments.trackingNumberId, tn.id),
        or(isNull(numberAssignments.releasedAt), gt(numberAssignments.releasedAt, graceCutoff)),
      ),
    )
    .orderBy(desc(numberAssignments.assignedAt))
    .limit(1);

  return assignment
    ? { sourceKey: assignment.source ?? null, assignmentId: assignment.id }
    : { sourceKey: null, assignmentId: null };
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
      .values({ key: sourceKey, displayName: sourceKey })
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
