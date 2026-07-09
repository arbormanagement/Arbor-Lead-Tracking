import { z } from "zod";
import { getSession } from "@/lib/auth";
import { facebook } from "@/lib/integrations/facebook";
import { getSetting, setSetting } from "@/lib/settings";
import { FB_INCLUDED_FORMS_KEY } from "@/lib/sync/facebook-leads";

export const runtime = "nodejs";

/**
 * List the page's lead forms + which are selected for polling. Admin-gated. Returns
 * 200 with { ok:false } on token/config problems so the UI can show a friendly hint.
 * POST saves the selected form ids (empty ⇒ default to all ACTIVE forms).
 */
export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [forms, selected] = await Promise.all([
      facebook.listLeadForms(),
      getSetting<string[]>(FB_INCLUDED_FORMS_KEY, []),
    ]);
    return Response.json({ ok: true, forms, selected });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

const Body = z.object({ formIds: z.array(z.string()) });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });
  await setSetting(FB_INCLUDED_FORMS_KEY, parsed.data.formIds);
  return Response.json({ ok: true, selected: parsed.data.formIds });
}
