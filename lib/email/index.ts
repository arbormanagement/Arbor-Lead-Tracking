/**
 * The app's one email entry point. Six call sites across the webhooks, the review
 * workflow and the intake pipeline import `sendEmail` / `sendFailureAlert` from
 * here and know nothing about who carries the message.
 *
 * TRANSPORT ORDER (2026-09-14, Justin): Google Workspace first, SendGrid second.
 * Workspace is already paid for, the domain already authorizes it in SPF, and
 * ~95% of this traffic is internal mail to info@ on that same Workspace. SendGrid
 * stays configured behind it as a fallback and continues to carry the newsletter
 * — which is a different SendGrid product (Marketing Campaigns, billed by stored
 * contact) and never passed through this module.
 *
 * `EMAIL_TRANSPORT` pins the primary explicitly ("gmail" | "sendgrid"); unset
 * means "Workspace if it is configured, otherwise SendGrid". A transport that is
 * not configured is skipped rather than attempted, so a half-set credential
 * cannot silently become the thing that fails.
 */
import { env } from "@/lib/env";
import { escapeHtml } from "@/lib/email/html";
import { gmailTransport } from "@/lib/email/gmail";
import { sendgridTransport } from "@/lib/email/sendgrid";
import type { EmailTransport, SendResult } from "@/lib/email/types";

export { escapeHtml };
export type { EmailMessage, EmailTransport, SendResult } from "@/lib/email/types";

const FAILURE_ALERT_TO = () => env.ALERT_EMAIL_TO || "jhays@arbor-mgmt.com";

/**
 * Primary first, then any other configured transport as fallback.
 *
 * Falling back is safe because a transport only resolves after a 2xx: every
 * failure path here is a thrown error from a non-2xx response or a refused
 * connection, i.e. the provider did not accept the message. There is no window
 * where one accepted it and we send again.
 */
function transportChain(): EmailTransport[] {
  const all = [gmailTransport, sendgridTransport].filter((t) => t.configured());
  const pinned = env.EMAIL_TRANSPORT;
  if (!pinned) return all;
  const primary = all.filter((t) => t.name === pinned);
  return [...primary, ...all.filter((t) => t.name !== pinned)];
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  from?: string,
): Promise<SendResult> {
  const chain = transportChain();
  if (chain.length === 0) {
    throw new Error(
      "Email not configured - no transport available (set GOOGLE_WORKSPACE_SENDER plus a Workspace credential, or SENDGRID_API_KEY)",
    );
  }

  let lastError: unknown;
  for (const transport of chain) {
    try {
      const result = await transport.send({ to, subject, html: htmlBody, from });
      console.log(`[email] sent to ${to} via ${result.via}, message id: ${result.id}`);
      return result;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // Named per transport: "email failed" without saying WHICH one is what made
      // the 2026-09-14 outage take a log dive to diagnose.
      console.log(`[email] transport ${transport.name} failed for ${to}: ${message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Email an alert when an automation fails in a way a human must know about
 * (a lost lead, a review sequence stuck, an HCP create rejected). Returns
 * whether the alert actually went out — a failed alert is logged, never thrown,
 * because the alert path must not take down the automation it reports on.
 *
 * ⚠️ STILL SHARES A CHANNEL WITH WHAT IT REPORTS ON. Two transports make a total
 * email outage much less likely, but an alert about email that travels BY email
 * is structurally unable to report the one failure that silences it — on
 * 2026-09-14 all 40+ of these died with the identical error. The real fix is a
 * second channel (a text, or a /api/diagnostics warning); this is not it.
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
