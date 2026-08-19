/**
 * Move leads off the `other` ("Other / Unmapped") source once `classifySource`
 * learns a channel it previously did not recognise.
 *   npm run db:reclassify-sources           # dry run — prints what would change
 *   npm run db:reclassify-sources -- --apply
 *
 * Why this exists: a source is classified ONCE, at ingest, and frozen onto the
 * lead. So promoting a channel (adding it to SEED_SOURCES and mapping it in
 * `classifySource`) fixes every future lead and none of the ones already sitting
 * in `other` — which are exactly the rows someone was looking at when they asked
 * for the mapping. The 18 Aug 2026 newsletter is the case in point: 10 leads and
 * 9 estimates that stay mislabelled forever without a pass like this.
 *
 * **It only ever moves a lead OFF `other`.** A lead already on a mapped source is
 * never touched, so this cannot rewrite the source that earned a call — the thing
 * `lib/messaging/thread.ts` is careful about for the same reason. Re-running it
 * changes nothing once the rows have moved.
 *
 * Raw UTM values come from `web_sessions` where the lead has one; a call
 * attributed through a DNI lease has no session of its own, so its `landing_page`
 * query string is the fallback — that is where the tags survive for those.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { classifySource } from "../lib/attribution/classify";
import { connectForSchemaWork, resolveDriver } from "../lib/db/connect";
import * as schema from "../lib/db/schema";
import { UNMAPPED_SOURCE_KEY, displayNameFor } from "../lib/sources/naming";

const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");

const { db, close } = connectForSchemaWork(url, resolveDriver(process.env.DB_DRIVER));

/** utm_source / utm_medium off a stored landing-page URL, for leads with no session. */
function utmFromUrl(landingPage: string | null): { source: string | null; medium: string | null } {
  if (!landingPage) return { source: null, medium: null };
  try {
    const q = new URL(landingPage).searchParams;
    return { source: q.get("utm_source"), medium: q.get("utm_medium") };
  } catch {
    return { source: null, medium: null };
  }
}

async function sourceIdFor(key: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.key, key))
    .limit(1);
  if (existing) return existing.id;
  await db
    .insert(schema.sources)
    .values({ key, displayName: displayNameFor(key) })
    .onConflictDoNothing({ target: schema.sources.key });
  const [created] = await db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.key, key))
    .limit(1);
  if (!created) throw new Error(`could not resolve source ${key}`);
  return created.id;
}

async function main() {
  const [unmapped] = await db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(eq(schema.sources.key, UNMAPPED_SOURCE_KEY))
    .limit(1);
  if (!unmapped) {
    console.log(`No "${UNMAPPED_SOURCE_KEY}" source row — nothing to reclassify.`);
    return;
  }

  const rows = await db
    .select({
      leadId: schema.leads.id,
      occurredAt: schema.leads.occurredAt,
      type: schema.leads.type,
      landingPage: schema.leads.landingPage,
      sessionSource: schema.webSessions.source,
      sessionMedium: schema.webSessions.medium,
      sessionReferrer: schema.webSessions.referrer,
      sessionLanding: schema.webSessions.landingPage,
    })
    .from(schema.leads)
    .leftJoin(schema.webSessions, eq(schema.leads.webSessionId, schema.webSessions.id))
    .where(and(eq(schema.leads.sourceId, unmapped.id), isNotNull(schema.leads.occurredAt)));

  console.log(`${rows.length} lead(s) on "${UNMAPPED_SOURCE_KEY}".`);

  const byKey = new Map<string, number>();
  let moved = 0;

  for (const r of rows) {
    const fallback = utmFromUrl(r.landingPage ?? r.sessionLanding);
    const cls = classifySource({
      utmSource: r.sessionSource ?? fallback.source,
      utmMedium: r.sessionMedium ?? fallback.medium,
      referrer: r.sessionReferrer,
      currentUrl: r.sessionLanding ?? r.landingPage,
    });
    // Still unrecognised — leave it exactly where it is.
    if (cls.sourceKey === UNMAPPED_SOURCE_KEY) continue;

    byKey.set(cls.sourceKey, (byKey.get(cls.sourceKey) ?? 0) + 1);
    moved++;
    console.log(
      `  ${r.occurredAt?.toISOString()} ${r.type.padEnd(16)} ${UNMAPPED_SOURCE_KEY} → ${cls.sourceKey}`,
    );
    if (!APPLY) continue;

    const sourceId = await sourceIdFor(cls.sourceKey);
    await db
      .update(schema.leads)
      .set({ sourceId, medium: cls.medium })
      .where(eq(schema.leads.id, r.leadId));
  }

  console.log(
    `\n${moved} lead(s) ${APPLY ? "moved" : "would move"}: ` +
      ([...byKey].map(([k, n]) => `${k} ${n}`).join(", ") || "none"),
  );
  if (moved && !APPLY) console.log("Dry run — re-run with `-- --apply` to write.");
  if (moved && APPLY) {
    console.log("Run the `attribution` cron (or POST /api/sync/attribution) to rebuild roi_daily.");
  }
}

main()
  .then(() => close())
  .catch(async (e) => {
    console.error(e);
    await close();
    process.exit(1);
  });
