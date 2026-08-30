/**
 * Shared-secret gate for the ported automation webhooks. The senders (Retell's
 * dashboard-configured inbound webhook, its LLM tool + agent webhook URLs, and
 * HCP's webhook registration) all take a plain URL, so the secret travels as
 * `?secret=` — set once when each URL is repointed at this app.
 *
 * Unset AUTOMATION_WEBHOOK_SECRET = open, which is the old app's posture and
 * what the transition needs (parity checks against a not-yet-configured
 * sender). Once set, a bad or missing secret is refused — this matters most on
 * retell_inbound, whose response describes real customers.
 */
import { env } from "@/lib/env";
import { secretEquals } from "@/lib/secret-compare";

export function webhookAuthorized(req: Request): boolean {
  const secret = env.AUTOMATION_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided =
    new URL(req.url).searchParams.get("secret") ?? req.headers.get("x-webhook-secret") ?? "";
  return secretEquals(provided, secret);
}
