import { env } from "@/lib/env";
import type { SpendProvider, SpendRow } from "./types";

/**
 * Direct Facebook/Instagram Marketing API client. Pulls per-day, per-campaign
 * insights for a rolling window. `spend` comes back as a decimal string in the
 * account currency → cents = round(spend * 100). Lead conversions are summed
 * from the `actions` breakdown.
 */
class FacebookProvider implements SpendProvider {
  readonly name = "facebook:direct";

  async getDailySpend({ sinceDays }: { sinceDays: number }): Promise<SpendRow[]> {
    if (!env.FACEBOOK_ACCESS_TOKEN) throw new Error("FACEBOOK_ACCESS_TOKEN is not set");
    if (!env.FB_AD_ACCOUNT_ID) throw new Error("FB_AD_ACCOUNT_ID is not set");

    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);

    const url = new URL(
      `https://graph.facebook.com/${env.FACEBOOK_API_VERSION}/${env.FB_AD_ACCOUNT_ID}/insights`,
    );
    url.searchParams.set("level", "campaign");
    url.searchParams.set("time_increment", "1");
    url.searchParams.set("fields", "campaign_id,campaign_name,impressions,clicks,spend,actions");
    url.searchParams.set("time_range", JSON.stringify({ since, until }));
    url.searchParams.set("limit", "500");
    url.searchParams.set("access_token", env.FACEBOOK_ACCESS_TOKEN);

    const rows: SpendRow[] = [];
    let next: string | null = url.toString();
    for (let guard = 0; next && guard < 50; guard++) {
      const res = await fetch(next, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Facebook ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        data?: Array<Record<string, any>>;
        paging?: { next?: string };
      };
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
 * Fetch a lead-gen submission's full field data. The webhook only carries the
 * leadgen_id, so we read the fields directly from the Graph API. Also resolves the
 * ad's campaign so the lead attributes to a campaign for ROI.
 */
export async function getFacebookLead(leadgenId: string): Promise<FbLeadDetail> {
  if (!env.FACEBOOK_ACCESS_TOKEN) throw new Error("FACEBOOK_ACCESS_TOKEN is not set");
  const v = env.FACEBOOK_API_VERSION;
  const url = new URL(`https://graph.facebook.com/${v}/${leadgenId}`);
  url.searchParams.set("fields", "id,created_time,ad_id,form_id,campaign_id,field_data");
  url.searchParams.set("access_token", env.FACEBOOK_ACCESS_TOKEN);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Facebook lead ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as Record<string, any>;

  let campaignId: string | undefined = j.campaign_id;
  if (!campaignId && j.ad_id) {
    // Some payloads omit campaign_id on the lead — resolve via the ad.
    try {
      const adUrl = new URL(`https://graph.facebook.com/${v}/${j.ad_id}`);
      adUrl.searchParams.set("fields", "campaign_id");
      adUrl.searchParams.set("access_token", env.FACEBOOK_ACCESS_TOKEN);
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
