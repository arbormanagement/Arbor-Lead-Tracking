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
      // Two valid auth shapes: API Key (SK SID + secret) or Account SID + Auth Token.
      const hasApiKey = !!(c.api_key_sid && c.api_key_secret);
      const user = hasApiKey ? c.api_key_sid! : c.account_sid;
      const pass = hasApiKey ? c.api_key_secret! : c.auth_token;
      if (!user || !pass) {
        return {
          ok: false,
          error: "Enter either an API Key SID + Secret, or an Account SID + Auth Token",
        };
      }
      const basic = Buffer.from(`${user}:${pass}`).toString("base64");
      // If we have the Account SID, verify it directly. Otherwise (API-key-only) list
      // accounts the key can reach — Twilio requires the Account SID in the path, so
      // this both validates the key and discovers the account without forcing the user
      // to also paste the (non-secret) Account SID just to run a connectivity test.
      const url = c.account_sid
        ? `https://api.twilio.com/2010-04-01/Accounts/${c.account_sid}.json`
        : `https://api.twilio.com/2010-04-01/Accounts.json?PageSize=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Basic ${basic}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return {
        ok: true,
        detail: c.account_sid
          ? "Account reachable"
          : "API key valid — also save your Account SID (AC…) to enable call tracking",
      };
    }
    default:
      return { ok: false, error: "unknown platform" };
  }
}
