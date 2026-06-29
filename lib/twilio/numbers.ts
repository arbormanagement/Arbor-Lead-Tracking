import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { trackingNumbers } from "@/lib/db/schema";
import { getTwilioClient, getTwilioConfig } from "./client";
import { env } from "@/lib/env";
import type { poolEnum, locationEnum, numberStatusEnum } from "@/lib/db/schema";

type Pool = (typeof poolEnum.enumValues)[number];
type Loc = (typeof locationEnum.enumValues)[number];
type NumberStatus = (typeof numberStatusEnum.enumValues)[number];

interface ProvisionOpts {
  pool: Pool;
  areaCode?: string;
  /** Import an already-owned number instead of buying one. */
  importPhoneNumber?: string;
  isStatic?: boolean;
  staticSourceId?: string | null;
  location?: Loc;
  friendlyName?: string;
}

async function webhookBase(): Promise<string> {
  const cfg = await getTwilioConfig();
  return cfg.voiceWebhookBase ?? env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;
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
    const updated = await client.incomingPhoneNumbers(owned.sid).update(config);
    sid = updated.sid;
    phoneNumber = updated.phoneNumber;
    capabilities = updated.capabilities;
  } else {
    if (!opts.areaCode) throw new Error("areaCode is required to provision a new number");
    const available = await client
      .availablePhoneNumbers("US")
      .local.list({ areaCode: Number(opts.areaCode), voiceEnabled: true, limit: 1 });
    if (available.length === 0) throw new Error(`No available numbers in area code ${opts.areaCode}`);
    const created = await client.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      ...config,
    });
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

/** Edit a tracking number's metadata (pool / static / source / location / name). */
export async function updateNumber(
  id: string,
  patch: { pool?: Pool; isStatic?: boolean; staticSourceId?: string | null; location?: Loc; friendlyName?: string },
) {
  const [row] = await db
    .update(trackingNumbers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(trackingNumbers.id, id))
    .returning();
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
