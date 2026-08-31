import { env } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/settings";
import { normalizePhone } from "@/lib/phone";

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

export type RoutingPatch = { defaultForward?: string; smsForward?: string };
export type RoutingResult =
  | { ok: true; defaultForward?: string | null; smsForward?: string | null }
  | { ok: false; field: "defaultForward" | "smsForward" };

/**
 * Save routing settings — the one implementation behind `/api/settings/routing`
 * and the MCP `arbor_set_routing` tool.
 *
 * Each field is optional: omit one to leave it alone, pass an empty string to clear
 * it (falling back to the env default for calls, and to no relaying at all for
 * texts). Phones are normalized to E.164 before storing, because everything
 * downstream matches on that form.
 *
 * Changing the call-forward default also re-asserts every number's Twilio webhooks,
 * best-effort: the voice FALLBACK is stored per number on Twilio's side, so a
 * default that moves without this leaves the fallback aimed at the old destination —
 * and the fallback only fires when the app is already failing, which is exactly when
 * nobody is watching. A Twilio hiccup must not fail the save, so it is caught.
 */
export async function setRoutingConfig(patch: RoutingPatch): Promise<RoutingResult> {
  const result: RoutingResult = { ok: true };

  if (patch.defaultForward !== undefined) {
    const raw = patch.defaultForward.trim();
    if (!raw) {
      await setSetting(DEFAULT_FORWARD_KEY, null);
      result.defaultForward = null;
    } else {
      const e164 = normalizePhone(raw);
      if (!e164) return { ok: false, field: "defaultForward" };
      await setSetting(DEFAULT_FORWARD_KEY, e164);
      result.defaultForward = e164;
    }
    try {
      const { backfillNumberWebhooks } = await import("@/lib/twilio/numbers");
      await backfillNumberWebhooks();
    } catch (err) {
      console.error("[twilio] webhook repoint failed (setting saved)", err);
    }
  }

  if (patch.smsForward !== undefined) {
    const raw = patch.smsForward.trim();
    if (!raw) {
      await setSetting(SMS_FORWARD_KEY, null);
      result.smsForward = null;
    } else {
      const e164 = normalizePhone(raw);
      if (!e164) return { ok: false, field: "smsForward" };
      await setSetting(SMS_FORWARD_KEY, e164);
      result.smsForward = e164;
    }
  }

  return result;
}
