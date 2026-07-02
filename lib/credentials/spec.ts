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
      { key: "access_token", label: "Access Token (ads_read)", secret: true, envKey: "FACEBOOK_ACCESS_TOKEN" },
      { key: "app_secret", label: "App Secret (webhook)", secret: true, envKey: "FACEBOOK_APP_SECRET" },
      { key: "verify_token", label: "Webhook Verify Token", envKey: "FACEBOOK_VERIFY_TOKEN" },
      { key: "ad_account_id", label: "Ad Account ID", envKey: "FB_AD_ACCOUNT_ID", placeholder: "act_…" },
      { key: "api_version", label: "API Version", envKey: "FACEBOOK_API_VERSION", placeholder: "v21.0" },
      // Conversions API (closed-loop). Pixel/dataset id + a token that can write to
      // it (ads_management / dataset token). Leave pixel blank to disable CAPI export.
      { key: "conversions_pixel_id", label: "Conversions API — Pixel/Dataset ID", envKey: "FACEBOOK_PIXEL_ID" },
      { key: "conversions_token", label: "Conversions API — Access Token (optional)", secret: true, envKey: "FACEBOOK_CONVERSIONS_TOKEN" },
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
