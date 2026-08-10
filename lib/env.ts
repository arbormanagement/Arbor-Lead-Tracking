import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Centralized, validated environment access. Import `env` instead of reading
 * `process.env` directly so a missing/blank var fails fast at boot rather than
 * surfacing as a confusing runtime error inside a webhook.
 *
 * Server-only vars are deliberately NOT exposed to the client. There are no
 * NEXT_PUBLIC_* values yet — the tracking snippet talks to relative API routes.
 */
export const env = createEnv({
  server: {
    APP_BASE_URL: z.string().url(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: z.string().url(),
    DATABASE_URL_UNPOOLED: z.string().url().optional(),
    // `pg` = long-lived node-postgres pool (default; right for a persistent
    // server). `neon-http` = Neon's stateless HTTPS driver, for serverless/edge
    // or networks that block raw Postgres TCP. See lib/db/client.ts.
    DB_DRIVER: z.enum(["pg", "neon-http"]).default("pg"),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

    // Vestigial: auth is HMAC session cookie + scrypt (lib/auth.ts), which uses
    // COOKIE_SIGNING_SECRET. Nothing reads these. Kept (optional) rather than
    // deleted so an existing deployment that still sets them doesn't fail
    // validation — but no longer REQUIRED, which made an unused variable able to
    // block boot.
    NEXTAUTH_SECRET: z.string().optional(),
    NEXTAUTH_URL: z.string().url().optional(),
    ADMIN_EMAIL: z.string().email(),
    ADMIN_PASSWORD_HASH: z.string().optional(),

    COOKIE_SIGNING_SECRET: z.string().min(16),
    // Root key for envelope-encrypting integration credentials at rest (32 bytes,
    // hex or base64). Required only to save/read DB-stored creds; absent → env fallback.
    CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),

    TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_API_KEY_SID: z.string().startsWith("SK").optional(),
    TWILIO_API_KEY_SECRET: z.string().optional(),
    TWILIO_DEFAULT_DESTINATION: z.string().default("+16188368004"),
    TWILIO_VOICE_WEBHOOK_BASE: z.string().url().optional(),
    // Where inbound texts are relayed. No default: the call default may point at
    // the voice agent, which cannot read a text (see lib/routing.ts).
    TWILIO_SMS_FORWARD_TO: z.string().optional(),

    DEEPGRAM_API_KEY: z.string().optional(),
    BLOB_READ_WRITE_TOKEN: z.string().optional(),

    // MCP server — retained as an optional per-platform fallback for the read path.
    ARBOR_MCP_URL: z.string().url().default("https://arbor-mcp.up.railway.app/mcp"),
    ARBOR_MCP_TOKEN: z.string().optional(),

    // ── Direct API credentials (primary read path) ──
    // HousecallPro (revenue source of truth) — simple API-key REST.
    HCP_API_BASE: z.string().url().default("https://api.housecallpro.com"),
    HCP_API_KEY: z.string().optional(),
    // Google Ads — OAuth2 refresh-token flow + developer token.
    GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
    GOOGLE_ADS_CLIENT_ID: z.string().optional(),
    GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
    GOOGLE_ADS_REFRESH_TOKEN: z.string().optional(),
    // Manager (MCC) account id, digits only, if calls go through a manager.
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),
    // Facebook Marketing API — long-lived access token.
    FACEBOOK_ACCESS_TOKEN: z.string().optional(),
    FACEBOOK_API_VERSION: z.string().default("v21.0"),
    // App secret — verifies X-Hub-Signature-256 on the lead-gen webhook.
    FACEBOOK_APP_SECRET: z.string().optional(),

    // Credential fields that lib/credentials/spec.ts offers an env fallback for.
    // envFallback() resolves through THIS validated object, not process.env — so a
    // spec envKey missing here is not a fallback that merely goes unused, it is one
    // that silently never works no matter what the host sets.
    GOOGLE_ADS_LSA_CUSTOMER_ID: z.string().optional(),
    GOOGLE_ADS_CONV_LEAD: z.string().optional(),
    GOOGLE_ADS_CONV_QUALIFIED: z.string().optional(),
    GOOGLE_ADS_CONV_SCHEDULED: z.string().optional(),
    GOOGLE_ADS_CONV_WON: z.string().optional(),
    FACEBOOK_PAGE_ID: z.string().optional(),
    FACEBOOK_PIXEL_ID: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

    FB_AD_ACCOUNT_ID: z.string().optional(),
    GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
    // Declared but unread — there is no GA4 integration. Left in place (optional,
    // so it costs nothing) as the placeholder it is; delete it if GA4 never lands.
    GA4_PROPERTY_ID: z.string().optional(),
    FACEBOOK_VERIFY_TOKEN: z.string().optional(),

    // Shared secret the cron worker sends (Authorization: Bearer) to trigger
    // /api/cron/* — keeps the sync jobs from being runnable by anyone.
    CRON_SECRET: z.string().optional(),

    // Machine credential for a narrow set of admin routes (see lib/admin-auth.ts).
    // Lets automation import a transferred number or set the routing default
    // without an interactive login. Deliberately NOT a general admin bypass:
    // each route opts in, and token callers cannot purchase numbers. Unset (the
    // default) disables token auth entirely — session-only, as before.
    ADMIN_API_TOKEN: z.string().min(24).optional(),

    // Injected by Railway at build: the commit this container is running. Purely
    // informational, surfaced by /api/diagnostics so "is the fix actually live?"
    // is a fact you can read rather than something inferred from whether some
    // new field happens to appear in a job's stats.
    RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
  },
  client: {},
  // Next.js inlines process.env at build; pass through explicitly.
  runtimeEnv: {
    APP_BASE_URL: process.env.APP_BASE_URL,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    DB_DRIVER: process.env.DB_DRIVER,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
    COOKIE_SIGNING_SECRET: process.env.COOKIE_SIGNING_SECRET,
    CREDENTIALS_ENCRYPTION_KEY: process.env.CREDENTIALS_ENCRYPTION_KEY,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
    TWILIO_DEFAULT_DESTINATION: process.env.TWILIO_DEFAULT_DESTINATION,
    TWILIO_VOICE_WEBHOOK_BASE: process.env.TWILIO_VOICE_WEBHOOK_BASE,
    TWILIO_SMS_FORWARD_TO: process.env.TWILIO_SMS_FORWARD_TO,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    ARBOR_MCP_URL: process.env.ARBOR_MCP_URL,
    ARBOR_MCP_TOKEN: process.env.ARBOR_MCP_TOKEN,
    HCP_API_BASE: process.env.HCP_API_BASE,
    HCP_API_KEY: process.env.HCP_API_KEY,
    GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_CLIENT_ID: process.env.GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: process.env.GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    FACEBOOK_ACCESS_TOKEN: process.env.FACEBOOK_ACCESS_TOKEN,
    FACEBOOK_API_VERSION: process.env.FACEBOOK_API_VERSION,
    FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET,
    GOOGLE_ADS_LSA_CUSTOMER_ID: process.env.GOOGLE_ADS_LSA_CUSTOMER_ID,
    GOOGLE_ADS_CONV_LEAD: process.env.GOOGLE_ADS_CONV_LEAD,
    GOOGLE_ADS_CONV_QUALIFIED: process.env.GOOGLE_ADS_CONV_QUALIFIED,
    GOOGLE_ADS_CONV_SCHEDULED: process.env.GOOGLE_ADS_CONV_SCHEDULED,
    GOOGLE_ADS_CONV_WON: process.env.GOOGLE_ADS_CONV_WON,
    FACEBOOK_PAGE_ID: process.env.FACEBOOK_PAGE_ID,
    FACEBOOK_PIXEL_ID: process.env.FACEBOOK_PIXEL_ID,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    FB_AD_ACCOUNT_ID: process.env.FB_AD_ACCOUNT_ID,
    GOOGLE_ADS_CUSTOMER_ID: process.env.GOOGLE_ADS_CUSTOMER_ID,
    GA4_PROPERTY_ID: process.env.GA4_PROPERTY_ID,
    FACEBOOK_VERIFY_TOKEN: process.env.FACEBOOK_VERIFY_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN,
  },
  // Allow `npm run build` / lint without a full env (skips validation when set).
  skipValidation:
    !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  emptyStringAsUndefined: true,
});
