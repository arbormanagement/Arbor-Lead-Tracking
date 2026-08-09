import { z } from "zod";
import { getSession } from "@/lib/auth";
import { setThreadState } from "@/lib/messaging/thread";

export const runtime = "nodejs";

const Body = z.object({ state: z.enum(["open", "closed"]) });

/** Mark a thread done (or reopen it) — the flag that lets the inbox drain. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  await setThreadState(id, parsed.data.state);
  return Response.json({ ok: true, state: parsed.data.state });
}
