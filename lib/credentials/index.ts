import { env } from "@/lib/env";
import { getSpec, type CredSpec } from "./spec";

export * from "./spec";

/**
 * Credential resolution. **Env is the only source** (decided 2026-08-12).
 *
 * There used to be a database store here — `integration_credentials`, envelope-encrypted
 * under `CREDENTIALS_ENCRYPTION_KEY`, whose values took precedence over env. It was removed
 * because the precedence is the problem: a stored row silently outranks the variable a deploy
 * sets, so the two can disagree with nothing on screen to say which is live. That is exactly
 * how the Railway move went unnoticed for weeks — it carried the rows across but not the key,
 * leaving every stored secret undecryptable while the app quietly ran on env fallbacks.
 *
 * The one credential with a real claim to the database was `google_ads.refresh_token`, because
 * the OAuth callback minted it at runtime and a running app cannot write to env. That flow is
 * gone too: the token is minted by hand and pasted into `GOOGLE_ADS_REFRESH_TOKEN`. It costs a
 * manual re-consent on the rare occasions the token needs replacing, and buys a system with one
 * place to look.
 *
 * Consequences worth knowing before reintroducing a store:
 *   • Nothing here touches the database, so credential resolution cannot fail on a DB blip.
 *     That matters — `/api/twilio/voice` must answer in under 3s, and `/status` + `/sms` fail
 *     CLOSED on an unresolvable auth token, so a stalled query used to mean rejected callbacks.
 *   • The `integration_credentials` table is gone too (migration 0049, 2026-09-05). It sat
 *     empty and unread for three weeks after the store was removed; a table nothing reads is
 *     where the next person puts a value that then silently does nothing.
 */
type Creds = Record<string, string | null>;

function envValues(spec: CredSpec): Creds {
  const e = env as unknown as Record<string, string | undefined>;
  const out: Creds = {};
  for (const f of spec.fields) out[f.key] = (f.envKey ? e[f.envKey] : undefined) ?? null;
  return out;
}

/** Resolve all credentials for a platform from the environment. */
export async function getPlatformCreds(platform: string): Promise<Creds> {
  const spec = getSpec(platform);
  if (!spec) return {};
  return envValues(spec);
}

export async function getCredential(platform: string, key: string): Promise<string | null> {
  return (await getPlatformCreds(platform))[key] ?? null;
}

export interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  /** Which env var supplies this field — shown so an operator knows what to edit in Railway. */
  envKey: string | null;
  last4: string | null;
  /** See CredField.optional — unset is configuration, not a gap. */
  optional: boolean;
}

/**
 * Per-field status for the Settings UI — masked only; plaintext never leaves the server.
 * Reports whether each field is set and which env var backs it, so "not set" is actionable
 * rather than just a red dot.
 */
export async function credentialStatus(platform: string): Promise<FieldStatus[]> {
  const spec = getSpec(platform);
  if (!spec) return [];
  const resolved = envValues(spec);

  return spec.fields.map((f) => {
    const val = resolved[f.key];
    return {
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      set: !!val,
      envKey: f.envKey ?? null,
      last4: val && f.secret ? val.slice(-4) : val && !f.secret ? val : null,
      optional: !!f.optional,
    };
  });
}
