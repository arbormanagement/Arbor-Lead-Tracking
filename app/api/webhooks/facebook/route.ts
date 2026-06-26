import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { campaigns, facebookLeads, leads, sources } from "@/lib/db/schema";
import { getFacebookLead } from "@/lib/integrations/facebook";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
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
export function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === env.FACEBOOK_VERIFY_TOKEN) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"))) {
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
      await ingestLead(e.leadgenId);
    } catch (err) {
      console.error("[fb webhook] ingest failed", e.leadgenId, err);
    }
  }

  return Response.json({ ok: true, received: events.length });
}

async function ingestLead(leadgenId: string) {
  // Idempotent on fb_leadgen_id (Meta redelivers).
  const existing = await db
    .select({ id: facebookLeads.id })
    .from(facebookLeads)
    .where(eq(facebookLeads.fbLeadgenId, leadgenId))
    .limit(1);
  if (existing.length) return;

  const detail = await getFacebookLead(leadgenId);
  const c = mapFbFields(detail.fieldData);
  const sourceId = await getOrCreateSource("facebook/paid");
  const campaignId = detail.campaignId ? await resolveCampaign(detail.campaignId, sourceId) : null;
  const occurredAt = detail.createdTime ? new Date(detail.createdTime) : new Date();

  const [lead] = await db
    .insert(leads)
    .values({
      type: "facebook_leadgen",
      status: "new",
      name: c.name,
      phoneE164: normalizePhone(c.phone),
      emailLc: normalizeEmail(c.email),
      message: c.message,
      sourceId,
      medium: "paid",
      campaignId,
      occurredAt,
    })
    .returning({ id: leads.id });

  await db.insert(facebookLeads).values({
    leadId: lead.id,
    fbLeadgenId: detail.leadgenId,
    fbFormId: detail.formId,
    fbAdId: detail.adId,
    fbCampaignId: detail.campaignId,
    fields: Object.fromEntries(detail.fieldData.map((f) => [f.name, f.values?.[0] ?? ""])),
    createdTime: occurredAt,
  });
}

function verifySignature(raw: string, header: string | null): boolean {
  if (!env.FACEBOOK_APP_SECRET) {
    if (env.NODE_ENV === "production") return false;
    console.warn("[fb webhook] FACEBOOK_APP_SECRET unset — skipping signature check (dev only)");
    return true;
  }
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", env.FACEBOOK_APP_SECRET).update(raw).digest("hex");
  const a = Buffer.from(header.slice("sha256=".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mapFbFields(fieldData: Array<{ name: string; values: string[] }>) {
  const get = (needles: string[]) => {
    for (const f of fieldData) {
      const n = f.name.toLowerCase();
      if (needles.some((x) => n.includes(x)) && f.values?.[0]) return f.values[0];
    }
    return null;
  };
  const first = get(["first_name", "first name"]);
  const last = get(["last_name", "last name"]);
  const stitched = [first, last].filter(Boolean).join(" ") || null;
  return {
    name: get(["full_name", "full name", "name"]) ?? stitched,
    email: get(["email"]),
    phone: get(["phone", "telefono", "mobile"]),
    message: get(["message", "comment", "detail", "describe", "project"]),
  };
}

async function getOrCreateSource(key: string): Promise<string | null> {
  await db.insert(sources).values({ key, displayName: key, platform: "facebook" }).onConflictDoNothing({ target: sources.key });
  const [s] = await db.select({ id: sources.id }).from(sources).where(eq(sources.key, key)).limit(1);
  return s?.id ?? null;
}

async function resolveCampaign(externalId: string, sourceId: string | null): Promise<string | null> {
  await db
    .insert(campaigns)
    .values({ platform: "facebook", externalCampaignId: externalId, sourceId })
    .onConflictDoNothing({ target: [campaigns.platform, campaigns.externalCampaignId] });
  const [c] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.platform, "facebook"), eq(campaigns.externalCampaignId, externalId)))
    .limit(1);
  return c?.id ?? null;
}
