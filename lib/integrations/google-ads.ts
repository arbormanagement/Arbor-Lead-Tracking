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
      rows.push(
        ...results.map((r) => ({
          platform: (r.campaign?.advertisingChannelType === "LOCAL_SERVICES" ? "google_lsa" : "google") as
            | "google"
            | "google_lsa",
          externalCampaignId: String(r.campaign?.id),
          campaignName: r.campaign?.name,
          date: r.segments?.date,
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          spendCents: Math.round(Number(r.metrics?.costMicros ?? 0) / 10_000),
          conversions: Number(r.metrics?.conversions ?? 0),
          raw: r,
        })),
      );
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
              // Exactly one click identifier per conversion. gbraid/wbraid are the
              // iOS/Safari replacements for gclid; Google rejects a conversion that
              // pairs either with user_identifiers (Enhanced Conversions for Leads),
              // which we never send — click-id matching only.
              ...(it.gclid ? { gclid: it.gclid } : it.gbraid ? { gbraid: it.gbraid } : { wbraid: it.wbraid }),
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

export interface ConversionActionOption {
  id: string;
  name: string;
  category: string | null;
}

export interface ClickConversionInput {
  /** Exactly one of gclid / gbraid / wbraid. */
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
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
