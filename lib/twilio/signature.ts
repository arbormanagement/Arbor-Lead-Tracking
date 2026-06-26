import twilio from "twilio";
import { env } from "@/lib/env";

/**
 * Validate the X-Twilio-Signature header so spoofed POSTs can't inject fake calls.
 * Twilio signs the full webhook URL + sorted POST params with the auth token.
 *
 * In dev (no auth token / explicit bypass) validation is skipped with a warning.
 */
export function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!env.TWILIO_AUTH_TOKEN) {
    if (env.NODE_ENV === "production") return false;
    console.warn("[twilio] TWILIO_AUTH_TOKEN unset — skipping signature check (dev only)");
    return true;
  }
  if (!signature) return false;
  return twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
}

/** Parse an application/x-www-form-urlencoded Twilio webhook body. */
export async function parseTwilioForm(req: Request): Promise<{
  params: Record<string, string>;
  url: string;
}> {
  const body = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => (params[k] = v));
  // Twilio signs the externally-visible URL. Prefer the configured webhook base
  // so proxies/rewrites don't break validation.
  const url = req.url;
  return { params, url };
}
