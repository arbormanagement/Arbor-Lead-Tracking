import twilio from "twilio";
import { env } from "@/lib/env";
import { getTwilioConfig } from "./client";

export type SignatureResult = "valid" | "invalid" | "unresolved";

/**
 * Validate the X-Twilio-Signature header. Returns:
 *  - "valid"      signature matches
 *  - "invalid"    we have a token and the signature does NOT match (likely spoofed)
 *  - "unresolved" no auth token available (or dev bypass) — caller decides (the
 *                 voice route fails OPEN on this so a real call is never dropped)
 *
 * The auth token comes from the in-app resolver (DB over env); if neither has it we
 * return "unresolved" rather than rejecting.
 */
export async function validateTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<SignatureResult> {
  const { authToken } = await getTwilioConfig();

  if (!authToken) {
    if (env.NODE_ENV !== "production") {
      console.warn("[twilio] no auth token — skipping signature check (dev)");
    }
    return "unresolved";
  }
  if (!signature) return "invalid";
  return twilio.validateRequest(authToken, signature, url, params) ? "valid" : "invalid";
}

/**
 * Parse an application/x-www-form-urlencoded Twilio webhook body, plus the URL
 * to validate the signature against.
 *
 * Twilio signs the exact PUBLIC url it requested. Behind Railway's proxy,
 * `req.url` can reconstruct with the wrong proto/host and 403 genuine requests —
 * so the URL is rebuilt from the configured public base (same resolution as
 * `base()` in lib/twilio/twiml.ts), keeping the request's own path suffix and
 * query string (e.g. ?src=dial). `req.url` is only a fallback with no base set.
 */
export async function parseTwilioForm(req: Request): Promise<{
  params: Record<string, string>;
  url: string;
}> {
  const body = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => (params[k] = v));
  return { params, url: publicWebhookUrl(req) };
}

function publicWebhookUrl(req: Request): string {
  const base = env.TWILIO_VOICE_WEBHOOK_BASE ?? (env.APP_BASE_URL ? `${env.APP_BASE_URL}/api/twilio` : null);
  if (!base) return req.url;
  const requested = new URL(req.url);
  const configured = new URL(base);
  // Keep the route suffix beyond the shared base path (e.g. /status, /whisper).
  const suffix = requested.pathname.startsWith(configured.pathname)
    ? requested.pathname.slice(configured.pathname.length)
    : requested.pathname;
  return `${configured.origin}${configured.pathname}${suffix}${requested.search}`;
}
