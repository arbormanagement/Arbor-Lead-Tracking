import { env } from "@/lib/env";
import { getSetting } from "@/lib/settings";

/** Settings key for the account-wide default call-forward number. */
export const DEFAULT_FORWARD_KEY = "routing.default_forward";

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
