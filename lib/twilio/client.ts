import twilio from "twilio";
import { env } from "@/lib/env";

/**
 * Twilio REST client (server-only). Prefer API key/secret over the auth token,
 * but fall back to the account SID + auth token if a key isn't configured.
 *
 * Lazily constructed so importing this module in a context without Twilio creds
 * (e.g. `next build`) doesn't throw.
 */
let cached: ReturnType<typeof twilio> | null = null;

export function getTwilioClient() {
  if (cached) return cached;
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new Error("TWILIO_ACCOUNT_SID is not set");
  }
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    cached = twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
      accountSid: env.TWILIO_ACCOUNT_SID,
    });
  } else if (env.TWILIO_AUTH_TOKEN) {
    cached = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  } else {
    throw new Error("Twilio credentials missing (need API key/secret or auth token)");
  }
  return cached;
}
