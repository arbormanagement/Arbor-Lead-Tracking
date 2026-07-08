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
      { key: "api_key", label: "API Key", secret: true, envKey: "HCP_API_KEY" },
      { key: "api_base", label: "API Base URL", envKey: "HCP_API_BASE", placeholder: "https://api.housecallpro.com" },
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
      // Offline conversion import targets (leave blank to disable that event).
      { key: "conversion_action_qualified", label: "Conv. action — Qualified Lead (ID or resource name)", envKey: "GOOGLE_ADS_CONV_QUALIFIED", placeholder: "e.g. 7259060772" },
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
    platform: "twilio",
    label: "Twilio (call tracking)",
    fields: [
      { key: "account_sid", label: "Account SID", secret: true, envKey: "TWILIO_ACCOUNT_SID", placeholder: "AC…" },
      { key: "auth_token", label: "Auth Token", secret: true, envKey: "TWILIO_AUTH_TOKEN" },
      { key: "api_key_sid", label: "API Key SID (optional)", secret: true, envKey: "TWILIO_API_KEY_SID", placeholder: "SK…" },
      { key: "api_key_secret", label: "API Key Secret (optional)", secret: true, envKey: "TWILIO_API_KEY_SECRET" },
      { key: "default_destination", label: "Default forward number", envKey: "TWILIO_DEFAULT_DESTINATION", placeholder: "+16188368004" },
      { key: "voice_webhook_base", label: "Webhook base (optional)", envKey: "TWILIO_VOICE_WEBHOOK_BASE", placeholder: "https://app…/api/twilio" },
    ],
  },
];

export function getSpec(platform: string): CredSpec | undefined {
  return CREDENTIAL_SPECS.find((s) => s.platform === platform);
}
