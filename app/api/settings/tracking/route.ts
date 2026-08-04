import { z } from "zod";
import { getSession } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { TRACKING_ORIGINS_KEY, DEFAULT_ALLOWED_ORIGINS, normalizeOrigin } from "@/lib/origin";

export const runtime = "nodejs";

/**
 * Save the tracking-origin allowlist (admin-gated) — the sites whose pages may
 * POST to /api/track and /api/dni/assign. Comma- or newline-separated; each
 * entry must parse as a URL. Empty clears the setting (the built-in
 * arbor-mgmt.com defaults apply). Takes effect within a minute (lib/origin.ts
 * caches the built set briefly).
 */
const Body = z.object({ allowedOrigins: z.string().max(4000) });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  const entries = parsed.data.allowedOrigins
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    await setSetting(TRACKING_ORIGINS_KEY, null);
    return Response.json({ ok: true, allowedOrigins: DEFAULT_ALLOWED_ORIGINS, defaults: true });
  }

  const origins: string[] = [];
  for (const entry of entries) {
    // Accept bare hostnames as a convenience — origins are https in practice.
    const o = normalizeOrigin(entry.includes("://") ? entry : `https://${entry}`);
    if (!o) return Response.json({ error: `Not a valid origin: "${entry}"` }, { status: 400 });
    if (!origins.includes(o)) origins.push(o);
  }

  await setSetting(TRACKING_ORIGINS_KEY, origins);
  return Response.json({ ok: true, allowedOrigins: origins, defaults: false });
}
