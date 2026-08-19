/**
 * Scheduler worker — the Railway replacement for Vercel Cron.
 *
 * Runs as its own always-on Railway service off the same image
 * (`npm run cron`). It holds the schedule that used to live in `vercel.json` and
 * calls the web service's `/api/cron/<job>` endpoints with the shared
 * `CRON_SECRET`, exactly as Vercel's scheduler did — so the job code path is
 * unchanged and every job stays runnable by hand with a single curl.
 *
 * Why a separate service rather than a timer inside the web process:
 *   - `/api/twilio/voice` must answer in under 3s or a call is lost. A 5-minute
 *     spend sync sharing that event loop is a real risk; a separate container
 *     isn't.
 *   - The web service can restart, redeploy, or scale without dropping or
 *     double-firing a schedule.
 *
 * Env:
 *   CRON_SECRET            required — must match the web service's value
 *   CRON_TARGET_BASE_URL   base URL of the web service; defaults to APP_BASE_URL.
 *                          Prefer Railway's private domain
 *                          (http://<service>.railway.internal:8080) to keep cron
 *                          traffic off the public internet.
 *   CRON_TIMEZONE          IANA zone for the schedules. Defaults to UTC because
 *                          that is what Vercel Cron used, so the ported patterns
 *                          below fire at exactly the same wall-clock times as
 *                          before. Set America/Chicago to reinterpret them as
 *                          Central (this moves the daily spend jobs from
 *                          ~2:37am to 7:37am local).
 *   CRON_JOBS              optional comma-separated allowlist, for running a
 *                          subset in a second worker.
 */
import { Cron } from "croner";

const BASE_URL = (process.env.CRON_TARGET_BASE_URL ?? process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const TIMEZONE = process.env.CRON_TIMEZONE ?? "UTC";

if (!BASE_URL) throw new Error("[cron] CRON_TARGET_BASE_URL or APP_BASE_URL must be set");
if (!SECRET) throw new Error("[cron] CRON_SECRET must be set (and match the web service)");

/**
 * Ported verbatim from vercel.json. `job` is the `/api/cron/[job]` segment.
 *
 * `timeoutMs` bounds each run so a hung upstream API can't wedge a schedule —
 * generous, because Railway has no serverless execution ceiling (these jobs were
 * previously capped at Vercel's 300s `maxDuration`).
 */
const JOBS: Array<{ job: string; schedule: string; timeoutMs?: number }> = [
  { job: "reaper", schedule: "*/5 * * * *", timeoutMs: 60_000 },
  { job: "transcribe", schedule: "*/10 * * * *", timeoutMs: 300_000 },
  // Texts are cheap to classify and gate the Leads list, so run them often —
  // offset from `transcribe` to keep the two Anthropic-calling jobs apart.
  { job: "classify-messages", schedule: "3-59/5 * * * *", timeoutMs: 180_000 },
  { job: "hcp", schedule: "7 * * * *", timeoutMs: 600_000 },
  { job: "attribution", schedule: "22 * * * *", timeoutMs: 600_000 },
  { job: "fbleads", schedule: "9,24,39,54 * * * *", timeoutMs: 300_000 },
  { job: "conversions", schedule: "37 * * * *", timeoutMs: 600_000 },
  { job: "spend", schedule: "37 7 * * *", timeoutMs: 900_000 },
  { job: "twilio-fallback", schedule: "52 * * * *", timeoutMs: 300_000 },
  // Hourly rather than daily (CallRail's cadence): the breakage it catches arrives
  // with a website deploy, and every hour it goes unnoticed is an hour of visitors
  // landing on the published number and reading as `direct`. One page fetch and one
  // lease, so the cost of the tighter loop is nil.
  { job: "dni-canary", schedule: "41 * * * *", timeoutMs: 120_000 },
  // Backfills pre-inbox call history on its first runs, then idles at zero rows —
  // staying on as the repair path for the voice webhook's best-effort threading.
  { job: "thread-backfill", schedule: "17 * * * *", timeoutMs: 600_000 },
];

const only = process.env.CRON_JOBS?.split(",").map((s) => s.trim()).filter(Boolean);
const enabled = only?.length ? JOBS.filter((j) => only.includes(j.job)) : JOBS;

if (only?.length) {
  const unknown = only.filter((name) => !JOBS.some((j) => j.job === name));
  if (unknown.length) throw new Error(`[cron] CRON_JOBS names no such job: ${unknown.join(", ")}`);
}

function log(job: string, message: string) {
  console.log(`[cron] ${new Date().toISOString()} ${job}: ${message}`);
}

async function run(job: string, timeoutMs: number) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/cron/${job}`, {
      headers: { authorization: `Bearer ${SECRET}` },
      signal: controller.signal,
    });
    const body = await res.text();
    const ms = Date.now() - startedAt;
    if (!res.ok) {
      // Logged, not thrown: one failed run must not kill the worker and take
      // every other schedule with it. The next tick retries.
      log(job, `✗ HTTP ${res.status} in ${ms}ms — ${body.slice(0, 500)}`);
      return;
    }
    log(job, `✓ ${ms}ms — ${body.slice(0, 500)}`);
  } catch (err) {
    const ms = Date.now() - startedAt;
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : String(err);
    log(job, `✗ ${reason} (${ms}ms)`);
  } finally {
    clearTimeout(timer);
  }
}

const scheduled = enabled.map(({ job, schedule, timeoutMs = 300_000 }) =>
  // `protect` drops a tick if the previous run of the SAME job is still going,
  // so a slow sync queues up behind itself instead of stacking concurrent runs.
  new Cron(schedule, { name: job, timezone: TIMEZONE, protect: true }, () => run(job, timeoutMs)),
);

console.log(
  `[cron] worker up — ${scheduled.length} job(s), tz=${TIMEZONE}, target=${BASE_URL}\n` +
    scheduled
      .map((c) => `  ${String(c.name).padEnd(16)} ${c.getPattern()}  next: ${c.nextRun()?.toISOString() ?? "—"}`)
      .join("\n"),
);

// Railway sends SIGTERM on redeploy; stop cleanly so an in-flight job isn't
// reported as a crash.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[cron] ${signal} — stopping ${scheduled.length} schedule(s)`);
    scheduled.forEach((c) => c.stop());
    process.exit(0);
  });
}
