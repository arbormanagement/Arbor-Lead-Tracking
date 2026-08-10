import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { credentialStatus } from "@/lib/credentials";
import { CREDENTIAL_SPECS } from "@/lib/credentials/spec";
import { db } from "@/lib/db/client";
import { calls, conversionExports, leads, numberAssignments, pools, syncRuns, trackingNumbers } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { businessDate, BUSINESS_TZ } from "@/lib/tz";
import { MAX_EXPORT_ATTEMPTS } from "@/lib/sync/conversions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only operational snapshot: "is this thing actually working right now?"
 *
 * Deliberately a FIXED set of checks, not a query interface. The obvious version
 * of this — an endpoint that runs SQL you hand it — would be an arbitrary-read
 * (and, one typo later, arbitrary-write) backdoor into a production database
 * holding customer contact details, guarded by a single bearer token. This
 * answers the operational questions instead, and can only ever return what is
 * written below.
 *
 * Nothing here returns a secret. Credentials are reported as configured/not and
 * where they came from — never the value, not even masked.
 *
 * Admin-gated the same way /api/numbers/pool is: session cookie, or
 * `Authorization: Bearer $ADMIN_API_TOKEN`.
 */
export async function GET(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  // ── Database ────────────────────────────────────────────────────────────────
  let dbUp = true;
  let dbLatencyMs: number | null = null;
  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    dbLatencyMs = Date.now() - t0;
  } catch {
    dbUp = false;
  }
  if (!dbUp) {
    return Response.json({ ok: false, db: "down", checkedAt: now.toISOString() }, { status: 503 });
  }

  // ── Sync health: newest run per job ─────────────────────────────────────────
  // The whole model is fire-and-log, so "when did each job last SUCCEED" is the
  // question that actually matters — a job erroring for three days looks fine in
  // the logs and shows up nowhere else.
  const runs = await db
    .select({
      job: syncRuns.job,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      error: syncRuns.error,
      stats: syncRuns.stats,
    })
    .from(syncRuns)
    .where(gte(syncRuns.startedAt, new Date(now.getTime() - 30 * 86_400_000)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(500);

  const byJob = new Map<string, { last: (typeof runs)[number]; lastSuccess?: (typeof runs)[number] }>();
  for (const r of runs) {
    const e = byJob.get(r.job);
    if (!e) byJob.set(r.job, { last: r, lastSuccess: r.status === "success" ? r : undefined });
    else if (!e.lastSuccess && r.status === "success") e.lastSuccess = r;
  }
  const jobs = [...byJob.entries()]
    .map(([job, e]) => ({
      job,
      lastStatus: e.last.status,
      lastStartedAt: e.last.startedAt,
      lastError: e.last.status === "error" ? e.last.error : null,
      lastSuccessAt: e.lastSuccess?.startedAt ?? null,
      hoursSinceSuccess: e.lastSuccess
        ? Math.round(((now.getTime() - +e.lastSuccess.startedAt) / 3_600_000) * 10) / 10
        : null,
      lastSuccessStats: e.lastSuccess?.stats ?? null,
      // A job stuck `running` past the reaper's 6h window means a process died
      // mid-run and the claim is blocking every later tick.
      stuckRunning: e.last.status === "running" && +e.last.startedAt < now.getTime() - 6 * 3_600_000,
    }))
    .sort((a, b) => a.job.localeCompare(b.job));

  // ── DNI pool ────────────────────────────────────────────────────────────────
  // Mirrors leaseNumber, including the pools.is_dni join.
  const poolRows = await db
    .select({
      phoneNumber: trackingNumbers.phoneNumber,
      pool: trackingNumbers.pool,
      isDni: pools.isDni,
      leaseId: numberAssignments.id,
    })
    .from(trackingNumbers)
    .leftJoin(pools, eq(pools.key, trackingNumbers.pool))
    .leftJoin(
      numberAssignments,
      and(
        eq(numberAssignments.trackingNumberId, trackingNumbers.id),
        isNull(numberAssignments.releasedAt),
        gte(numberAssignments.expiresAt, now),
      ),
    )
    .where(and(eq(trackingNumbers.isStatic, false), eq(trackingNumbers.status, "active")));

  const rotating = poolRows.filter((r) => r.isDni === true);
  const pool = {
    size: rotating.length,
    leased: rotating.filter((r) => r.leaseId).length,
    free: rotating.length - rotating.filter((r) => r.leaseId).length,
    numbers: rotating.map((r) => ({ phoneNumber: r.phoneNumber, pool: r.pool, leased: !!r.leaseId })),
    // Non-empty = numbers you likely expect to rotate that never will.
    excludedFromRotation: poolRows
      .filter((r) => r.isDni !== true)
      .map((r) => ({ phoneNumber: r.phoneNumber, pool: r.pool })),
  };

  // ── Why did abandoned exports fail? ─────────────────────────────────────────
  // Knowing that N conversions were given up on is only half an answer: the fix
  // depends entirely on WHY, and that error text is sitting one column away. Group
  // it so a systemic cause (one expired credential) is obviously distinct from N
  // unrelated bad click ids.
  const abandonedExports = await db
    .select({
      platform: conversionExports.platform,
      event: conversionExports.event,
      attempts: conversionExports.attempts,
      error: conversionExports.error,
      n: sql<number>`count(*)::int`,
    })
    .from(conversionExports)
    .where(gte(conversionExports.attempts, MAX_EXPORT_ATTEMPTS))
    .groupBy(conversionExports.platform, conversionExports.event, conversionExports.attempts, conversionExports.error)
    .orderBy(desc(sql`count(*)`))
    .limit(10);

  // ── Ingest volume: has anything actually arrived? ───────────────────────────
  const [vol] = await db
    .select({
      leads24h: sql<number>`count(*) filter (where ${leads.occurredAt} >= ${dayAgo})::int`,
      leads7d: sql<number>`count(*) filter (where ${leads.occurredAt} >= ${weekAgo})::int`,
    })
    .from(leads);
  const [callVol] = await db
    .select({
      calls24h: sql<number>`count(*) filter (where ${calls.createdAt} >= ${dayAgo})::int`,
      calls7d: sql<number>`count(*) filter (where ${calls.createdAt} >= ${weekAgo})::int`,
      // The 2026-08 incident in one number: calls connecting, recordings never
      // arriving because the status callback was being rejected.
      recordedCalls7d: sql<number>`count(*) filter (where ${calls.createdAt} >= ${weekAgo} and ${calls.recordingUrl} is not null)::int`,
    })
    .from(calls);

  // ── Configuration sanity ────────────────────────────────────────────────────
  const creds: Record<string, { configured: string[]; missing: string[]; undecryptable: string[]; dbOverridesEnv: string[] }> = {};
  for (const spec of CREDENTIAL_SPECS) {
    const platform = spec.platform;
    const status = await credentialStatus(platform);
    creds[platform] = {
      configured: status.filter((f) => f.set).map((f) => f.key),
      missing: status.filter((f) => !f.set && !f.undecryptable).map((f) => f.key),
      // Stored but unreadable. Reporting these as merely "missing" is wrong in the
      // way that matters: it reads as "never configured" when the truth is "you
      // configured it, and the app cannot see it".
      undecryptable: status.filter((f) => f.undecryptable).map((f) => f.key),
      // Stored value decrypts and differs from env — the database is what the app
      // uses here. After restoring an encryption key, these are exactly the fields
      // whose live value just changed.
      dbOverridesEnv: status.filter((f) => f.dbOverridesEnv).map((f) => f.key),
    };
  }

  const undecryptableTotal = Object.values(creds).reduce((n, c) => n + c.undecryptable.length, 0);

  const config = {
    // Which commit is actually serving this request. Merging is not deploying,
    // and every other signal here is indirect — compare this against the repo to
    // settle "is that fix live yet?" in one look.
    commit: env.RAILWAY_GIT_COMMIT_SHA ? env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7) : "unknown",
    appBaseUrl: env.APP_BASE_URL,
    // A trailing slash here silently invalidates every Twilio signature.
    appBaseUrlHasTrailingSlash: /\/$/.test(env.APP_BASE_URL ?? ""),
    twilioWebhookBase: env.TWILIO_VOICE_WEBHOOK_BASE ?? null,
    // Unset means /status and /recording fail closed and every callback is
    // rejected — calls still connect, so nothing surfaces in the app.
    twilioAuthTokenSet: creds.twilio?.configured.includes("auth_token") ?? false,
    adminApiTokenSet: !!env.ADMIN_API_TOKEN,
    cronSecretSet: !!env.CRON_SECRET,
    credentialEncryptionKeySet: !!env.CREDENTIALS_ENCRYPTION_KEY,
    dbDriver: env.DB_DRIVER,
    businessTimezone: BUSINESS_TZ,
    businessDateToday: businessDate(now),
  };

  // Anything here is worth a human looking at it now.
  const warnings: string[] = [];
  if (config.appBaseUrlHasTrailingSlash) {
    warnings.push("APP_BASE_URL has a trailing slash — Twilio signature validation will reject every callback");
  }
  if (!config.twilioAuthTokenSet) {
    warnings.push("Twilio auth token is not set — /api/twilio/status and /recording fail closed, so no recording will ever persist");
  }
  if (undecryptableTotal > 0) {
    const platforms = Object.entries(creds)
      .filter(([, c]) => c.undecryptable.length)
      .map(([p, c]) => `${p} (${c.undecryptable.join(", ")})`)
      .join("; ");
    warnings.push(
      `${undecryptableTotal} stored credential(s) cannot be decrypted with the current ` +
        `CREDENTIALS_ENCRYPTION_KEY — the app is silently running on env fallbacks, and anything ` +
        `saved in Settings is NOT taking effect: ${platforms}`,
    );
  }
  const overrideTotal = Object.values(creds).reduce((n, c) => n + c.dbOverridesEnv.length, 0);
  if (overrideTotal > 0 && undecryptableTotal === 0) {
    const where = Object.entries(creds)
      .filter(([, c]) => c.dbOverridesEnv.length)
      .map(([p, c]) => `${p} (${c.dbOverridesEnv.join(", ")})`)
      .join("; ");
    warnings.push(
      `${overrideTotal} credential(s) differ between the database and the environment, and the ` +
        `DATABASE value is the one in use — verify these are current, since a stale stored value ` +
        `now shadows a working env one: ${where}`,
    );
  }
  if (pool.excludedFromRotation.length) {
    warnings.push(`${pool.excludedFromRotation.length} active non-static number(s) are not in a DNI pool and will never rotate`);
  }
  if (pool.size > 0 && pool.free === 0) {
    warnings.push("DNI pool is exhausted — visitors are being shown the static fallback number");
  }
  if (pool.size === 0) warnings.push("DNI pool is empty — no number can be leased to a visitor");
  for (const j of jobs) {
    if (j.stuckRunning) warnings.push(`sync job '${j.job}' has been 'running' for over 6h — its claim is blocking later ticks`);
    if (j.lastStatus === "error") warnings.push(`sync job '${j.job}' last run failed: ${j.lastError ?? "unknown error"}`);
    // A run can SUCCEED while the work inside it failed — conversions.export
    // reporting {sent: 0, failed: 1} is a success row with a dropped upload behind
    // it. Reading only `status` is exactly the blind spot that let a dead spend
    // provider report success for weeks, so surface per-item failures too.
    const stats = j.lastSuccessStats as Record<string, unknown> | null;
    for (const key of ["failed", "failedProviders"]) {
      const n = stats && typeof stats[key] === "number" ? (stats[key] as number) : 0;
      if (n > 0) warnings.push(`sync job '${j.job}' succeeded but reported ${n} failed item(s) (stats.${key})`);
    }
    // `abandoned` is the quieter case and needs its own check: once an export
    // passes its retry cap it stops being counted in `failed`, so the run goes
    // clean while the work is permanently undone. Retrying forever was the wrong
    // answer, but so is forgetting.
    const abandoned = stats && typeof stats.abandoned === "number" ? (stats.abandoned as number) : 0;
    if (abandoned > 0) {
      warnings.push(
        `sync job '${j.job}' has permanently abandoned ${abandoned} item(s) after repeated failures — they will never be retried`,
      );
    }
    if (j.hoursSinceSuccess !== null && j.hoursSinceSuccess > 48) {
      warnings.push(`sync job '${j.job}' has not succeeded in ${j.hoursSinceSuccess}h`);
    }
    if (j.hoursSinceSuccess === null) warnings.push(`sync job '${j.job}' has never succeeded`);
  }

  return Response.json({
    ok: warnings.length === 0,
    checkedAt: now.toISOString(),
    db: { up: true, latencyMs: dbLatencyMs },
    warnings,
    config,
    pool,
    jobs,
    abandonedExports,
    volume: { ...vol, ...callVol },
    credentials: creds,
  });
}
