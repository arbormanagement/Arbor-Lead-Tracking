import { getSession } from "@/lib/auth";
import { listImportableNumbers } from "@/lib/twilio/numbers";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Admin: list voice-capable numbers owned in the Twilio account but not yet
 * tracked by the app — candidates for Numbers → Add → "Import a number you own"
 * (e.g. a number just ported in from CallRail). Includes each number's current
 * voice URL so the UI can warn before repointing one that's routed elsewhere.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    return Response.json({ ok: true, numbers: await listImportableNumbers() });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
