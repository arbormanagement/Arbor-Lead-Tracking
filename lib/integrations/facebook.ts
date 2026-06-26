import { getPlatformCreds } from "@/lib/credentials";
import type { SpendProvider, SpendRow } from "./types";

/**
 * Direct Facebook/Instagram Marketing API client. Credentials come from the in-app
 * resolver (DB over env). Pulls per-day, per-campaign insights for a rolling window;
 * `spend` is a decimal string in account currency → cents = round(spend * 100).
 */
interface FbConfig {
  accessToken: string;
  adAccountId: string;
  apiVersion: string;
}

async function fbConfig(): Promise<FbConfig> {
  const c = await getPlatformCreds("facebook");
  if (!c.access_token) throw new Error("Facebook access token is not configured");
  if (!c.ad_account_id) throw new Error("Facebook ad account id is not configured");
  return { accessToken: c.access_token, adAccountId: c.ad_account_id, apiVersion: c.api_version || "v21.0" };
}

class FacebookProvider implements SpendProvider {
  readonly name = "facebook:direct";

  async getDailySpend({ sinceDays }: { sinceDays: number }): Promise<SpendRow[]> {
    const cfg = await fbConfig();
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);

    const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.adAccountId}/insights`);
    url.searchParams.set("level", "campaign");
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("fields", "campaign_id,campaign_name,impressions,clicks,spend,actions");
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
    url.searchParams.set("limit", "500");
    url.searchParams.set("access_token", cfg.accessToken);

    const rows: SpendRow[] = [];
    let next: string | null = url.toString();
    for (let guard = 0; next && guard < 50; guard++) {
      const res = await fetch(next, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Facebook ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { data?: Array<Record<string, any>>; paging?: { next?: string } };
      for (const r of body.data ?? []) {
        rows.push({
          platform: "facebook",
          externalCampaignId: String(r.campaign_id),
          campaignName: r.campaign_name,
          date: r.date_start,
          impressions: Number(r.impressions ?? 0),
          clicks: Number(r.clicks ?? 0),
          spendCents: Math.round(Number(r.spend ?? 0) * 100),
          conversions: sumLeadActions(r.actions),
          raw: r,
        });
      }
      next = body.paging?.next ?? null;
    }
    return rows;
  }
}

export interface FbLeadDetail {
  leadgenId: string;
  formId?: string;
  adId?: string;
  campaignId?: string;
  createdTime?: string;
  fieldData: Array<{ name: string; values: string[] }>;
}

/**
 * Fetch a lead-gen submission's full field data (the webhook carries only the
 * leadgen_id). Resolves the ad's campaign so the lead attributes to a campaign.
 */
export async function getFacebookLead(leadgenId: string): Promise<FbLeadDetail> {
  const cfg = await fbConfig();
  const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${leadgenId}`);
  url.searchParams.set("fields", "id,created_time,ad_id,form_id,campaign_id,field_data");
  url.searchParams.set("access_token", cfg.accessToken);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Facebook lead ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as Record<string, any>;

  let campaignId: string | undefined = j.campaign_id;
  if (!campaignId && j.ad_id) {
    try {
      const adUrl = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${j.ad_id}`);
      adUrl.searchParams.set("fields", "campaign_id");
      adUrl.searchParams.set("access_token", cfg.accessToken);
      const adRes = await fetch(adUrl, { signal: AbortSignal.timeout(30_000) });
      if (adRes.ok) campaignId = ((await adRes.json()) as { campaign_id?: string }).campaign_id;
    } catch {
      /* best effort */
    }
  }

  return {
    leadgenId: String(j.id ?? leadgenId),
    formId: j.form_id,
    adId: j.ad_id,
    campaignId,
    createdTime: j.created_time,
    fieldData: Array.isArray(j.field_data) ? j.field_data : [],
  };
}

function sumLeadActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  return actions
    .filter((a) => typeof a?.action_type === "string" && a.action_type.includes("lead"))
    .reduce((sum, a) => sum + Number(a.value ?? 0), 0);
}

export const facebook = new FacebookProvider();
