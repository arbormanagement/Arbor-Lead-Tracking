/**
 * Google Workspace transport for the app's transactional mail, over the Gmail
 * REST API on plain fetch — no SDK, matching the house style of the SendGrid
 * module it replaces.
 *
 * WHY THE GMAIL API AND NOT SMTP: Workspace's SMTP relay authorizes senders by
 * IP or by an app password. Railway egress addresses are not static, so the IP
 * route is unavailable, and an app password is a long-lived shared secret on a
 * human's account. HTTPS with a scoped credential has neither problem and needs
 * no new dependency (raw SMTP would).
 *
 * NO DNS WORK WAS NEEDED: arbor-mgmt.com already publishes
 * `v=spf1 include:_spf.google.com ~all` and MXes to smtp.google.com, so
 * Workspace is an authorized sender for the domain. SendGrid was passing DMARC
 * on its DKIM signature alone (the em5670 CNAMEs); SPF never covered it.
 *
 * TWO AUTH MODES, because the app sends as TWO different mailboxes — call
 * summaries from info@ and review follow-ups from justin@:
 *
 *   1. SERVICE ACCOUNT + DOMAIN-WIDE DELEGATION (preferred). One credential
 *      impersonates any mailbox in the domain, so both senders work and there is
 *      no refresh token to re-consent. Set GOOGLE_WORKSPACE_SA_EMAIL and
 *      GOOGLE_WORKSPACE_SA_PRIVATE_KEY.
 *   2. OAUTH REFRESH TOKEN (fallback). Mirrors the Google Ads credential already
 *      in this repo. It authenticates ONE mailbox — a `from` other than that
 *      mailbox only works if Workspace has it as a verified "send mail as"
 *      alias, otherwise Gmail rejects the send.
 *
 * ⚠️ Use a SEPARATE OAuth client from GOOGLE_ADS_CLIENT_ID if you take mode 2.
 * CLAUDE.md records that the Ads client is shared with the Arbor MCP server and
 * that revoking its grant kills every token on it.
 */
import { createSign } from "node:crypto";
import { env } from "@/lib/env";
import { buildMimeMessage, toBase64Url } from "@/lib/email/mime";
import type { EmailMessage, EmailTransport, SendResult } from "@/lib/email/types";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

/** Refresh a minute early — a token that expires mid-flight reads as a 401. */
const EXPIRY_SKEW_MS = 60_000;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Railway (like most hosts) cannot hold a literal newline in a variable, so a PEM
 * is pasted with escaped \n. Undo that, or `createSign` rejects the key with an
 * error that names neither the cause nor the variable.
 */
function normalizePrivateKey(key: string): string {
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function exchange(body: Record<string, string>, cacheKey: string): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google OAuth rejected the token request (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("Google OAuth returned no access_token");

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/** Mode 1: signed JWT assertion, `sub` naming the mailbox to act as. */
async function serviceAccountToken(saEmail: string, privateKey: string, impersonate: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({
      iss: saEmail,
      sub: impersonate,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  ].join(".");

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(normalizePrivateKey(privateKey)).toString("base64url");

  return exchange(
    {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    },
    `sa:${saEmail}:${impersonate}`,
  );
}

/** Mode 2: the refresh-token grant, same shape as lib/integrations/google-ads.ts. */
async function refreshTokenToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  return exchange(
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    `oauth:${clientId}`,
  );
}

function serviceAccountConfigured(): boolean {
  return !!(env.GOOGLE_WORKSPACE_SA_EMAIL && env.GOOGLE_WORKSPACE_SA_PRIVATE_KEY);
}

function oauthConfigured(): boolean {
  return !!(
    env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID &&
    env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_WORKSPACE_OAUTH_REFRESH_TOKEN
  );
}

export function gmailDefaultSender(): string | undefined {
  return env.GOOGLE_WORKSPACE_SENDER ?? undefined;
}

export const gmailTransport: EmailTransport = {
  name: "gmail",

  configured(): boolean {
    // A sender is required either way: service-account mode needs a mailbox to
    // impersonate, and OAuth mode needs a From that matches the consented user.
    return !!env.GOOGLE_WORKSPACE_SENDER && (serviceAccountConfigured() || oauthConfigured());
  },

  async send(message: EmailMessage): Promise<SendResult> {
    const sender = message.from || gmailDefaultSender();
    if (!sender) {
      throw new Error("Gmail transport not configured - GOOGLE_WORKSPACE_SENDER is not set");
    }

    const token = serviceAccountConfigured()
      ? await serviceAccountToken(
          env.GOOGLE_WORKSPACE_SA_EMAIL as string,
          env.GOOGLE_WORKSPACE_SA_PRIVATE_KEY as string,
          sender,
        )
      : await refreshTokenToken(
          env.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID as string,
          env.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET as string,
          env.GOOGLE_WORKSPACE_OAUTH_REFRESH_TOKEN as string,
        );

    const raw = toBase64Url(
      buildMimeMessage({
        from: sender,
        fromName: env.EMAIL_FROM_NAME ?? env.SENDGRID_FROM_NAME ?? undefined,
        to: message.to,
        subject: message.subject,
        html: message.html,
      }),
    );

    const res = await fetch(GMAIL_SEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "(no response body)");
      throw new Error(`Gmail rejected the message (${res.status}): ${detail.slice(0, 500)}`);
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { id: json.id ?? "(none)", via: "gmail" };
  },
};
