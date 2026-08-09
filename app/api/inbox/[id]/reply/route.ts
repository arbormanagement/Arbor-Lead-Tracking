import { z } from "zod";
import { getSession } from "@/lib/auth";
import { SendError, sendThreadSms } from "@/lib/messaging/send";

export const runtime = "nodejs";

/** Twilio splits at 1600 chars; refuse rather than silently truncate. */
const Body = z.object({ body: z.string().min(1).max(1600) });

/**
 * Reply to a thread by text. Admin session only — this spends money and messages
 * a real customer, so it is never token-authable like the read endpoints.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Message must be 1–1600 characters" }, { status: 400 });
  }

  try {
    const message = await sendThreadSms({ conversationId: id, body: parsed.data.body });
    return Response.json({ ok: true, id: message.id, status: message.status });
  } catch (err) {
    if (err instanceof SendError) {
      // 409 for consent/config problems — the request was well-formed, the state
      // says no, and the UI should show the reason rather than "try again".
      const status = err.code === "provider" ? 502 : 409;
      return Response.json({ error: err.message, code: err.code }, { status });
    }
    console.error("[inbox/reply] unexpected failure", err);
    return Response.json({ error: "Send failed" }, { status: 500 });
  }
}
