import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { trackingNumbers } from "@/lib/db/schema";
import { getTwilioClient, getTwilioConfig } from "./client";
import { env } from "@/lib/env";
import { getDefaultForwardNumber } from "@/lib/routing";
import type { locationEnum, numberStatusEnum } from "@/lib/db/schema";

type Pool = string; // pools.key (user-managed)
type Loc = (typeof locationEnum.enumValues)[number];
type NumberStatus = (typeof numberStatusEnum.enumValues)[number];

interface ProvisionOpts {
  pool: Pool;
  areaCode?: string;
  /** Buy this exact available number (chosen from a search). Beats areaCode. */
  purchasePhoneNumber?: string;
  /** Buy a toll-free number (when searching by areaCode and none chosen). */
  tollFree?: boolean;
  /** Import an already-owned number instead of buying one. */
  importPhoneNumber?: string;
  /**
   * Import a number whose webhooks already point at another app, overwriting
   * them. Refused by default — see assertImportIsSafe.
   */
  forceImport?: boolean;
  isStatic?: boolean;
  staticSourceId?: string | null;
  location?: Loc;
  friendlyName?: string;
  /** Per-number call routing. */
  forwardDestination?: string | null;
  whisperMessage?: string | null;
  recordCalls?: boolean;
  greetingMessage?: string | null;
  greetingEnabled?: boolean;
}

export interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
  locality: string | null;
  region: string | null;
}

/**
 * List numbers available to buy from Twilio (so the admin picks the actual digits,
 * CallRail-style) — local by area code (optionally a `contains` digit pattern) or
 * toll-free. Voice-enabled only.
 */
export async function searchAvailableNumbers(opts: {
  areaCode?: string;
  contains?: string;
  tollFree?: boolean;
  limit?: number;
}): Promise<AvailableNumber[]> {
  const client = await getTwilioClient();
  const limit = Math.min(opts.limit ?? 15, 30);
  const list = opts.tollFree
    ? await client.availablePhoneNumbers("US").tollFree.list({ contains: opts.contains, voiceEnabled: true, limit })
    : await client.availablePhoneNumbers("US").local.list({
        areaCode: opts.areaCode ? Number(opts.areaCode) : undefined,
        contains: opts.contains,
        voiceEnabled: true,
        limit,
      });
  return list.map((n) => ({
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    locality: n.locality ?? null,
    region: n.region ?? null,
  }));
}

/**
 * URLs that mean "nothing is listening here" — safe to overwrite on import.
 * Twilio stamps its demo TwiML onto a freshly bought number, and the forward
 * twimlet is our own fallback, so neither indicates another app owns this number.
 */
const INERT_WEBHOOK_HOSTS = new Set(["demo.twilio.com", "twimlets.com"]);

function isForeignWebhook(url: string | null | undefined, base: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).host;
    if (INERT_WEBHOOK_HOSTS.has(host)) return false;
    return host !== new URL(base).host;
  } catch {
    return false; // unparseable — not evidence of another app
  }
}

/**
 * Refuse to import a number that is already wired to something else.
 *
 * `provisionNumber` overwrites voice, SMS, status and fallback in one update, so
 * importing a number another system is using silently steals it. Owning a number
 * on the Twilio account is NOT evidence it is spare.
 *
 * Checked per channel, because they fail independently and a number can be idle
 * on one while live on another. On 2026-08-17 +16183103486 was imported as a
 * "spare" on the strength of its voice_url being Twilio's demo page — its
 * sms_url pointed at the Arbor MCP and it was the live review-request SMS line.
 * Inbound customer replies went to the wrong handler until it was restored.
 */
function assertImportIsSafe(
  owned: { phoneNumber: string; voiceUrl?: string | null; smsUrl?: string | null; statusCallback?: string | null },
  base: string,
  force?: boolean,
) {
  if (force) return;
  const conflicts = (
    [
      ["voice_url", owned.voiceUrl],
      ["sms_url", owned.smsUrl],
      ["status_callback", owned.statusCallback],
    ] as const
  ).filter(([, url]) => isForeignWebhook(url, base));

  if (conflicts.length === 0) return;

  throw new Error(
    `${owned.phoneNumber} is already in use by another application and was NOT imported. ` +
      conflicts.map(([field, url]) => `${field} -> ${url}`).join("; ") +
      `. Importing rewrites every webhook on the number, which would break whatever is serving those. ` +
      `Confirm the number is genuinely unused (check recent traffic on EVERY channel, not just the one that looks idle), ` +
      `then re-run with forceImport: true.`,
  );
}

