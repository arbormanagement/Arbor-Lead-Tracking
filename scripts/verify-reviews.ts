/**
 * Pure-logic checks for the ported review workflow (the merge's slices 3–4):
 * county routing + tag filter (`lib/reviews/county.ts`) and the sequence's
 * step timeline (`nextDueStep` in `lib/reviews/workflow.ts`). No database.
 *
 *   npm run verify:reviews
 */
import { determineCounty, getReviewUrl, shouldSkipReview, MADISON_REVIEW_URL, STCLAIR_REVIEW_URL } from "@/lib/reviews/county";
import { EMAIL_DELAY_MS, FINAL_SMS_DELAY_MS, SMS_DELAY_MS, finalSmsBody, followUpEmailHtml, initialSmsBody, nextDueStep } from "@/lib/reviews/sequence";

let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
}

// ── County routing (ported behavior, verbatim) ──────────────────────────────
check("Edwardsville -> madison", determineCounty("Edwardsville", "62025"), "madison");
check("O'Fallon -> stclair", determineCounty("O'Fallon", "62269"), "stclair");
check("ofallon spelling -> stclair", determineCounty("ofallon", ""), "stclair");
check("Belleville -> stclair", determineCounty("Belleville", ""), "stclair");
check("unknown city, 622xx zip -> stclair", determineCounty("Millstadt", "62260"), "stclair");
check("unknown city, 620xx zip -> madison", determineCounty("Dorsey", "62021"), "madison");
check("nothing known -> madison default", determineCounty("", ""), "madison");
check("madison url", getReviewUrl("madison"), MADISON_REVIEW_URL);
check("stclair url", getReviewUrl("stclair"), STCLAIR_REVIEW_URL);

// ── Tag filter ──────────────────────────────────────────────────────────────
check("HMI tag skips", shouldSkipReview(["HMI"], []), true);
check("case-insensitive", shouldSkipReview([], ["Contractor"]), true);
check("whitespace tolerated", shouldSkipReview(["  PHC Client "], []), true);
check("normal customer passes", shouldSkipReview(["VIP"], ["Priority Job"]), false);
check("empty tags pass", shouldSkipReview([], []), false);

// ── Step timeline ───────────────────────────────────────────────────────────
const t0 = new Date("2026-08-30T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const fresh = { smsSent: false, emailSent: "pending", finalSmsSent: false, customerEmail: "a@b.com", createdAt: t0 };

check("nothing due at t0", nextDueStep(fresh, t0), null);
check("sms1 due at +1min", nextDueStep(fresh, at(SMS_DELAY_MS)), "sms1");
check("sms1 still the step at +23h (email not yet due)", nextDueStep(fresh, at(23 * 3600_000)), "sms1");

const smsDone = { ...fresh, smsSent: true };
check("nothing due between sms1 and email", nextDueStep(smsDone, at(2 * 3600_000)), null);
check("email due at +24h1m", nextDueStep(smsDone, at(EMAIL_DELAY_MS)), "email");
check("no email on file -> email_skip", nextDueStep({ ...smsDone, customerEmail: null }, at(EMAIL_DELAY_MS)), "email_skip");

const emailDone = { ...smsDone, emailSent: "sent" };
check("nothing due between email and final", nextDueStep(emailDone, at(EMAIL_DELAY_MS + 3600_000)), null);
check("final sms due at +3d1m", nextDueStep(emailDone, at(FINAL_SMS_DELAY_MS)), "sms2");
check("skipped email still reaches final sms", nextDueStep({ ...smsDone, emailSent: "skipped" }, at(FINAL_SMS_DELAY_MS)), "sms2");
check("all sent -> nothing due", nextDueStep({ ...emailDone, finalSmsSent: true }, at(FINAL_SMS_DELAY_MS * 2)), null);
// The email step cannot be skipped past: a row whose sms never sent stays on sms1.
check("email never fires before sms1", nextDueStep(fresh, at(FINAL_SMS_DELAY_MS * 2)), "sms1");

// ── Copy (ported verbatim — a wording change here changes what customers get) ──
const url = "https://app.arbor-mgmt.com/track/review?id=x";
check("initial SMS opens with first name", initialSmsBody("Jane Doe", url).startsWith("Hi Jane, this is Justin Hays co-owner at Arbor Management."), true);
check("initial SMS carries the link", initialSmsBody("Jane Doe", url).endsWith(url), true);
check("final SMS opens with first name", finalSmsBody("Jane Doe", url).startsWith("Hey Jane, just following up one last time."), true);
check("email links the tracking url", followUpEmailHtml("Jane Doe", url).includes(`<a href="${url}">`), true);
check("email signs off as Justin", followUpEmailHtml("Jane Doe", url).includes("Justin Hays<br>Arbor Management"), true);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
