import { z } from "zod";
import { authorizeAdmin, unauthorized } from "@/lib/admin-auth";
import { setSetting } from "@/lib/settings";
import { DEFAULT_FORWARD_KEY, SMS_FORWARD_KEY } from "@/lib/routing";
import { normalizePhone } from "@/lib/phone";
import { backfillNumberWebhooks } from "@/lib/twilio/numbers";

/** Re-assert every number's Twilio webhooks after the default changes.
 *  Best-effort — the setting save must not fail on a Twilio hiccup. */
async function repointFallbacks() {
  try {
    await backfillNumberWebhooks();
  } catch (err) {
    console.error("[twilio] webhook repoint failed (setting saved)", err);
  }
}

export const runtime = "nodejs";

/**
 * Save routing settings (admin-gated): the account-wide default call-forward
 * number, and where inbound texts are relayed. Each field is optional — send only
 * the one being changed. Empty clears it (falling back to the env default, or to
 * no relaying at all for texts). Phones are normalized to E.164 before storing.
 */
const Body = z.object({
  defaultForward: z.string().optional(),
  smsForward: z.string().optional(),
});

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req);
  if (!auth.ok) return unauthorized();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const result: Record<string, string | null> = {};

  if (parsed.data.defaultForward !== undefined) {
    const raw = parsed.data.defaultForward.trim();
    if (!raw) {
      await setSetting(DEFAULT_FORWARD_KEY, null);
      result.defaultForward = null;
    } else {
      const e164 = normalizePhone(raw);
      if (!e164) return Response.json({ error: "Enter a valid phone number (e.g. +16188368004)" }, { status: 400 });
      await setSetting(DEFAULT_FORWARD_KEY, e164);
      result.defaultForward = e164;
    }
    // Only the call-forward default changes the Twilio-side voice fallback.
    await repointFallbacks();
  }

  if (parsed.data.smsForward !== undefined) {
    const raw = parsed.data.smsForward.trim();
    if (!raw) {
      await setSetting(SMS_FORWARD_KEY, null);
      result.smsForward = null;
    } else {
      const e164 = normalizePhone(raw);
      if (!e164) return Response.json({ error: "Enter a valid mobile number (e.g. +16188368004)" }, { status: 400 });
      await setSetting(SMS_FORWARD_KEY, e164);
      result.smsForward = e164;
    }
  }

  return Response.json({ ok: true, ...result });
}
