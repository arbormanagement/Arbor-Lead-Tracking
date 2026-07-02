import { createHash } from "node:crypto";

/**
 * SHA-256 hashing for Meta Conversions API user_data. Meta requires normalized,
 * lowercased, whitespace-trimmed values hashed with SHA-256 (hex). Phone must be
 * digits only including country code, no leading + or symbols.
 */
export function hashEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const norm = email.trim().toLowerCase();
  if (!norm) return null;
  return sha256(norm);
}

export function hashPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/[^0-9]/g, ""); // strip +, spaces, dashes → country code + number
  if (!digits) return null;
  return sha256(digits);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
