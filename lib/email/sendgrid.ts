/**
 * Outbound email via SendGrid's v3 API over plain fetch — no SDK dependency.
 * Ported from Arbor-Automations `server/email.ts` (the merge's slice 2); this
 * repo previously had no email module, and three ported features need one:
 * review follow-up emails, lead/call-summary notifications to the office, and
 * automation failure alerts.
 *
 * The sending address must be a verified sender (or on a verified domain) in
 * the SendGrid account, or SendGrid rejects with a 403.
 */
import { env } from "@/lib/env";

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

const FAILURE_ALERT_TO = () => env.ALERT_EMAIL_TO || "jhays@arbor-mgmt.com";

function getConfig() {
  if (!env.SENDGRID_API_KEY) {
    throw new Error("Email not configured - SENDGRID_API_KEY is not set");
  }
  if (!env.SENDGRID_FROM_EMAIL) {
    throw new Error("Email not configured - SENDGRID_FROM_EMAIL is not set");
  }
  return {
    apiKey: env.SENDGRID_API_KEY,
    fromEmail: env.SENDGRID_FROM_EMAIL,
    fromName: env.SENDGRID_FROM_NAME,
  };
}

export async function sendEmail(to: string, subject: string, htmlBody: string, from?: string) {
  const { apiKey, fromEmail, fromName } = getConfig();

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: {
      email: from || fromEmail,
      ...(fromName ? { name: fromName } : {}),
    },
    subject,
    content: [{ type: "text/html", value: htmlBody }],
  };

  const response = await fetch(SENDGRID_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "(no response body)");
    throw new Error(`SendGrid rejected the message (${response.status}): ${detail.slice(0, 500)}`);
  }

  // SendGrid returns 202 with an empty body; the id is in a response header.
  const messageId = response.headers.get("x-message-id") ?? "(none)";
  console.log(`[email] sent to ${to}, message id: ${messageId}`);

  return { id: messageId };
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Email an alert when an automation fails in a way a human must know about
 * (a lost lead, a review sequence stuck, an HCP create rejected). Returns
 * whether the alert actually went out — a failed alert is logged, never thrown,
 * because the alert path must not take down the automation it reports on.
 */
export async function sendFailureAlert(
  automation: string,
  summary: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  try {
    const subject = `[Arbor Automation FAILED] ${automation}: ${summary}`.slice(0, 200);
    const rows = Object.entries(details)
      .map(([k, v]) => {
        const value = v == null ? "(none)" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
        return `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;color:#555;font-weight:600;">${escapeHtml(k)}</td><td style="padding:4px 0;vertical-align:top;"><pre style="margin:0;font-family:Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(value)}</pre></td></tr>`;
      })
      .join("");
    const html = `<div style="font-family:Arial,sans-serif;color:#000;font-size:14px;line-height:1.5;">
<p><strong>An automation failed.</strong></p>
<p><strong>Automation:</strong> ${escapeHtml(automation)}<br/>
<strong>Summary:</strong> ${escapeHtml(summary)}<br/>
<strong>Time:</strong> ${new Date().toISOString()}</p>
<table style="border-collapse:collapse;font-size:13px;">${rows}</table>
<p style="color:#888;font-size:12px;margin-top:24px;">Sent automatically by the Arbor automations hub.</p>
</div>`;
    await sendEmail(FAILURE_ALERT_TO(), subject, html);
    console.log(`[failure_alert] sent for ${automation}: ${summary}`);
    return true;
  } catch (err) {
    console.log(`[failure_alert] failed to send for ${automation}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
