/**
 * Registry of integration credentials managed in-app. Drives both the resolver's
 * env fallback (`envKey`) and the Settings UI form. Add a platform/field here and
 * it appears in both. Infrastructure secrets (DB, Twilio, cookie/root keys) are NOT
 * here — they stay in env by design.
 */
export interface CredField {
  key: string;
  label: string;
  secret?: boolean;
  envKey?: string;
  placeholder?: string;
}

export interface CredSpec {
  platform: string;
  label: string;
  fields: CredField[];
}

export const CREDENTIAL_SPECS: CredSpec[] = [
  {
    platform: "housecallpro",
    label: "HousecallPro",
    fields: [
      // API base defaults to https://api.housecallpro.com in code — only override in env
      // for a non-standard host, so it's not worth a form field.
      { key: "api_key", label: "API Key", secret: true, envKey: "HCP_API_KEY" },
    ],
  },
  {
    platform: "google_ads",
    label: "Google Ads",
    fields: [
      { key: "developer_token", label: "Developer Token", secret: true, envKey: "GOOGLE_ADS_DEVELOPER_TOKEN" },
      { key: "client_id", label: "OAuth Client ID", envKey: "GOOGLE_ADS_CLIENT_ID" },
      { key: "client_secret", label: "OAuth Client Secret", secret: true, envKey: "GOOGLE_ADS_CLIENT_SECRET" },
      { key: "refresh_token", label: "Refresh Token", secret: true, envKey: "GOOGLE_ADS_REFRESH_TOKEN" },
      { key: "login_customer_id", label: "Login (MCC) Customer ID", envKey: "GOOGLE_ADS_LOGIN_CUSTOMER_ID" },
      { key: "customer_id", label: "Customer ID", envKey: "GOOGLE_ADS_CUSTOMER_ID" },
      // LSA lives in its own customer account under the MCC. When set, spend sync
      // reads it too (cost lands under google/lsa) and LSA leads query it directly.
      { key: "lsa_customer_id", label: "LSA Customer ID (Local Services account)", envKey: "GOOGLE_ADS_LSA_CUSTOMER_ID", placeholder: "e.g. 123-456-7890" },
      // Offline conversion import targets (leave blank to disable that event).
      { key: "conversion_action_lead", label: "Conv. action — Lead (form or call)", envKey: "GOOGLE_ADS_CONV_LEAD", placeholder: "e.g. 7259060772" },
      { key: "conversion_action_qualified", label: "Conv. action — Qualified Lead (ID or resource name)", envKey: "GOOGLE_ADS_CONV_QUALIFIED", placeholder: "e.g. 7259060772" },
      { key: "conversion_action_scheduled", label: "Conv. action — Estimate Scheduled (ID or resource name)", envKey: "GOOGLE_ADS_CONV_SCHEDULED", placeholder: "e.g. 7259060772" },
      { key: "conversion_action_won", label: "Conv. action — Won Estimate (ID or resource name)", envKey: "GOOGLE_ADS_CONV_WON", placeholder: "e.g. customers/8300392986/conversionActions/…" },
    ],
  },
  {
    platform: "facebook",
    label: "Facebook / Instagram",
    fields: [
      // One System User token does everything: spend reads, CAPI conversion writes,
      // AND lead-form retrieval. Scope it ads_read + ads_management + leads_retrieval.
      { key: "access_token", label: "Access Token (System User: ads_read + ads_management + leads_retrieval)", secret: true, envKey: "FACEBOOK_ACCESS_TOKEN" },
      { key: "ad_account_id", label: "Ad Account ID", envKey: "FB_AD_ACCOUNT_ID", placeholder: "act_…" },
      // Page whose lead forms we poll (defaults to Arbor's page in code if blank).
      { key: "page_id", label: "Page ID (lead forms)", envKey: "FACEBOOK_PAGE_ID", placeholder: "118081174908694" },
      // Conversions API (closed-loop). Just the pixel/dataset id — the token above
      // (with ads_management) writes the events. Leave blank to disable CAPI export.
      { key: "conversions_pixel_id", label: "Conversions API — Pixel/Dataset ID", envKey: "FACEBOOK_PIXEL_ID" },
      // Lead-form webhook only. App Secret verifies Meta's payload signature (required
      // in prod so forged leads can't enter the pipeline); Verify Token is the handshake.
      { key: "app_secret", label: "App Secret (lead-form webhook)", secret: true, envKey: "FACEBOOK_APP_SECRET" },
      { key: "verify_token", label: "Verify Token (lead-form webhook)", envKey: "FACEBOOK_VERIFY_TOKEN" },
    ],
  },
  {
    platform: "deepgram",
    label: "Deepgram (transcription)",
    fields: [{ key: "api_key", label: "API Key", secret: true, envKey: "DEEPGRAM_API_KEY" }],
  },
  {
    platform: "anthropic",
    label: "Anthropic (call AI — is it a lead?)",
    fields: [{ key: "api_key", label: "API Key", secret: true, envKey: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…" }],
  },
  {
    platform: "twilio",
    label: "Twilio (call tracking)",
    fields: [
      { key: "account_sid", label: "Account SID", secret: true, envKey: "TWILIO_ACCOUNT_SID", placeholder: "AC…" },
      { key: "auth_token", label: "Auth Token", secret: true, envKey: "TWILIO_AUTH_TOKEN" },
      { key: "api_key_sid", label: "API Key SID (optional)", secret: true, envKey: "TWILIO_API_KEY_SID", placeholder: "SK…" },
      { key: "api_key_secret", label: "API Key Secret (optional)", secret: true, envKey: "TWILIO_API_KEY_SECRET" },
      // Default forward number lives in Settings → Routing (business config, not a
      // credential); webhook base is derived from APP_BASE_URL in code.
    ],
  },
];

export function getSpec(platform: string): CredSpec | undefined {
  return CREDENTIAL_SPECS.find((s) => s.platform === platform);
}
