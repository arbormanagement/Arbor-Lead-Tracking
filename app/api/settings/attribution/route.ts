import { getSession } from "@/lib/auth";
import { setSetting } from "@/lib/settings";

export const runtime = "nodejs";

const MODELS = new Set(["last_touch", "first_touch"]);

/**
 * Attribution options: which single-touch model credits a lead when a contact has
 * several (last_touch default / first_touch), and the customer window — how many
 * days a repeat won estimate inherits the contact's original lead's source.
 * Applied retroactively on the next attribution rebuild (hourly, or manual sync).
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { model?: string; customerWindowDays?: number }
    | null;

  const model = body?.model;
  if (!model || !MODELS.has(model)) {
    return Response.json({ error: "model must be last_touch or first_touch" }, { status: 400 });
  }
  const windowDays = Number(body?.customerWindowDays);
  if (!Number.isFinite(windowDays) || windowDays < 0 || windowDays > 365) {
    return Response.json({ error: "customerWindowDays must be 0–365" }, { status: 400 });
  }

  await setSetting("attribution_model", model);
  await setSetting("customer_window_days", Math.round(windowDays));
  return Response.json({ ok: true, model, customerWindowDays: Math.round(windowDays) });
}
