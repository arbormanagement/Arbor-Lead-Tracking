/**
 * The review sequence's PURE half — delays, due-step computation, and the
 * customer-facing copy (ported verbatim from Arbor-Automations; a wording
 * change here changes what customers receive). Split from `workflow.ts` so the
 * verify script runs with no database or environment.
 */
import { holidayName, toZoned } from "@/lib/retell/office-hours";

export const SMS_DELAY_MS = 1 * 60 * 1000;
export const EMAIL_DELAY_MS = 24 * 60 * 60 * 1000 + SMS_DELAY_MS;
export const FINAL_SMS_DELAY_MS = EMAIL_DELAY_MS + 2 * 24 * 60 * 60 * 1000;
export const MAX_RETRIES = 3;

export type ReviewStep = "sms1" | "email" | "email_skip" | "sms2" | "sms2_skip";

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
    /** Twilio reported the first text as failed/undelivered — see `sms2_skip`. */
    smsUndeliverable?: boolean;
  },
  now: Date,
): ReviewStep | null {
  const elapsed = now.getTime() - row.createdAt.getTime();

  // Not gated on `smsUndeliverable`: the flag can only be set by a delivery
  // receipt for a message we already sent, so `smsSent` is true by then.
  if (!row.smsSent && elapsed >= SMS_DELAY_MS) return "sms1";

  if (row.smsSent && row.emailSent === "pending" && elapsed >= EMAIL_DELAY_MS) {
    return row.customerEmail ? "email" : "email_skip";
  }

  const emailDone = row.emailSent === "sent" || row.emailSent === "skipped";
  if (emailDone && !row.finalSmsSent && elapsed >= FINAL_SMS_DELAY_MS) {
    // The carrier already told us this number cannot receive our texts. Sending
    // the follow-up anyway buys nothing and bills for it, so the step is
    // recorded as taken rather than performed — the mirror of `email_skip`.
    return row.smsUndeliverable ? "sms2_skip" : "sms2";
  }

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


/**
 * Quiet hours: customer-facing sends are held to weekday business hours in
 * America/Chicago (Justin, 2026-09-03). Nothing in this sequence looked at the
 * clock before — the steps are pure elapsed time from enrollment, so a job
 * marked paid at 7:11 PM texted the customer at 7:12 PM, and a Thursday
 * enrollment put its final SMS on Sunday morning.
 *
 * The window is a HOLD, never a skip: a step that comes due outside it stays
 * due, and the 5-minute cron sends it at the next open minute. Weekends are
 * skipped entirely, so Friday evening through Sunday rolls to Monday 9am.
 *
 * `toZoned` is borrowed from the office-hours module rather than re-derived —
 * one definition of "what time is it in Chicago", already covered by that
 * module's own suite, and correct across DST.
 */
export const SEND_WINDOW_START_HOUR = 9; // 9:00 AM CT, inclusive
export const SEND_WINDOW_END_HOUR = 19; // 7:00 PM CT, exclusive

/**
 * Why the window is shut, or null when it is open. Returned as a phrase rather
 * than a boolean so the held-queue log line says WHICH rule held it — "held
 * outside the send window" over a public holiday reads like a bug to whoever is
 * on the other end of it.
 */
export function sendWindowHold(now: Date): string | null {
  const zoned = toZoned(now);
  if (zoned.weekday === 0 || zoned.weekday === 6) return "weekend";
  // Same closure calendar Chloe answers on, deliberately: a review text at 9am
  // on Thanksgiving is the same intrusion as the office picking up. Reused from
  // the office-hours module — federal observance shifts and the Dec 24-Jan 1
  // block are already settled there and must not be re-derived here.
  const holiday = holidayName(zoned);
  if (holiday) return holiday === "our holiday closure" ? "the holiday closure" : holiday;
  if (zoned.hour < SEND_WINDOW_START_HOUR || zoned.hour >= SEND_WINDOW_END_HOUR) {
    return "outside 9am-7pm CT";
  }
  return null;
}

export function isWithinSendWindow(now: Date): boolean {
  return sendWindowHold(now) === null;
}
