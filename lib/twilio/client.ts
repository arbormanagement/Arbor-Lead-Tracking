import twilio from "twilio";
import { getPlatformCreds } from "@/lib/credentials";

/**
 * Twilio REST client (server-only), credentials from the in-app resolver (DB over
 * env). Prefer API key/secret over the auth token, but fall back to account SID +
 * auth token. Cached by resolved account SID so a credential change takes effect
 * within the resolver's cache window.
 */
let cached: { sid: string; client: ReturnType<typeof twilio> } | null = null;

export async function getTwilioClient() {
  const c = await getPlatformCreds("twilio");
  if (!c.account_sid) throw new Error("Twilio account SID is not configured");

  if (cached && cached.sid === c.account_sid) return cached.client;

  let client: ReturnType<typeof twilio>;
  if (c.api_key_sid && c.api_key_secret) {
    client = twilio(c.api_key_sid, c.api_key_secret, { accountSid: c.account_sid });
  } else if (c.auth_token) {
    client = twilio(c.account_sid, c.auth_token);
  } else {
    throw new Error("Twilio credentials missing (need API key/secret or auth token)");
  }
  cached = { sid: c.account_sid, client };
  return client;
}

/** Resolve the auth token + webhook base for signature checks / provisioning. The
 *  default forward number now lives in Settings → Routing (see lib/routing.ts). */
export async function getTwilioConfig() {
  const c = await getPlatformCreds("twilio");
  return {
    accountSid: c.account_sid ?? null,
    authToken: c.auth_token ?? null,
    voiceWebhookBase: c.voice_webhook_base ?? null,
  };
}
