import { db } from "@/lib/db/client";
import { trackingNumbers } from "@/lib/db/schema";
import { getTwilioClient } from "./client";
import { env } from "@/lib/env";
import type { poolEnum, locationEnum } from "@/lib/db/schema";

type Pool = (typeof poolEnum.enumValues)[number];
type Loc = (typeof locationEnum.enumValues)[number];

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

const webhookBase = () => env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;

/**
 * Provision (buy) or import a Twilio number into a pool: point its voice +
 * status webhooks at this app and record a `tracking_numbers` row. Recording
 * callbacks are set per-call in the dial TwiML (`lib/twilio/twiml.ts`), not here.
 */
export async function provisionNumber(opts: ProvisionOpts) {
  const client = getTwilioClient();
  const base = webhookBase();
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
