/**
 * SendGrid transport — the app's original sender, now one implementation behind
 * `lib/email/index.ts` rather than the only path.
 *
 * It is kept as a FALLBACK, not deleted, for the reason this refactor exists:
 * on 2026-09-14 SendGrid's Email API trial lapsed and every outbound message
 * 401'd with "Maximum credits exceeded" for seven hours — 30 call summaries,
 * the review queue, the Facebook intake notices, and (because the alert shares
 * the channel it reports on) every failure alert about it. A single transport is
 * a single point of failure; two is a chain.
 *
 * Marketing mail does NOT belong here. The newsletters go out as SendGrid
 * Marketing Campaigns Single Sends, which bill against the marketing plan by
 * stored contact — a separate product on a separate meter, driven from the
 * dashboard, not from this app.
 *
 * The sending address must be a verified sender (or on a verified domain) in the
 * SendGrid account, or SendGrid rejects with a 403.
 */
import { env } from "@/lib/env";
import type { EmailMessage, EmailTransport, SendResult } from "@/lib/email/types";

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

export const sendgridTransport: EmailTransport = {
  name: "sendgrid",

  configured(): boolean {
    return !!(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
  },

  async send(message: EmailMessage): Promise<SendResult> {
    if (!env.SENDGRID_API_KEY) throw new Error("Email not configured - SENDGRID_API_KEY is not set");
    if (!env.SENDGRID_FROM_EMAIL) throw new Error("Email not configured - SENDGRID_FROM_EMAIL is not set");

    const fromName = env.EMAIL_FROM_NAME ?? env.SENDGRID_FROM_NAME;
    const payload = {
      personalizations: [{ to: [{ email: message.to }] }],
      from: {
        email: message.from || env.SENDGRID_FROM_EMAIL,
        ...(fromName ? { name: fromName } : {}),
      },
      subject: message.subject,
      content: [{ type: "text/html", value: message.html }],
    };

    const response = await fetch(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "(no response body)");
      throw new Error(`SendGrid rejected the message (${response.status}): ${detail.slice(0, 500)}`);
    }

    // SendGrid returns 202 with an empty body; the id is in a response header.
    return { id: response.headers.get("x-message-id") ?? "(none)", via: "sendgrid" };
  },
};