async function webhookBase(): Promise<string> {
  const cfg = await getTwilioConfig();
  return cfg.voiceWebhookBase ?? env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;
}

/**
 * Voice fallback: Twilio-hosted TwiML (the "forward" twimlet) that answers and
 * dials the destination with NO dependency on this app — Twilio invokes it only
 * when the primary voice webhook errors or is unreachable, so a full app outage
 * degrades to a plain (untracked) forwarded call instead of a dropped one.
 */
function voiceFallbackFor(destination: string): { voiceFallbackUrl: string; voiceFallbackMethod: "GET" } {
  return {
    voiceFallbackUrl: `https://twimlets.com/forward?PhoneNumber=${encodeURIComponent(destination)}`,
    voiceFallbackMethod: "GET",
  };
}

/**
 * Inbound SMS webhook. No Twilio-side fallback equivalent to the voice twimlet:
 * if the app is down Twilio retries, and the /sms route is idempotent, so a text
 * is delayed rather than lost.
 */
function smsWebhookFor(base: string): { smsUrl: string; smsMethod: "POST" } {
  return { smsUrl: `${base}/sms`, smsMethod: "POST" };
}

/**
 * Re-assert every active tracking number's Twilio-side webhooks: the voice
 * fallback (pointed at its forward destination or the account default) and the
 * inbound SMS webhook. Idempotent — safe to re-run after changing routing, and
 * run hourly by the `twilio-fallback` cron so no number can drift.
 *
 * This is also how numbers provisioned before SMS support existed — the ten
 * transferred from CallRail — get their `smsUrl` set without anyone touching the
 * Twilio console. Until it runs, a text to those numbers goes nowhere.
 */
