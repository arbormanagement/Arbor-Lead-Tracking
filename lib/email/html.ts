/**
 * HTML escaping for values that land in an email body. Transport-agnostic, so it
 * lives here rather than in a provider module — it was exported from
 * `lib/email/sendgrid.ts` until the Gmail transport landed, and the callers that
 * import it care about the escaping, not about who sends the mail.
 */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
