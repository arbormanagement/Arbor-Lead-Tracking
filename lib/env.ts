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

    NEXTAUTH_SECRET: z.string().min(1),
    NEXTAUTH_URL: z.string().url().optional(),
    ADMIN_EMAIL: z.string().email(),
    ADMIN_PASSWORD_HASH: z.string().optional(),

    COOKIE_SIGNING_SECRET: z.string().min(16),

    TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_API_KEY_SID: z.string().startsWith("SK").optional(),
    TWILIO_API_KEY_SECRET: z.string().optional(),
    TWILIO_DEFAULT_DESTINATION: z.string().default("+16188368004"),
    TWILIO_VOICE_WEBHOOK_BASE: z.string().url().optional(),

    DEEPGRAM_API_KEY: z.string().optional(),
    BLOB_READ_WRITE_TOKEN: z.string().optional(),

    ARBOR_MCP_URL: z.string().url().default("https://arbor-mcp.up.railway.app/mcp"),
    ARBOR_MCP_TOKEN: z.string().optional(),

    FB_AD_ACCOUNT_ID: z.string().optional(),
    GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
    GA4_PROPERTY_ID: z.string().optional(),
    FACEBOOK_VERIFY_TOKEN: z.string().optional(),

    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),
  },
  client: {},
  // Next.js inlines process.env at build; pass through explicitly.
  runtimeEnv: {
    APP_BASE_URL: process.env.APP_BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH,
    COOKIE_SIGNING_SECRET: process.env.COOKIE_SIGNING_SECRET,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
    TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
    TWILIO_DEFAULT_DESTINATION: process.env.TWILIO_DEFAULT_DESTINATION,
    TWILIO_VOICE_WEBHOOK_BASE: process.env.TWILIO_VOICE_WEBHOOK_BASE,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    ARBOR_MCP_URL: process.env.ARBOR_MCP_URL,
    ARBOR_MCP_TOKEN: process.env.ARBOR_MCP_TOKEN,
    FB_AD_ACCOUNT_ID: process.env.FB_AD_ACCOUNT_ID,
    GOOGLE_ADS_CUSTOMER_ID: process.env.GOOGLE_ADS_CUSTOMER_ID,
    GA4_PROPERTY_ID: process.env.GA4_PROPERTY_ID,
    FACEBOOK_VERIFY_TOKEN: process.env.FACEBOOK_VERIFY_TOKEN,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
  },
  // Allow `npm run build` / lint without a full env (skips validation when set).
  skipValidation:
    !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === "lint",
  emptyStringAsUndefined: true,
});
