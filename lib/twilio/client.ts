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

/**
 * Assert a URL is Twilio-hosted before attaching Twilio credentials to a request
 * for it.
 *
 * `calls.recording_url` is written from the `RecordingUrl` field of an inbound
 * webhook. That callback is signature-verified and fails closed in production, so
 * this is defence in depth rather than a live hole — but the value is
 * attacker-shaped data that two code paths (transcription and admin playback)
 * hand a Basic auth header containing the Twilio API secret. Anything that ever
 * lets a forged callback through would exfiltrate those credentials on the next
 * fetch; this makes that impossible instead of merely unlikely.
 */
export function assertTwilioMediaUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("recording URL is not a valid URL");
  }
  const host = u.hostname.toLowerCase();
  const allowed =
    u.protocol === "https:" &&
    (host === "twilio.com" || host.endsWith(".twilio.com") || host.endsWith(".twiliocdn.com"));
  if (!allowed) throw new Error(`refusing to send Twilio credentials to non-Twilio host: ${host}`);
  return u;
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
