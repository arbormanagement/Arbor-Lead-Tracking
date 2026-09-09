/**
 * Where Twilio should call this app back — resolved in ONE place.
 *
 * The base was computed inline in `lib/twilio/numbers.ts` and is now needed by
 * the two send paths as well (delivery receipts). It is deliberately the same
 * resolution order `parseTwilioForm` uses to rebuild the URL it validates the
 * signature against: if the two ever disagreed, every callback would arrive,
 * fail its signature check, and be refused — the silent-403 shape that once
 * swallowed every recording for weeks.
 */
import { env } from "@/lib/env";
import { getTwilioConfig } from "./client";

export async function twilioWebhookBase(): Promise<string> {
  const cfg = await getTwilioConfig();
  const base = cfg.voiceWebhookBase ?? env.TWILIO_VOICE_WEBHOOK_BASE ?? `${env.APP_BASE_URL}/api/twilio`;
  return base.replace(/\/+$/, "");
}

/**
 * The SMS delivery-receipt callback. `reviewRequestId` rides on the query
 * string rather than being looked up from the phone number afterwards: Twilio
 * signs the exact URL it was given, query included, so the link back to the
 * review request is both precise and tamper-evident — and it keeps `messages`
 * free of a foreign key to a feature it should know nothing about.
 */
export async function messageStatusCallbackUrl(reviewRequestId?: string): Promise<string> {
  const url = `${await twilioWebhookBase()}/message-status`;
  return reviewRequestId ? `${url}?rr=${encodeURIComponent(reviewRequestId)}` : url;
}
