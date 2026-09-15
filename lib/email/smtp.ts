/**
 * Google Workspace SMTP transport — the simplest credential that reaches a
 * Workspace mailbox, and since 2026-09-15 the app's primary sender.
 *
 * WHY THIS EXISTS ALONGSIDE lib/email/gmail.ts. The Gmail API transport is the
 * better-secured option (a service account scoped to gmail.send, no long-lived
 * password), but standing it up needs a GCP key plus domain-wide delegation in
 * the Workspace admin console — two consoles and a scope string that has to
 * match character for character. An app password is three clicks. Justin chose
 * the three clicks (2026-09-15), which is the right call for a single-tenant
 * internal app: the honest cost is that an app password grants FULL SEND RIGHTS
 * on that mailbox and never expires, where the service account can only ever
 * send. If that trade stops being acceptable, gmail.ts is already built and
 * tested — set its variables and this transport steps aside.
 *
 * ⚠️ `smtp.gmail.com` is NOT `smtp-relay.gmail.com`. The relay is the one that
 * authorizes senders by IP (unusable here — Railway egress is not static) and
 * needs admin configuration. Plain authenticated SMTP needs neither. An earlier
 * reading of this conflated them and wrote SMTP off entirely; it was wrong.
 *
 * nodemailer rather than this repo's usual "plain fetch, no SDK" style, on
 * purpose: that convention is about not pulling an SDK in front of a simple REST
 * call. SMTP is not REST — it is a stateful protocol with STARTTLS, AUTH and
 * dot-stuffing, and hand-rolling it would be ~150 lines of exactly the code
 * nobody should write twice.
 *
 * Limits worth knowing: Workspace allows ~2,000 recipients/day (this app sends
 * ~35), and the message goes out as the AUTHENTICATED mailbox — a different
 * `from` only works if Workspace has it as a verified "send mail as" alias.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env } from "@/lib/env";
import type { EmailMessage, EmailTransport, SendResult } from "@/lib/email/types";

let cached: Transporter | null = null;

/**
 * Google shows app passwords as four space-separated groups. People paste them
 * either way, and SMTP AUTH rejects the spaced form — so strip whitespace rather
 * than leave a 535 that looks like a wrong password.
 */
function normalizeAppPassword(value: string): string {
  return value.replace(/\s+/g, "");
}

function transporter(): Transporter {
  if (cached) return cached;
  const options: SMTPTransport.Options = {
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: env.GOOGLE_WORKSPACE_SMTP_USER as string,
      pass: normalizeAppPassword(env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD as string),
    },
    // Left unpooled (nodemailer's default): the app sends a handful of messages a
    // minute at most, so a held-open socket buys nothing and Gmail drops idle ones.
  };
  cached = nodemailer.createTransport(options);
  return cached;
}

export const smtpTransport: EmailTransport = {
  name: "smtp",

  configured(): boolean {
    return !!(env.GOOGLE_WORKSPACE_SMTP_USER && env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD);
  },

  async send(message: EmailMessage): Promise<SendResult> {
    if (!this.configured()) {
      throw new Error(
        "SMTP transport not configured - set GOOGLE_WORKSPACE_SMTP_USER and GOOGLE_WORKSPACE_SMTP_APP_PASSWORD",
      );
    }

    const fromAddress = message.from || env.GOOGLE_WORKSPACE_SENDER || (env.GOOGLE_WORKSPACE_SMTP_USER as string);
    const fromName = env.EMAIL_FROM_NAME ?? env.SENDGRID_FROM_NAME;

    // nodemailer builds and encodes the MIME itself, so the header-injection
    // guard in lib/email/mime.ts is not in this path — it rejects CR/LF in
    // addresses and encodes the subject. Nothing here concatenates raw headers.
    const info = await transporter().sendMail({
      from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });

    return { id: info.messageId ?? "(none)", via: "smtp" };
  },
};
