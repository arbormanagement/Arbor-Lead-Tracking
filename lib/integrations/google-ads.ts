import { getPlatformCreds } from "@/lib/credentials";
import { parseWallTime } from "@/lib/tz";
import { fetchWithRetry } from "./http";
import type { SpendProvider, SpendRow } from "./types";

/**
 * Direct Google Ads client over REST (no heavy SDK). Credentials come from the
 * in-app resolver (DB over env). Flow: exchange the offline refresh token for an
 * access token, then POST GAQL to googleAds:searchStream.
 *
 * cost_micros are millionths of the account currency → cents = micros / 10_000.
 * Bump GOOGLE_ADS_API_VERSION as Google deprecates versions (~yearly).
 */
const GOOGLE_ADS_API_VERSION = "v24";

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
  readonly platforms: SpendRow["platform"][] = ["google", "google_lsa"];

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
    const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: "refresh_token",
      }),
    }, { timeoutMs: 30_000 });
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

    const res = await fetchWithRetry(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cfg.customerId}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query: gaql }) },
      { timeoutMs: 90_000 },
    );
    if (!res.ok) throw new Error(`Google Ads ${res.status}: ${await res.text()}`);
    const batches = (await res.json()) as Array<{ results?: Array<Record<string, any>> }>;
    return batches.flatMap((b) => b.results ?? []);
  }

  async getDailySpend({ sinceDays }: { sinceDays: number }): Promise<SpendRow[]> {
    const cfg = await this.config();
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // channel_type segments LSA out of regular Search/PMax spend: Local Services
    // campaigns are read-only in the Google Ads API but report cost like any other
    // campaign, so LSA spend lands under platform google_lsa → source google/lsa.
    const gaql = `
      SELECT campaign.id, campaign.name, campaign.advertising_channel_type, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${today}'`;

    const rows: SpendRow[] = [];
    for (const customerId of await this.spendCustomerIds(cfg)) {
      const results = await this.searchStream({ ...cfg, customerId }, gaql);
      for (const r of results) {
        // ad_spend.external_campaign_id is NOT NULL — a result missing its
        // campaign id (or date) can't be keyed, so skip it rather than write junk.
        if (r.campaign?.id == null || !r.segments?.date) {
          console.warn("[google-ads] skipping spend row without campaign id/date", JSON.stringify(r).slice(0, 300));
          continue;
        }
        rows.push({
          platform: (r.campaign.advertisingChannelType === "LOCAL_SERVICES" ? "google_lsa" : "google") as
            | "google"
            | "google_lsa",
          externalCampaignId: String(r.campaign.id),
          campaignName: r.campaign.name,
          date: r.segments.date,
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          spendCents: Math.round(Number(r.metrics?.costMicros ?? 0) / 10_000),
          conversions: Number(r.metrics?.conversions ?? 0),
          raw: r,
        });
      }
    }
    return rows;
  }

  /**
   * Accounts to read spend from: the main customer_id plus, when configured, the
   * separate LSA account (`lsa_customer_id`) — LSA lives in its own customer
   * account under the manager, so one query per account. De-duped in case both
   * creds point at the same account.
   */
  private async spendCustomerIds(cfg: GoogleAdsConfig): Promise<string[]> {
    const c = await getPlatformCreds("google_ads");
    const lsa = (c.lsa_customer_id || "").replace(/-/g, "");
    return [...new Set([cfg.customerId, lsa].filter(Boolean))] as string[];
  }

  /**
   * Local Services Ads leads. Best-effort field mapping — the local_services_lead
   * resource shape can vary; raw is retained.
   */
  async getLsaLeads({ sinceDays }: { sinceDays: number }): Promise<LsaLead[]> {
    const cfg = await this.config();
    // local_services_lead only exists in the LSA customer account — use the
    // dedicated lsa_customer_id when it's configured (else assume customer_id is it).
    const c = await getPlatformCreds("google_ads");
    if (c.lsa_customer_id) cfg.customerId = c.lsa_customer_id.replace(/-/g, "");
    // Server-side lower bound so each run reads only the window, not all history.
    // creation_date_time is a DATE_TIME field → "yyyy-MM-dd HH:mm:ss" literal.
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const gaql = `
      SELECT local_services_lead.id, local_services_lead.contact_details,
             local_services_lead.lead_type, local_services_lead.lead_status,
             local_services_lead.creation_date_time
      FROM local_services_lead
      WHERE local_services_lead.creation_date_time >= '${since} 00:00:00'`;
    const results = await this.searchStream(cfg, gaql);

    const cutoff = Date.now() - sinceDays * 86_400_000;
    const out: LsaLead[] = [];
    for (const r of results) {
      const l = r.localServicesLead ?? {};
      const cd = l.contactDetails ?? {};
      // NOT `new Date(...)`: the field is a bare "yyyy-MM-dd HH:mm:ss" in the
      // ACCOUNT's timezone, and Node would read an offset-less string as the
      // server's local time (UTC on Railway), filing every lead five hours early.
      const created = l.creationDateTime ? parseWallTime(l.creationDateTime) : null;
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
   * Enabled import (`UPLOAD_CLICKS`) conversion actions — the only valid OCI
   * upload targets — so Settings → Integrations can offer a pick-list instead of
   * hand-pasted ids.
   */
  async listConversionActions(): Promise<ConversionActionOption[]> {
    const cfg = await this.config();
    const gaql = `
      SELECT conversion_action.id, conversion_action.name, conversion_action.category
      FROM conversion_action
      WHERE conversion_action.status = 'ENABLED'
        AND conversion_action.type = 'UPLOAD_CLICKS'
      ORDER BY conversion_action.name`;
    const results = await this.searchStream(cfg, gaql);
    return results.map((r) => ({
      id: String(r.conversionAction?.id ?? ""),
      name: String(r.conversionAction?.name ?? ""),
      category: r.conversionAction?.category ?? null,
    }));
  }
}

export interface ConversionActionOption {
  id: string;
  name: string;
  category: string | null;
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
