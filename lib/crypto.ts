import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Envelope encryption for credentials at rest (AES-256-GCM). The root key lives in
 * env (`CREDENTIALS_ENCRYPTION_KEY`); each secret is encrypted under a key derived
 * from it. Stored blob = base64(iv[12] | authTag[16] | ciphertext). Tampering fails
 * the GCM auth check on decrypt.
 *
 * The root key may be any string — we scrypt-derive 32 bytes, so hex/base64/passphrase
 * all work. Keep the root key out of the DB; rotating it re-keys all stored secrets.
 */
const SALT = "arbor-lead-tracking:cred:v1";

function rootKey(): Buffer {
  if (!env.CREDENTIALS_ENCRYPTION_KEY) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set — cannot encrypt/decrypt credentials");
  }
  return scryptSync(env.CREDENTIALS_ENCRYPTION_KEY, SALT, 32);
}

export function credentialEncryptionAvailable(): boolean {
  return !!env.CREDENTIALS_ENCRYPTION_KEY;
}

export function encryptSecret(plaintext: string): string {
  const key = rootKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const key = rootKey();
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