export async function backfillNumberWebhooks() {
  const client = await getTwilioClient();
  const defaultForward = await getDefaultForwardNumber();
  const base = await webhookBase();
  const rows = await db.select().from(trackingNumbers).where(eq(trackingNumbers.status, "active"));

  let updated = 0;
  // An active number with no Twilio SID is unreachable by this job forever: its
  // smsUrl and voice fallback can never be written, so texts to it go nowhere and
  // a deploy drops its calls. Counted rather than skipped in silence, because
  // `numbers: 11, updated: 11` and `numbers: 11, updated: 8` looked equally
  // healthy from the outside.
  let skippedNoSid = 0;
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.twilioSid) {
      skippedNoSid++;
      continue;
    }
    try {
      await client.incomingPhoneNumbers(row.twilioSid).update({
        ...voiceFallbackFor(row.forwardDestination ?? defaultForward),
        ...smsWebhookFor(base),
      });
      updated++;
    } catch (err) {
      errors.push(`${row.phoneNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // `errorCount` duplicates errors.length on purpose: /api/diagnostics warns off
  // NUMERIC stats keys, so the array alone would be persisted and never alerted on.
  return { numbers: rows.length, updated, skippedNoSid, errorCount: errors.length, errors };
}

/**
 * Provision (buy) or import a Twilio number into a pool: point its voice +
 * status webhooks at this app and record a `tracking_numbers` row. Recording
 * callbacks are set per-call in the dial TwiML (`lib/twilio/twiml.ts`), not here.
 */
export async function provisionNumber(opts: ProvisionOpts) {
  const client = await getTwilioClient();
  const base = await webhookBase();
  const config = {
    voiceUrl: `${base}/voice`,
    voiceMethod: "POST" as const,
    ...voiceFallbackFor(opts.forwardDestination ?? (await getDefaultForwardNumber())),
    ...smsWebhookFor(base),
    statusCallback: `${base}/status`,
    statusCallbackMethod: "POST" as const,
    friendlyName: opts.friendlyName ?? `arbor:${opts.pool}`,
  };

  let sid: string;
  let phoneNumber: string;
  let capabilities: unknown = null;

  if (opts.importPhoneNumber) {
    const [owned] = await client.incomingPhoneNumbers.list({
      phoneNumber: opts.importPhoneNumber,
      limit: 1,
    });
    if (!owned) throw new Error(`Number ${opts.importPhoneNumber} is not owned by this Twilio account`);
    // Owning it is not the same as it being spare — check nothing else is served
    // by it BEFORE the update below overwrites every webhook.
    assertImportIsSafe(owned, base, opts.forceImport);
    const updated = await client.incomingPhoneNumbers(owned.sid).update(config);
    sid = updated.sid;
    phoneNumber = updated.phoneNumber;
    capabilities = updated.capabilities;
  } else {
    // Buy a specific chosen number, else the first available in the area code.
    let toBuy = opts.purchasePhoneNumber;
    if (!toBuy) {
      if (!opts.areaCode && !opts.tollFree) {
        throw new Error("areaCode, a chosen number, or tollFree is required to provision");
      }
      const available = await searchAvailableNumbers({
        areaCode: opts.areaCode,
        tollFree: opts.tollFree,
        limit: 1,
      });
      if (available.length === 0) {
        throw new Error(
          opts.tollFree ? "No toll-free numbers available" : `No available numbers in area code ${opts.areaCode}`,
        );
      }
      toBuy = available[0].phoneNumber;
    }
    const created = await client.incomingPhoneNumbers.create({ phoneNumber: toBuy, ...config });
    sid = created.sid;
    phoneNumber = created.phoneNumber;
    capabilities = created.capabilities;
  }

  const [row] = await db
    .insert(trackingNumbers)
    .values({
      twilioSid: sid,
      phoneNumber,
      friendlyName: config.friendlyName,
      pool: opts.pool,
      status: "active",
      isStatic: opts.isStatic ?? false,
      staticSourceId: opts.staticSourceId ?? null,
      location: opts.location ?? "unknown",
      forwardDestination: opts.forwardDestination ?? null,
      whisperMessage: opts.whisperMessage ?? null,
      recordCalls: opts.recordCalls ?? true,
      greetingMessage: opts.greetingMessage ?? null,
      greetingEnabled: opts.greetingEnabled ?? true,
      capabilities,
      provisionedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: trackingNumbers.twilioSid,
      set: { pool: opts.pool, isStatic: opts.isStatic ?? false, status: "active" },
    })
    .returning();

  return row;
}

/** Edit a tracking number's metadata + per-number routing. */
export async function updateNumber(
  id: string,
  patch: {
    pool?: Pool;
    isStatic?: boolean;
    staticSourceId?: string | null;
    location?: Loc;
    friendlyName?: string;
    forwardDestination?: string | null;
    whisperMessage?: string | null;
    recordCalls?: boolean;
    greetingMessage?: string | null;
    greetingEnabled?: boolean;
  },
) {
  const [row] = await db
    .update(trackingNumbers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(trackingNumbers.id, id))
    .returning();

  // Keep the Twilio-side voice fallback pointed at the new forward destination.
  // Best-effort: the fallback is a safety net, so a Twilio hiccup here must not
  // fail the routing edit itself.
  if (row?.twilioSid && patch.forwardDestination !== undefined) {
    try {
      const client = await getTwilioClient();
      const dest = row.forwardDestination ?? (await getDefaultForwardNumber());
      await client.incomingPhoneNumbers(row.twilioSid).update(voiceFallbackFor(dest));
    } catch (err) {
      console.error("[twilio] voice-fallback update failed (routing saved)", err);
    }
  }
  return row;
}

/** Enable/disable a number in-app (keeps the Twilio number; just stops using it). */
export async function setNumberStatus(id: string, status: NumberStatus) {
  const [row] = await db
    .update(trackingNumbers)
    .set({ status, updatedAt: new Date() })
    .where(eq(trackingNumbers.id, id))
    .returning();
  return row;
}

/**
 * Release a number: relinquish it on Twilio (stops billing — the number is gone)
 * and mark the row disabled. The row is kept so historical calls still resolve.
 */
export async function releaseNumber(id: string) {
  const [row] = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, id)).limit(1);
  if (!row) throw new Error("tracking number not found");

  if (row.twilioSid) {
    const client = await getTwilioClient();
    try {
      await client.incomingPhoneNumbers(row.twilioSid).remove();
    } catch (err) {
      // If it's already gone on Twilio, proceed to mark it disabled locally.
      console.error("[twilio] release failed (continuing to disable locally)", err);
    }
  }

  const [updated] = await db
    .update(trackingNumbers)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(trackingNumbers.id, id))
    .returning();
  return updated;
}
