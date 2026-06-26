import { env } from "@/lib/env";
import type { SpendProvider, SpendRow } from "./types";

/**
 * Direct Google Ads client over REST (no heavy SDK). Flow:
 *   1. Exchange the offline refresh token for a short-lived access token.
 *   2. POST a GAQL query to googleAds:searchStream for campaign-level daily spend.
 *
 * cost_micros are millionths of the account currency → cents = micros / 10_000.
 * Bump GOOGLE_ADS_API_VERSION as Google deprecates versions (~yearly).
 */
const GOOGLE_ADS_API_VERSION = "v18";

class GoogleAdsProvider implements SpendProvider {
  readonly name = "google_ads:direct";

  private async accessToken(): Promise<string> {
    const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } = env;
    if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN) {
      throw new Error("Google Ads OAuth env (client id/secret/refresh token) is incomplete");
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_ADS_CLIENT_ID,
        client_secret: GOOGLE_ADS_CLIENT_SECRET,
        refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error("Google OAuth returned no access_token");
    return json.access_token;
  }

  async getDailySpend({ sinceDays }: { sinceDays: number }): Promise<SpendRow[]> {
    const customerId = (env.GOOGLE_ADS_CUSTOMER_ID ?? "").replace(/-/g, "");
    if (!customerId) throw new Error("GOOGLE_ADS_CUSTOMER_ID is not set");
    if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN is not set");

    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const gaql = `
      SELECT campaign.id, campaign.name, segments.date,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${since}' AND '${today}'`;

    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
      "Content-Type": "application/json",
    };
    if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
      headers["login-customer-id"] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, "");
    }

    const res = await fetch(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query: gaql }), signal: AbortSignal.timeout(90_000) },
    );
    if (!res.ok) throw new Error(`Google Ads ${res.status}: ${await res.text()}`);

    // searchStream returns an array of { results: [...] } batches.
    const batches = (await res.json()) as Array<{ results?: Array<Record<string, any>> }>;
    const rows: SpendRow[] = [];
    for (const batch of batches) {
      for (const r of batch.results ?? []) {
        rows.push({
          platform: "google",
          externalCampaignId: String(r.campaign?.id),
          campaignName: r.campaign?.name,
          date: r.segments?.date,
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
}

export const googleAds = new GoogleAdsProvider();
