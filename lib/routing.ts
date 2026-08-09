import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";

/** Settings key for the account-wide default call-forward number. */
export const DEFAULT_FORWARD_KEY = "routing.default_forward";

/** Settings key for where inbound texts are relayed. */
export const SMS_FORWARD_KEY = "routing.sms_forward";

/**
 * Account-wide default forward number — the destination a call rings when a tracking
 * number has no per-number `forward_destination`. Editable in Settings → Routing;
 * falls back to the TWILIO_DEFAULT_DESTINATION env default. `getSetting` is fault
 * tolerant, so this is safe in the <3s voice hot path.
 */
export async function getDefaultForwardNumber(): Promise<string> {
  const v = await getSetting<string | null>(DEFAULT_FORWARD_KEY, null);
  return (typeof v === "string" && v.trim()) || env.TWILIO_DEFAULT_DESTINATION;
}

/**
 * Where an inbound text to a tracking number is relayed, so a text isn't stranded
 * in the dashboard until someone opens it. Null = relaying is off (texts are still
 * captured and threaded).
 *
 * Deliberately NOT falling back to the call-forward default: that destination is
 * currently +16182059924 — Chloe, the Retell voice agent — and a voice agent
 * cannot read an SMS. A wrong number here fails silently, so it must be set on
 * purpose (Settings → Routing, or TWILIO_SMS_FORWARD_TO).
 */
export async function getSmsForwardNumber(): Promise<string | null> {
  const v = await getSetting<string | null>(SMS_FORWARD_KEY, null);
  const configured = (typeof v === "string" && v.trim()) || env.TWILIO_SMS_FORWARD_TO;
  return configured?.trim() || null;
}
