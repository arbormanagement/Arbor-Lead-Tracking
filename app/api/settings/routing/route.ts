import { z } from "zod";
import { getSession } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { DEFAULT_FORWARD_KEY } from "@/lib/routing";
import { normalizePhone } from "@/lib/phone";
import { backfillVoiceFallback } from "@/lib/twilio/numbers";

/** Re-point every number's Twilio voice fallback after the default changes.
 *  Best-effort — the setting save must not fail on a Twilio hiccup. */
async function repointFallbacks() {
  try {
    await backfillVoiceFallback();
  } catch (err) {
    console.error("[twilio] voice-fallback repoint failed (setting saved)", err);
  }
}

export const runtime = "nodejs";

/**
 * Save call-routing settings (admin-gated). Currently the account-wide default
 * forward number. Empty clears it (falls back to the env default). Phone is
 * normalized to E.164 before storing.
 */
const Body = z.object({ defaultForward: z.string() });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const raw = parsed.data.defaultForward.trim();
  if (!raw) {
    await setSetting(DEFAULT_FORWARD_KEY, null);
    await repointFallbacks();
    return Response.json({ ok: true, defaultForward: null });
  }

  const e164 = normalizePhone(raw);
  if (!e164) return Response.json({ error: "Enter a valid phone number (e.g. +16188368004)" }, { status: 400 });

  await setSetting(DEFAULT_FORWARD_KEY, e164);
  await repointFallbacks();
  return Response.json({ ok: true, defaultForward: e164 });
}
