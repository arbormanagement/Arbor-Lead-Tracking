import { createHmac, timingSafeEqual } from "node:crypto";
import { getFacebookLead } from "@/lib/integrations/facebook";
import { ingestFacebookLead } from "@/lib/facebook/ingest";
import { getPlatformCreds } from "@/lib/credentials";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Facebook lead-gen webhook. GET handles Meta's verification handshake; POST
 * receives leadgen events (which carry only the leadgen_id) and fetches the full
 * field data from the Graph API, creating a deduped facebook_leadgen lead.
 *
 * Subscribe the page to this URL in the Meta app dashboard (or via the Graph API)
 * with verify token = FACEBOOK_VERIFY_TOKEN.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = (await getPlatformCreds("facebook")).verify_token;
  if (mode === "subscribe" && token && verifyToken && token === verifyToken) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  const appSecret = (await getPlatformCreds("facebook")).app_secret;
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    return new Response("invalid signature", { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const events: Array<{ leadgenId: string; formId?: string; adId?: string; createdTime?: string }> = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "leadgen") continue;
      const v = change.value ?? {};
      if (v.leadgen_id) {
        events.push({
          leadgenId: String(v.leadgen_id),
          formId: v.form_id ? String(v.form_id) : undefined,
          adId: v.ad_id ? String(v.ad_id) : undefined,
          createdTime: v.created_time ? new Date(v.created_time * 1000).toISOString() : undefined,
        });
      }
    }
  }

  // Ack fast even if individual fetches fail (Meta retries on non-200).
  for (const e of events) {
    try {
      await ingestFacebookLead(await getFacebookLead(e.leadgenId));
    } catch (err) {
      console.error("[fb webhook] ingest failed", e.leadgenId, err);
    }
  }

  return Response.json({ ok: true, received: events.length });
}

function verifySignature(raw: string, header: string | null, appSecret: string | null): boolean {
  if (!appSecret) {
    if (env.NODE_ENV === "production") return false;
    console.warn("[fb webhook] Facebook app secret unset — skipping signature check (dev only)");
    return true;
  }
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  const a = Buffer.from(header.slice("sha256=".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
