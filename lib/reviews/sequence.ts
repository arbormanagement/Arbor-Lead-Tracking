/**
 * The review sequence's PURE half — delays, due-step computation, and the
 * customer-facing copy (ported verbatim from Arbor-Automations; a wording
 * change here changes what customers receive). Split from `workflow.ts` so the
 * verify script runs with no database or environment.
 */
export const SMS_DELAY_MS = 1 * 60 * 1000;
export const EMAIL_DELAY_MS = 24 * 60 * 60 * 1000 + SMS_DELAY_MS;
export const FINAL_SMS_DELAY_MS = EMAIL_DELAY_MS + 2 * 24 * 60 * 60 * 1000;
export const MAX_RETRIES = 3;

export type ReviewStep = "sms1" | "email" | "email_skip" | "sms2";

/**
 * Which step (if any) is due for a pending row at `now`. Pure so the verify
 * script can walk the timeline without a database or a clock.
 */
export function nextDueStep(
  row: {
    smsSent: boolean;
    emailSent: string;
    finalSmsSent: boolean;
    customerEmail: string | null;
    createdAt: Date;
  },
  now: Date,
): ReviewStep | null {
  const elapsed = now.getTime() - row.createdAt.getTime();

  if (!row.smsSent && elapsed >= SMS_DELAY_MS) return "sms1";

  if (row.smsSent && row.emailSent === "pending" && elapsed >= EMAIL_DELAY_MS) {
    return row.customerEmail ? "email" : "email_skip";
  }

  const emailDone = row.emailSent === "sent" || row.emailSent === "skipped";
  if (emailDone && !row.finalSmsSent && elapsed >= FINAL_SMS_DELAY_MS) return "sms2";

  return null;
}

export function initialSmsBody(customerName: string, trackingUrl: string): string {
  const firstName = customerName.split(" ")[0];
  return `Hi ${firstName}, this is Justin Hays co-owner at Arbor Management. Thanks again for choosing us! Google reviews are the primary way our business grows and because of this we tip our crews for every 5-star review they earn. If you have 30 seconds, please consider helping us and the crew who serviced your property by leaving us a 5 star review. Thanks!\n\n${trackingUrl}`;
}

export function finalSmsBody(customerName: string, trackingUrl: string): string {
  const firstName = customerName.split(" ")[0];
  return `Hey ${firstName}, just following up one last time. If you have a moment, we'd really appreciate a quick Google review. It helps our crews earn tips and keeps our business growing. Thank you!\n\n${trackingUrl}`;
}

export function followUpEmailHtml(customerName: string, trackingUrl: string): string {
  const firstName = customerName.split(" ")[0];
  return `<div style="font-family: Arial, sans-serif; color: #000; font-size: 14px; line-height: 1.5;">
<p>Hi ${firstName},</p>
<p>Just following up from my text the other day. This is Justin Hays, co-owner at Arbor Management. Thanks again for choosing us!</p>
<p>Google reviews are the primary way our business grows, and because of this we tip our crews for every 5-star review they earn. If you have 30 seconds, please consider helping us and the crew who serviced your property by leaving us a 5 star review:</p>
<p><a href="${trackingUrl}">${trackingUrl}</a></p>
<p>Thanks so much,<br>Justin Hays<br>Arbor Management</p>
</div>`;
}

