import { getPlatformCreds } from "@/lib/credentials";
import type { SpendProvider, SpendRow } from "./types";

/**
 * Direct Google Ads client over REST (no heavy SDK). Credentials come from the
 * in-app resolver (DB over env). Flow: exchange the offline refresh token for an
 * access token, then POST GAQL to googleAds:searchStream.
 *
 * cost_micros are millionths of the account currency → cents = micros / 10_000.
 * Bump GOOGLE_ADS_API_VERSION as Google deprecates versions (~yearly).
 */
const GOOGLE_ADS_API_VERSION = "v18";

interface GoogleAdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId?: string;
  customerId: string;
}

class GoogleAdsProvider implements SpendProvider {
  readonly name = "google_ads:direct";

  private async config(): Promise<GoogleAdsConfig> {
    const c = await getPlatformCreds("google_ads");
    if (!c.developer_token || !c.refresh_token || !c.client_id || !c.client_secret) {
      throw new Error("Google Ads credentials are incomplete");
    }
    if (!c.customer_id) throw new Error("Google Ads customer_id is not configured");
    return {
      developerToken: c.developer_token,
      clientId: c.client_id,
      clientSecret: c.client_secret,
      refreshToken: c.refresh_token,
      loginCustomerId: c.login_customer_id || undefined,
      customerId: c.customer_id.replace(/-/g, ""),
    };
  }

  private async accessToken(cfg: GoogleAdsConfig): Promise<string> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Google OAuth returned no access_token");
    return json.access_token;
  }

  private async searchStream(cfg: GoogleAdsConfig, gaql: string): Promise<Array<Record<string, any>>> {
    const token = await this.accessToken(cfg);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": cfg.developerToken,
      "Content-Type": "application/json",
    };
    if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId.replace(/-/g, "");

    const res = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cfg.customerId}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query: gaql }), signal: AbortSignal.timeout(90_000) },
    );
    if (!res.ok) throw new Error(`Google Ads ${res.status}: ${await res.text()}`);
    const batches = (await res.json()) as Array<{ results?: Array<Record<string, any>> }>;
    return batches.flatMap((b) => b.results ?? []);
  }

  async getDailySpend({ sinceDays }: { sinceDays: number }): Promise<SpendRow[]> {
    const cfg = await this.config();
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const gaql = `
      SELECT campaign.id, campaign.name, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${today}'`;

    const results = await this.searchStream(cfg, gaql);
    return results.map((r) => ({
      platform: "google" as const,
      externalCampaignId: String(r.campaign?.id),
      campaignName: r.campaign?.name,
      date: r.segments?.date,
      impressions: Number(r.metrics?.impressions ?? 0),
      clicks: Number(r.metrics?.clicks ?? 0),
      spendCents: Math.round(Number(r.metrics?.costMicros ?? 0) / 10_000),
      conversions: Number(r.metrics?.conversions ?? 0),
      raw: r,
    }));
  }

  /**
   * Local Services Ads leads. Best-effort field mapping — the local_services_lead
   * resource shape can vary; raw is retained.
   */
  async getLsaLeads({ sinceDays }: { sinceDays: number }): Promise<LsaLead[]> {
    const cfg = await this.config();
    const gaql = `
      SELECT local_services_lead.id, local_services_lead.contact_details,
             local_services_lead.lead_type, local_services_lead.lead_status,
             local_services_lead.creation_date_time
      FROM local_services_lead`;
    const results = await this.searchStream(cfg, gaql);

    const cutoff = Date.now() - sinceDays * 86_400_000;
    const out: LsaLead[] = [];
    for (const r of results) {
      const l = r.localServicesLead ?? {};
      const cd = l.contactDetails ?? {};
      const created = l.creationDateTime ? new Date(l.creationDateTime) : null;
      if (created && created.getTime() < cutoff) continue;
      out.push({
        id: String(l.id ?? ""),
        name: cd.consumerName ?? null,
        phone: cd.phoneNumber ?? null,
        email: cd.email ?? null,
        leadType: l.leadType ?? null,
        status: l.leadStatus ?? null,
        createdTime: created,
        raw: r,
      });
    }
    return out;
  }

  /**
   * Offline Conversion Import: upload gclid-matched conversions (closed-loop
   * feedback so Smart Bidding can optimize toward won revenue). Uploads ONE
   * conversion per request — at our volume that's fine, and it gives clean
   * per-item success/failure without parsing partial-failure indices, so the
   * caller's `conversion_exports` 'sent' guard can never double-count on retry.
   * Uses the existing adwords OAuth (the scope is read+write; no new token needed).
   */
  async uploadClickConversions(items: ClickConversionInput[]): Promise<UploadResult[]> {
    if (!items.length) return [];
    const cfg = await this.config();
    const token = await this.accessToken(cfg);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": cfg.developerToken,
      "Content-Type": "application/json",
    };
    if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId.replace(/-/g, "");

    const out: UploadResult[] = [];
    for (const it of items) {
      try {
        const body = {
          conversions: [
            {
              gclid: it.gclid,
              conversionAction: normalizeConversionAction(it.conversionAction, cfg.customerId),
              conversionDateTime: it.conversionDateTime,
              conversionValue: it.valueDollars,
              currencyCode: it.currencyCode ?? "USD",
            },
          ],
          partialFailure: true,
        };
        const res = await fetch(
          `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cfg.customerId}:uploadClickConversions`,
          { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) },
        );
        const json = (await res.json()) as { partialFailureError?: { message?: string } };
        if (!res.ok) {
          out.push({ ok: false, error: `Google Ads ${res.status}: ${JSON.stringify(json)}`, raw: json });
          continue;
        }
        if (json.partialFailureError) {
          out.push({ ok: false, error: json.partialFailureError.message ?? "partial failure", raw: json });
          continue;
        }
        out.push({ ok: true, raw: json });
      } catch (err) {
        out.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}

/** Accept either a full resource name or a bare numeric id from settings. */
function normalizeConversionAction(action: string, customerId: string): string {
  const a = action.trim();
  if (a.startsWith("customers/")) return a;
  return `customers/${customerId}/conversionActions/${a.replace(/[^0-9]/g, "")}`;
}

export interface ClickConversionInput {
  gclid: string;
  conversionAction: string; // resource name or bare numeric id
  conversionDateTime: string; // "yyyy-MM-dd HH:mm:ss+00:00"
  valueDollars: number;
  currencyCode?: string;
}

export interface UploadResult {
  ok: boolean;
  error?: string;
  raw?: unknown;
}

export interface LsaLead {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  leadType: string | null;
  status: string | null;
  createdTime: Date | null;
  raw?: unknown;
}

export const googleAds = new GoogleAdsProvider();
