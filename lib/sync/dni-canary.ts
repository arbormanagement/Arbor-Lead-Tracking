import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { pools, trackingNumbers } from "@/lib/db/schema";
import { releaseSessionLeases } from "@/lib/dni/assign";
import { env } from "@/lib/env";
import { trackingOrigins } from "@/lib/origin";
import { withSyncRun } from "./run";

/**
 * dni.canary — prove, on a schedule, that the number swap still works end to end.
 *
 * The failure this exists for is silent by construction. A website deploy that drops
 * the snippet, a renamed script, a settings change that stops the site's origin being
 * allowed: in every case the page keeps rendering the published number, every call
 * still connects, and the app records a healthy-looking week of `direct` traffic. It
 * cost four days to notice last time something in this chain broke, and only because
 * a human went looking.
 *
 * This is the same instrument CallRail ships (a scheduled fetch of one page, alerting
 * when the snippet looks wrong) and the one thing they have that this app did not.
 * Being SYNTHETIC is the point: it does not depend on a visitor's browser reporting
 * back, so unlike any client-side measurement it still fires when the script is being
 * blocked — which is precisely when you need to hear about it.
 *
 * Four checks, cheapest first, each a hard failure:
 *   1. the site serves HTML and it references our track.js
 *   2. track.js is actually served, and still contains the assign call
 *   3. POST /api/dni/assign, exactly as the browser does, returns a number
 *   4. that number is a rotating POOL number, not a static one
 *
 * Check 4 is the one that catches a quietly exhausted pool: `/api/dni/assign` answers
 * with the static fallback rather than an error, so a request that "succeeded" can
 * still mean every visitor is being shown the published number.
 *
 * What it does NOT check is whether the number reached the screen — that needs a real
 * browser rendering the page, and this job deliberately has no headless browser in it
 * (see the note at the bottom). It catches total breakage, not partial.
 */

/** Fixed ids, so the canary owns exactly one visitor row and one session row forever. */
const CANARY_VISITOR_ID = "arbor-dni-canary-visitor";
const CANARY_SESSION_ID = "arbor-dni-canary-session";

/**
 * A keyword no real visitor carries, so `findShareableLease` can never match the
 * canary to a live visitor's lease. Without it the canary would usually be handed a
 * shared `direct` number: it would pass without ever exercising `leaseNumber`, which
 * is the half most likely to be broken.
 */
const CANARY_TERM = "arbor-dni-canary";

/** Honest about what it is. `lib/bot.ts` is bypassed via the canary header, not by spoofing. */
const CANARY_UA = "ArborDNICanary/1.0 (+https://app.arbor-mgmt.com)";

const FETCH_TIMEOUT_MS = 15_000;

function fetchWithTimeout(url: string, init?: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
}

export async function runDniCanary() {
  return withSyncRun("dni.canary", async () => {
    if (!env.CRON_SECRET) {
      // Without it the assign call counts as visitor traffic and pollutes the very
      // coverage number this job exists beside. Better to fail loudly.
      throw new Error("CRON_SECRET is not set — the canary cannot identify itself to /api/dni/assign");
    }

    const [site] = await trackingOrigins();
    if (!site) throw new Error("no tracking origin configured — nothing to check");
    const appBase = env.APP_BASE_URL.replace(/\/$/, "");
    const trackJsUrl = `${appBase}/track.js`;

    // 1. The site is up and still references our snippet.
    const pageRes = await fetchWithTimeout(site, { headers: { "user-agent": CANARY_UA } });
    if (!pageRes.ok) throw new Error(`site ${site} returned HTTP ${pageRes.status}`);
    const html = await pageRes.text();
    const snippetPresent = html.includes(trackJsUrl);
    if (!snippetPresent) {
      throw new Error(
        `${site} does not reference ${trackJsUrl} — the tracking snippet is missing or points elsewhere, ` +
          `so no visitor is being swapped`,
      );
    }

    // 2. track.js is served and is still the real thing. A 200 that returns an error
    //    page would satisfy a status check, so assert on content.
    const scriptRes = await fetchWithTimeout(trackJsUrl, { headers: { "user-agent": CANARY_UA } });
    if (!scriptRes.ok) throw new Error(`${trackJsUrl} returned HTTP ${scriptRes.status}`);
    const script = await scriptRes.text();
    if (!script.includes("/api/dni/assign")) {
      throw new Error(`${trackJsUrl} no longer calls /api/dni/assign — the swap is inert`);
    }

    // 3. Ask for a number the way the page does, including the Origin header the
    //    endpoint requires. Any leftover lease from a run that died before its
    //    release is cleared first, so this always exercises a fresh assignment.
    await releaseSessionLeases(CANARY_SESSION_ID);
    let assigned: string | null = null;
    try {
      const assignRes = await fetchWithTimeout(`${appBase}/api/dni/assign`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: site,
          "user-agent": CANARY_UA,
          "x-arbor-canary": env.CRON_SECRET,
        },
        body: JSON.stringify({
          vid: CANARY_VISITOR_ID,
          sid: CANARY_SESSION_ID,
          url: site,
          utm: { term: CANARY_TERM },
        }),
      });
      if (!assignRes.ok) {
        throw new Error(`/api/dni/assign returned HTTP ${assignRes.status} for an allowed origin`);
      }
      const body = (await assignRes.json()) as { number?: string | null };
      assigned = body.number ?? null;
      if (!assigned) {
        throw new Error("/api/dni/assign returned no number — every visitor is keeping the published number");
      }

      // 4. Is it a POOL number? The endpoint falls back to a static number when the
      //    pool is empty, so a number in hand is not yet proof of a working rotation.
      const [row] = await db
        .select({
          phone: trackingNumbers.phoneNumber,
          isStatic: trackingNumbers.isStatic,
          pool: trackingNumbers.pool,
          isDni: pools.isDni,
        })
        .from(trackingNumbers)
        .leftJoin(pools, eq(pools.key, trackingNumbers.pool))
        .where(eq(trackingNumbers.phoneNumber, assigned))
        .limit(1);
      if (!row) throw new Error(`assigned ${assigned}, which is not a tracking number we know`);
      if (row.isStatic || row.isDni !== true) {
        throw new Error(
          `assigned the STATIC number ${assigned} (pool '${row.pool}') — the DNI pool is exhausted or ` +
            `misconfigured, so visitors are being shown a published number and will read as 'direct'`,
        );
      }

      return { site, snippetPresent, trackJsBytes: script.length, assigned, pool: row.pool };
    } finally {
      // Never hold a pool number between runs. Six numbers cannot spare one, and an
      // unreleased canary lease would itself push a real visitor onto the fallback —
      // the monitor causing the fault it watches for.
      await releaseSessionLeases(CANARY_SESSION_ID).catch((err) =>
        console.error("[dni.canary] failed to release the canary lease", err),
      );
    }
  });
}

/**
 * Deliberately NOT done here: rendering the page in a headless browser to confirm the
 * swapped number actually appears. That is the remaining gap — arbor-mgmt.com is a
 * React SPA, and the failure mode this app already had to defend against is a
 * re-render putting the hard-coded number back after the swap (see the MutationObserver
 * in app/track.js/route.ts). Only a real browser can see that.
 *
 * It is left out because Chromium on the `cron` service is a few hundred MB and a
 * build-pipeline change, which is a large bill for one assertion — and because this
 * job already catches the breakages that actually happen (a deploy dropping the
 * snippet, a broken script, an exhausted pool). Add it when there is evidence of a
 * re-render regression, not before.
 */
