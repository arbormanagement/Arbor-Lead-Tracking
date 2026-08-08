import { getPlatformCreds } from "@/lib/credentials";
import { fetchWithRetry } from "./http";
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
  pageId: string;
}

// Arbor's Facebook Page — the default lead-form source when page_id isn't set.
const DEFAULT_PAGE_ID = "118081174908694";

async function fbConfig(): Promise<FbConfig> {
  const c = await getPlatformCreds("facebook");
  if (!c.access_token) throw new Error("Facebook access token is not configured");
  if (!c.ad_account_id) throw new Error("Facebook ad account id is not configured");
  return {
    accessToken: c.access_token,
    adAccountId: c.ad_account_id,
    apiVersion: c.api_version || "v21.0",
    pageId: c.page_id || DEFAULT_PAGE_ID,
  };
}

// Page-scoped reads (lead forms + their leads) require a PAGE access token, not the
// system-user token (Graph #190). Exchange the system-user token for the page token
// via GET /{page}?fields=access_token, cached ~10min (page tokens are long-lived).
let cachedPageToken: { pageId: string; token: string; at: number } | null = null;

async function getPageAccessToken(cfg: FbConfig): Promise<string> {
  const now = Date.now();
  if (cachedPageToken && cachedPageToken.pageId === cfg.pageId && now - cachedPageToken.at < 600_000) {
    return cachedPageToken.token;
  }
  const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.pageId}`);
  url.searchParams.set("fields", "access_token");
  url.searchParams.set("access_token", cfg.accessToken);
  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Facebook page token ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) {
    throw new Error("Facebook: no Page access token returned — the token needs access to the Page (pages_show_list + page assignment)");
  }
  cachedPageToken = { pageId: cfg.pageId, token: j.access_token, at: now };
  return j.access_token;
}

class FacebookProvider implements SpendProvider {
  readonly name = "facebook:direct";
  readonly platforms: SpendRow["platform"][] = ["facebook"];

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
      const res = await fetchWithRetry(next, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Facebook ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { data?: Array<Record<string, any>>; paging?: { next?: string } };
      for (const r of body.data ?? []) {
        // ad_spend.external_campaign_id is NOT NULL — an insights row missing its
        // campaign id can't be keyed, so skip it rather than write junk.
        if (!r.campaign_id) {
          console.warn("[facebook] skipping spend row without campaign_id", r.date_start);
          continue;
        }
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

  /**
   * Conversions API: send server-side conversion events (closed-loop feedback).
   * Each event carries an `event_id` (`${leadId}:${event}`) so Meta DEDUPES across
   * retries — safe to re-send. Matches on hashed email/phone + `fbc` (derived from
   * the stored fbclid). Uses the Conversions pixel/dataset id + its token (falls
   * back to the ads access token). Sends the batch in one call.
   */
  async sendConversions(events: CapiEvent[]): Promise<{ ok: boolean; error?: string; raw?: unknown }> {
    if (!events.length) return { ok: true };
    const c = await getPlatformCreds("facebook");
    const pixelId = c.conversions_pixel_id;
    const token = c.access_token; // one System User token (with ads_management) writes CAPI
    const apiVersion = c.api_version || "v21.0";
    if (!pixelId) return { ok: false, error: "Facebook Conversions pixel/dataset id not configured" };
    if (!token) return { ok: false, error: "Facebook Conversions access token not configured" };

    const data = events.map((e) => ({
      event_name: e.eventName,
      event_time: e.eventTime,
      action_source: e.actionSource,
      event_id: e.eventId,
      user_data: pruneEmpty({
        em: e.emailHash ? [e.emailHash] : undefined,
        ph: e.phoneHash ? [e.phoneHash] : undefined,
        fbc: e.fbc,
        // Lead-gen form submissions match by Meta's own lead id (Conversion Leads
        // / CRM integration) — they have no click id. Integer per the CAPI spec;
        // fall back to the raw string if it would overflow a JS safe integer.
        lead_id: e.leadgenId
          ? Number.isSafeInteger(Number(e.leadgenId))
            ? Number(e.leadgenId)
            : e.leadgenId
          : undefined,
      }),
      custom_data: { value: e.valueDollars, currency: e.currency ?? "USD" },
    }));

    try {
      const res = await fetchWithRetry(`https://graph.facebook.com/${apiVersion}/${pixelId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, access_token: token }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = await res.json();
      if (!res.ok) return { ok: false, error: `Facebook CAPI ${res.status}: ${JSON.stringify(json)}`, raw: json };
      return { ok: true, raw: json };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * List the pixels/datasets on the ad account so the UI can offer the Conversions
   * API id as a pick-list instead of a manual hunt in Events Manager. Uses the same
   * ads access token (needs ads_read on the account/pixel).
   */
  async listPixels(): Promise<FbPixel[]> {
    const cfg = await fbConfig();
    const found = new Map<string, string>();

    const pull = async (path: string, tolerant: boolean) => {
      const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${path}`);
      url.searchParams.set("fields", "id,name");
      url.searchParams.set("access_token", cfg.accessToken);
      const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        if (tolerant) return; // best-effort secondary source
        throw new Error(`Facebook ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
      for (const p of body.data ?? []) found.set(String(p.id), p.name ?? String(p.id));
    };

    // 1) Pixels/datasets assigned directly to the ad account.
    await pull(`${cfg.adAccountId}/adspixels`, false);

    // 2) Datasets usually live at the Business level (not the ad account) — resolve the
    //    owning business and merge its pixels too. Best-effort; needs business_management.
    try {
      const bizUrl = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.adAccountId}`);
      bizUrl.searchParams.set("fields", "business");
      bizUrl.searchParams.set("access_token", cfg.accessToken);
      const bizRes = await fetchWithRetry(bizUrl, { signal: AbortSignal.timeout(30_000) });
      if (bizRes.ok) {
        const j = (await bizRes.json()) as { business?: { id?: string } };
        if (j.business?.id) await pull(`${j.business.id}/adspixels`, true);
      }
    } catch {
      // ignore — the ad-account list is the primary source
    }

    return [...found].map(([id, name]) => ({ id, name }));
  }

  /** Lead-gen forms on the page (id, name, status). Needs leads_retrieval + page access. */
  async listLeadForms(): Promise<FbLeadForm[]> {
    const cfg = await fbConfig();
    const pageToken = await getPageAccessToken(cfg);
    const out: FbLeadForm[] = [];
    const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.pageId}/leadgen_forms`);
    url.searchParams.set("fields", "id,name,status,leads_count");
    url.searchParams.set("limit", "200");
    url.searchParams.set("access_token", pageToken);
    let next: string | null = url.toString();
    for (let guard = 0; next && guard < 25; guard++) {
      const res = await fetchWithRetry(next, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Facebook forms ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { data?: Array<{ id: string; name?: string; status?: string; leads_count?: number }>; paging?: { next?: string } };
      for (const f of body.data ?? []) {
        out.push({ id: String(f.id), name: f.name ?? String(f.id), status: f.status ?? "UNKNOWN", leadsCount: f.leads_count ?? 0 });
      }
      next = body.paging?.next ?? null;
    }
    return out;
  }

  /**
   * Leads submitted to a lead form, optionally only those created after `sinceUnix`
   * (seconds). Polled on a schedule as an alternative to the webhook — so we ingest
   * FB leads without touching the page's existing (Replit) webhook subscription.
   * field_data comes back inline, so no per-lead fetch is needed.
   */
  async listFormLeads(formId: string, sinceUnix?: number): Promise<FbLeadDetail[]> {
    const cfg = await fbConfig();
    const pageToken = await getPageAccessToken(cfg);
    const first = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${formId}/leads`);
    // NOTE: campaign_id is NOT a readable field on the lead node — requesting it 400s
    // the whole call. We carry ad_id and resolve the campaign from it below.
    first.searchParams.set("fields", "id,created_time,field_data,ad_id,form_id");
    first.searchParams.set("limit", "200");
    if (sinceUnix) {
      first.searchParams.set("filtering", JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnix }]));
    }
    first.searchParams.set("access_token", pageToken);

    const out: FbLeadDetail[] = [];
    let next: string | null = first.toString();
    for (let guard = 0; next && guard < 25; guard++) {
      const res = await fetchWithRetry(next, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Facebook leads ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        data?: Array<{ id: string; created_time?: string; field_data?: Array<{ name: string; values: string[] }>; ad_id?: string; form_id?: string }>;
        paging?: { next?: string };
      };
      for (const l of body.data ?? []) {
        out.push({
          leadgenId: String(l.id),
          formId: l.form_id ? String(l.form_id) : formId,
          adId: l.ad_id ? String(l.ad_id) : undefined,
          createdTime: l.created_time,
          fieldData: l.field_data ?? [],
        });
      }
      next = body.paging?.next ?? null;
    }

    // Resolve campaign from ad_id (once per distinct ad) so leads still attribute to
    // a campaign. Best-effort — a failed lookup just leaves the lead at facebook/paid.
    const adToCampaign = new Map<string, string | undefined>();
    for (const d of out) {
      if (!d.adId) continue;
      if (!adToCampaign.has(d.adId)) adToCampaign.set(d.adId, await this.campaignForAd(cfg, d.adId));
      d.campaignId = adToCampaign.get(d.adId);
    }
    return out;
  }

  private async campaignForAd(cfg: FbConfig, adId: string): Promise<string | undefined> {
    try {
      const url = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${adId}`);
      url.searchParams.set("fields", "campaign_id");
      url.searchParams.set("access_token", cfg.accessToken);
      const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return undefined;
      const j = (await res.json()) as { campaign_id?: string };
      return j.campaign_id ? String(j.campaign_id) : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface FbPixel {
  id: string;
  name: string;
}

export interface FbLeadForm {
  id: string;
  name: string;
  status: string;
  leadsCount: number;
}

function pruneEmpty<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export interface CapiEvent {
  /** Meta standard events. "Schedule" = the estimate visit got a date. */
  eventName: "Lead" | "Schedule" | "Purchase";
  eventTime: number; // unix seconds
  actionSource: "phone_call" | "website" | "system_generated";
  eventId: string; // dedup key
  emailHash?: string | null;
  phoneHash?: string | null;
  fbc?: string; // fb.1.<ts>.<fbclid> — website-click leads
  leadgenId?: string; // Meta leadgen id — lead-form leads (no click id exists)
  valueDollars: number;
  currency?: string;
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

  const res = await fetchWithRetry(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Facebook lead ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as Record<string, any>;

  let campaignId: string | undefined = j.campaign_id;
  if (!campaignId && j.ad_id) {
    try {
      const adUrl = new URL(`https://graph.facebook.com/${cfg.apiVersion}/${j.ad_id}`);
      adUrl.searchParams.set("fields", "campaign_id");
      adUrl.searchParams.set("access_token", cfg.accessToken);
      const adRes = await fetchWithRetry(adUrl, { signal: AbortSignal.timeout(30_000) });
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
