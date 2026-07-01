import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";
import { getPlatformCreds } from "@/lib/credentials";

export const runtime = "nodejs";

/**
 * Stream a call recording through the app (admin-gated). Twilio recording URLs
 * require account auth, so linking to them directly hits Twilio's login wall. Here
 * we fetch the media server-side with the Twilio credentials and pipe the audio
 * back to the browser, so the dashboard can play it inline.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("unauthorized", { status: 401 });

  const { id } = await params;
  const [call] = await db.select({ url: calls.recordingUrl }).from(calls).where(eq(calls.id, id)).limit(1);
  if (!call?.url) return new Response("no recording", { status: 404 });

  // Twilio media accepts basic auth with an API key (SK/secret) or Account SID + token.
  const c = await getPlatformCreds("twilio");
  const useKey = !!(c.api_key_sid && c.api_key_secret);
  const user = useKey ? c.api_key_sid! : c.account_sid;
  const pass = useKey ? c.api_key_secret! : c.auth_token;
  if (!user || !pass) return new Response("Twilio credentials not configured", { status: 500 });
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");

  const res = await fetch(call.url, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok || !res.body) return new Response(`recording fetch ${res.status}`, { status: 502 });

  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "audio/mpeg",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
