import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { integrationCredentials } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { credentialEncryptionAvailable, decryptSecret, encryptSecret } from "@/lib/crypto";
import { getSpec, type CredSpec } from "./spec";

export * from "./spec";

const DEFAULT_TENANT = "default";
const CACHE_TTL_MS = 60_000;

type Creds = Record<string, string | null>;
const cache = new Map<string, { at: number; data: Creds }>();

function envFallback(spec: CredSpec): Creds {
  const e = env as unknown as Record<string, string | undefined>;
  const out: Creds = {};
  for (const f of spec.fields) out[f.key] = (f.envKey ? e[f.envKey] : undefined) ?? null;
  return out;
}

/**
 * Resolve all credentials for a platform: DB-stored (decrypted) values override env
 * fallback. Short-cached to avoid per-call DB hits inside sync loops. The resolver is
 * the single source the integration clients read from.
 */
export async function getPlatformCreds(platform: string, tenantId = DEFAULT_TENANT): Promise<Creds> {
  const spec = getSpec(platform);
  if (!spec) return {};

  const cacheKey = `${tenantId}:${platform}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const data = envFallback(spec);

  if (credentialEncryptionAvailable()) {
    try {
      const rows = await db
        .select({ key: integrationCredentials.key, value: integrationCredentials.valueEncrypted })
        .from(integrationCredentials)
        .where(and(eq(integrationCredentials.tenantId, tenantId), eq(integrationCredentials.platform, platform)));
      for (const r of rows) {
        try {
          data[r.key] = decryptSecret(r.value);
        } catch (err) {
          // Leave the env fallback in place, but never do it silently. A rotated
          // CREDENTIALS_ENCRYPTION_KEY makes EVERY stored secret fail here, and the
          // app then quietly runs on whatever stale value is still in env — an old
          // revoked token, or the wrong account entirely — while Settings keeps
          // showing the credential as set and sourced from the database.
          console.error(
            `[credentials] decrypt failed for ${platform}.${r.key} — falling back to env. ` +
              `If CREDENTIALS_ENCRYPTION_KEY was rotated, re-enter this credential in Settings.`,
            err,
          );
        }
      }
    } catch (err) {
      // DB unreachable → fall back to env values. Critical for the call hot path
      // (Twilio creds), which must never hard-fail on a transient DB blip.
      console.error(`[credentials] DB read failed for ${platform}; using env fallback`, err);
      return data;
    }
  }

  cache.set(cacheKey, { at: Date.now(), data });
  return data;
}

export async function getCredential(platform: string, key: string, tenantId = DEFAULT_TENANT): Promise<string | null> {
  return (await getPlatformCreds(platform, tenantId))[key] ?? null;
}

/**
 * Upsert (or, with an empty value, clear) a credential and bust the cache.
 *
 * `tx` lets a caller saving several fields at once run them as one unit. Saving a
 * credential set field-by-field outside a transaction can half-apply: a failure
 * midway leaves, say, a new client_id stored against the old refresh_token, which
 * authenticates as nothing and is hard to spot because the UI reports every field
 * as "set".
 */
export async function setCredential(
  platform: string,
  key: string,
  value: string,
  tenantId = DEFAULT_TENANT,
  tx: Pick<typeof db, "insert" | "delete"> = db,
): Promise<void> {
  if (!value) {
    await tx
      .delete(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.tenantId, tenantId),
          eq(integrationCredentials.platform, platform),
          eq(integrationCredentials.key, key),
        ),
      );
  } else {
    const valueEncrypted = encryptSecret(value);
    await tx
      .insert(integrationCredentials)
      .values({ tenantId, platform, key, valueEncrypted })
      .onConflictDoUpdate({
        target: [integrationCredentials.tenantId, integrationCredentials.platform, integrationCredentials.key],
        set: { valueEncrypted, updatedAt: new Date() },
      });
  }
  cache.delete(`${tenantId}:${platform}`);
}

export interface FieldStatus {
  key: string;
  label: string;
  secret: boolean;
  set: boolean;
  source: "db" | "env" | null;
  last4: string | null;
}

/**
 * Per-field status for the Settings UI — masked only (plaintext never leaves the
 * server). Tells whether each field is set and whether it came from DB or env.
 */
export async function credentialStatus(platform: string, tenantId = DEFAULT_TENANT): Promise<FieldStatus[]> {
  const spec = getSpec(platform);
  if (!spec) return [];

  const dbKeys = new Set<string>();
  if (credentialEncryptionAvailable()) {
    try {
      const rows = await db
        .select({ key: integrationCredentials.key })
        .from(integrationCredentials)
        .where(and(eq(integrationCredentials.tenantId, tenantId), eq(integrationCredentials.platform, platform)));
      for (const r of rows) dbKeys.add(r.key);
    } catch (err) {
      // Table may not exist yet (DB not migrated to 0001). Don't crash the Settings
      // page render — fall back to env-only status. getPlatformCreds is already guarded.
      console.error(`[credentials] status DB read failed for ${platform}; env-only`, err);
    }
  }
  const resolved = await getPlatformCreds(platform, tenantId);

  return spec.fields.map((f) => {
    const val = resolved[f.key];
    const source: "db" | "env" | null = dbKeys.has(f.key) ? "db" : val ? "env" : null;
    return {
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      set: !!val,
      source,
      last4: val && f.secret ? val.slice(-4) : val && !f.secret ? val : null,
    };
  });
}
