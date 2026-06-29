import { z } from "zod";
import { getSession } from "@/lib/auth";
import { getPlatformCreds } from "@/lib/credentials";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Lightweight connectivity probe per platform using the resolved (DB-or-env)
 * credentials, so Justin gets immediate feedback after entering keys. Each probe is
 * the cheapest authenticated call that proves the credential works.
 */
const Body = z.object({ platform: z.string() });

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid input" }, { status: 400 });

  try {
    const ok = await probe(parsed.data.platform);
    return Response.json(ok);
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function probe(platform: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const c = await getPlatformCreds(platform);

  switch (platform) {
    case "housecallpro": {
      if (!c.api_key) return { ok: false, error: "API key not set" };
      const base = c.api_base || "https://api.housecallpro.com";
      const res = await fetch(new URL("/customers?page=1&page_size=1", base), {
        headers: { Authorization: `Token ${c.api_key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? { ok: true, detail: "Authenticated" } : { ok: false, error: `HTTP ${res.status}` };
    }
    case "google_ads": {
      if (!c.refresh_token || !c.client_id || !c.client_secret) return { ok: false, error: "OAuth fields incomplete" };
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: c.client_id,
          client_secret: c.client_secret,
          refresh_token: c.refresh_token,
          grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? { ok: true, detail: "Token refresh OK" } : { ok: false, error: `OAuth ${res.status}` };
    }
    case "facebook": {
      if (!c.access_token || !c.ad_account_id) return { ok: false, error: "Access token / ad account not set" };
      const v = c.api_version || "v21.0";
      const url = new URL(`https://graph.facebook.com/${v}/${c.ad_account_id}`);
      url.searchParams.set("fields", "name");
      url.searchParams.set("access_token", c.access_token);
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return res.ok ? { ok: true, detail: "Ad account reachable" } : { ok: false, error: `Graph ${res.status}` };
    }
    case "deepgram": {
      if (!c.api_key) return { ok: false, error: "API key not set" };
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${c.api_key}` },
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? { ok: true, detail: "Authenticated" } : { ok: false, error: `HTTP ${res.status}` };
    }
    case "twilio": {
      if (!c.account_sid) return { ok: false, error: "Account SID not set" };
      const user = c.api_key_sid && c.api_key_secret ? c.api_key_sid : c.account_sid;
      const pass = c.api_key_sid && c.api_key_secret ? c.api_key_secret : c.auth_token;
      if (!pass) return { ok: false, error: "Auth token / API key secret not set" };
      const basic = Buffer.from(`${user}:${pass}`).toString("base64");
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}.json`, {
        headers: { Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(20_000),
      });
      return res.ok ? { ok: true, detail: "Account reachable" } : { ok: false, error: `HTTP ${res.status}` };
    }
    default:
      return { ok: false, error: "unknown platform" };
  }
}
