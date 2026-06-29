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

/** Parse an application/x-www-form-urlencoded Twilio webhook body. */
export async function parseTwilioForm(req: Request): Promise<{
  params: Record<string, string>;
  url: string;
}> {
  const body = await req.text();
  const params: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => (params[k] = v));
  return { params, url: req.url };
}
